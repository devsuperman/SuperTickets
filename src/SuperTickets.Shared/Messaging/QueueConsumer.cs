using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;

namespace SuperTickets.Shared.Messaging;

/// <summary>
/// Polls one queue. For each message: sets the ambient correlation ID from the message's <c>CorrelationId</c>,
/// deserializes the body, calls <see cref="HandleAsync"/>, and acks only on success. A throwing handler nacks with
/// requeue, so the broker redelivers and finally dead-letters it (quorum <c>x-delivery-limit</c>).
/// </summary>
public abstract class QueueConsumer<TMessage>(RabbitMq rabbit, string queue, ILogger logger) : BackgroundService
{
    public TimeSpan IdleDelay { get; set; } = TimeSpan.FromMilliseconds(250);
    public int MaxMessages { get; set; } = 10;

    private IChannel? _channel;

    protected abstract Task HandleAsync(TMessage message, CancellationToken ct);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var handled = 0;
            try
            {
                handled = await ReceiveOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Receiving from {Queue} failed", queue);
                try { await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken); }
                catch (OperationCanceledException) { }
            }

            if (handled == 0)
            {
                try { await Task.Delay(IdleDelay, stoppingToken); }
                catch (OperationCanceledException) { }
            }
        }
    }

    /// <summary>
    /// Fetches up to <see cref="MaxMessages"/> messages; returns the number handled successfully.
    /// Stops at the first failure so a failing message is not redelivered within the same poll.
    /// </summary>
    public async Task<int> ReceiveOnceAsync(CancellationToken ct = default)
    {
        await rabbit.EnsureTopologyAsync(ct);
        if (_channel is not { IsOpen: true })
        {
            _channel = await rabbit.CreateChannelAsync(ct: ct);
        }

        var ok = 0;
        for (var i = 0; i < MaxMessages; i++)
        {
            var result = await _channel.BasicGetAsync(queue, autoAck: false, ct);
            if (result is null) break;
            if (!await ProcessAsync(_channel, result, ct)) break;
            ok++;
        }

        return ok;
    }

    private async Task<bool> ProcessAsync(IChannel channel, BasicGetResult message, CancellationToken ct)
    {
        CorrelationContext.Current = message.BasicProperties.CorrelationId ?? Guid.NewGuid().ToString();
        using var scope = logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = CorrelationContext.Current });
        try
        {
            var payload = JsonSerializer.Deserialize<TMessage>(message.Body.Span, MessageJson.Options)
                ?? throw new JsonException("Empty message body");
            await HandleAsync(payload, ct);
            await channel.BasicAckAsync(message.DeliveryTag, multiple: false, ct);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Handling {MessageId} failed; requeueing it", message.BasicProperties.MessageId);
            await channel.BasicNackAsync(message.DeliveryTag, multiple: false, requeue: true, ct);
            return false;
        }
        finally
        {
            CorrelationContext.Current = null;
        }
    }
}
