using System.Text.Json;
using Amazon.SQS;
using Amazon.SQS.Model;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace SuperTickets.Shared.Messaging;

/// <summary>
/// Long-polls one queue. For each message: sets the ambient correlation ID from the
/// <c>correlationId</c> attribute, deserializes the body, calls <see cref="HandleAsync"/>, and deletes
/// the message only on success. A throwing handler leaves the message for redelivery (then the DLQ).
/// </summary>
public abstract class SqsConsumer<TMessage>(IAmazonSQS sqs, string queueUrl, ILogger logger) : BackgroundService
{
    public int WaitTimeSeconds { get; set; } = 20;
    public int MaxMessages { get; set; } = 10;

    protected abstract Task HandleAsync(TMessage message, CancellationToken ct);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ReceiveOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Receiving from {QueueUrl} failed", queueUrl);
                try { await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken); }
                catch (OperationCanceledException) { }
            }
        }
    }

    /// <summary>One long poll; returns the number of messages handled successfully.</summary>
    public async Task<int> ReceiveOnceAsync(CancellationToken ct = default)
    {
        var response = await sqs.ReceiveMessageAsync(new ReceiveMessageRequest
        {
            QueueUrl = queueUrl,
            MaxNumberOfMessages = MaxMessages,
            WaitTimeSeconds = WaitTimeSeconds,
            MessageAttributeNames = ["All"],
        }, ct);

        var ok = 0;
        foreach (var message in response.Messages ?? [])
        {
            if (await ProcessAsync(message, ct)) ok++;
        }

        return ok;
    }

    private async Task<bool> ProcessAsync(Message message, CancellationToken ct)
    {
        string? correlationId = null;
        if (message.MessageAttributes is not null && message.MessageAttributes.TryGetValue("correlationId", out var a))
        {
            correlationId = a.StringValue;
        }

        CorrelationContext.Current = correlationId ?? Guid.NewGuid().ToString();
        using var scope = logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = CorrelationContext.Current });
        try
        {
            var payload = JsonSerializer.Deserialize<TMessage>(message.Body, MessageJson.Options)
                ?? throw new JsonException("Empty message body");
            await HandleAsync(payload, ct);
            await sqs.DeleteMessageAsync(queueUrl, message.ReceiptHandle, ct);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Handling {MessageId} failed; leaving it on the queue", message.MessageId);
            return false;
        }
        finally
        {
            CorrelationContext.Current = null;
        }
    }
}
