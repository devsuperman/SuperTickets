using Microsoft.Extensions.Options;
using RabbitMQ.Client;

namespace SuperTickets.Shared.Messaging;

/// <summary>
/// One shared RabbitMQ connection (auto-recovering) plus the broker topology: a topic exchange, one quorum
/// queue per consumer bound by <c>eventType</c> routing key, and one DLQ per queue. Declarations are idempotent,
/// so every process that publishes or consumes calls <see cref="EnsureTopologyAsync"/> before it starts.
/// </summary>
public sealed class RabbitMq(IOptions<MessagingOptions> options) : IAsyncDisposable
{
    private readonly SemaphoreSlim _lock = new(1, 1);
    private IConnection? _connection;
    private bool _topologyDeclared;

    public MessagingOptions Options => options.Value;

    public async Task<IChannel> CreateChannelAsync(bool publisherConfirms = false, CancellationToken ct = default)
    {
        var connection = await ConnectionAsync(ct);
        return publisherConfirms
            ? await connection.CreateChannelAsync(
                new CreateChannelOptions(publisherConfirmationsEnabled: true, publisherConfirmationTrackingEnabled: true),
                ct)
            : await connection.CreateChannelAsync(cancellationToken: ct);
    }

    public async Task EnsureTopologyAsync(CancellationToken ct = default)
    {
        if (_topologyDeclared) return;
        await using var channel = await CreateChannelAsync(ct: ct);
        var o = Options;
        await channel.ExchangeDeclareAsync(o.Exchange, ExchangeType.Topic, durable: true, cancellationToken: ct);
        await DeclareConsumerQueueAsync(channel, o.PaymentQueue, o.PaymentDlq, "OrderCreated", ct);
        await DeclareConsumerQueueAsync(channel, o.NotificationQueue, o.NotificationDlq, "PaymentSucceeded", ct);
        _topologyDeclared = true;
    }

    private async Task DeclareConsumerQueueAsync(IChannel channel, string queue, string dlq, string routingKey, CancellationToken ct)
    {
        var quorum = new Dictionary<string, object?> { ["x-queue-type"] = "quorum" };
        await channel.QueueDeclareAsync(dlq, durable: true, exclusive: false, autoDelete: false, arguments: quorum, cancellationToken: ct);

        // x-delivery-limit counts returns: a message is dead-lettered after MaxDeliveries deliveries in total.
        var main = new Dictionary<string, object?>
        {
            ["x-queue-type"] = "quorum",
            ["x-delivery-limit"] = Math.Max(Options.MaxDeliveries - 1, 0),
            ["x-dead-letter-exchange"] = "", // default exchange: routes to the queue named by the routing key
            ["x-dead-letter-routing-key"] = dlq,
        };
        await channel.QueueDeclareAsync(queue, durable: true, exclusive: false, autoDelete: false, arguments: main, cancellationToken: ct);
        await channel.QueueBindAsync(queue, Options.Exchange, routingKey, cancellationToken: ct);
    }

    private async Task<IConnection> ConnectionAsync(CancellationToken ct)
    {
        if (_connection is { IsOpen: true }) return _connection;
        await _lock.WaitAsync(ct);
        try
        {
            if (_connection is { IsOpen: true }) return _connection;
            var factory = new ConnectionFactory { Uri = new Uri(Options.ConnectionString) };
            _connection = await factory.CreateConnectionAsync(ct);
            return _connection;
        }
        finally
        {
            _lock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_connection is not null) await _connection.DisposeAsync();
        _lock.Dispose();
    }
}
