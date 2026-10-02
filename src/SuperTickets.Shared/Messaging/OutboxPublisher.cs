using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using RabbitMQ.Client;

namespace SuperTickets.Shared.Messaging;

/// <summary>
/// Publishes unpublished outbox rows to the RabbitMQ exchange (routing key = event type; <c>FOR UPDATE SKIP LOCKED</c>), then sets <c>published_at</c>.
/// At-least-once: a crash after publish and before commit republishes the row.
/// Register with <c>AddHostedService&lt;OutboxPublisher&lt;MyDbContext&gt;&gt;()</c>.
/// </summary>
public sealed class OutboxPublisher<TDbContext>(
    IServiceScopeFactory scopes,
    RabbitMq rabbit,
    ILogger<OutboxPublisher<TDbContext>> logger) : BackgroundService
    where TDbContext : DbContext
{
    public const int BatchSize = 50;
    public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(1);

    private IChannel? _channel;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var published = 0;
            try
            {
                published = await PublishPendingAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Outbox publish failed; will retry");
            }

            if (published < BatchSize)
            {
                try { await Task.Delay(PollInterval, stoppingToken); }
                catch (OperationCanceledException) { }
            }
        }
    }

    /// <summary>Publishes one batch; returns the number of rows published.</summary>
    public async Task<int> PublishPendingAsync(CancellationToken ct = default)
    {
        await rabbit.EnsureTopologyAsync(ct);
        if (_channel is not { IsOpen: true })
        {
            _channel = await rabbit.CreateChannelAsync(publisherConfirms: true, ct: ct);
        }

        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        var rows = await db.Set<OutboxMessage>()
            .FromSqlRaw($"SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT {BatchSize} FOR UPDATE SKIP LOCKED")
            .ToListAsync(ct);

        var count = 0;
        foreach (var row in rows)
        {
            var props = new BasicProperties
            {
                DeliveryMode = DeliveryModes.Persistent,
                ContentType = "application/json",
                MessageId = row.Id.ToString(),
                CorrelationId = row.CorrelationId,
                Headers = new Dictionary<string, object?> { ["eventType"] = row.Type },
            };

            try
            {
                await _channel.BasicPublishAsync(
                    rabbit.Options.Exchange, row.Type, mandatory: false, basicProperties: props,
                    body: Encoding.UTF8.GetBytes(row.Payload), cancellationToken: ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Publishing outbox row {MessageId} failed", row.Id);
                break; // keep order; commit what was sent so far
            }

            row.PublishedAt = DateTimeOffset.UtcNow;
            count++;
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return count;
    }
}
