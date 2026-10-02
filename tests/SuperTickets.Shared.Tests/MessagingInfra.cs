using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Order.Data;
using RabbitMQ.Client;
using SuperTickets.Shared.Messaging;
using Testcontainers.PostgreSql;
using Testcontainers.RabbitMq;

namespace SuperTickets.Shared.Tests;

/// <summary>Real Postgres + RabbitMQ via Testcontainers, shared by the messaging tests.</summary>
public sealed class MessagingInfra : IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:16-alpine").Build();
    private readonly RabbitMqContainer _mq = new RabbitMqBuilder("rabbitmq:4-alpine").Build();

    public async Task InitializeAsync()
    {
        await Task.WhenAll(_pg.StartAsync(), _mq.StartAsync());
        await using var db = CreateDb();
        await db.Database.MigrateAsync();
    }

    /// <summary>A broker handle with its own exchange and queues, so tests don't see each other's messages.</summary>
    public RabbitMq CreateBroker()
    {
        var id = Guid.NewGuid().ToString("N")[..8];
        return new RabbitMq(Options.Create(new MessagingOptions
        {
            ConnectionString = _mq.GetConnectionString(),
            Exchange = $"events-{id}",
            PaymentQueue = $"payment-{id}-queue",
            NotificationQueue = $"notification-{id}-queue",
        }));
    }

    /// <summary>Polls a queue until a message arrives (auto-acked) or the timeout passes.</summary>
    public static async Task<BasicGetResult?> GetAsync(RabbitMq rabbit, string queue, int timeoutMs = 5000)
    {
        await using var channel = await rabbit.CreateChannelAsync();
        for (var waited = 0; waited <= timeoutMs; waited += 100)
        {
            var result = await channel.BasicGetAsync(queue, autoAck: true);
            if (result is not null) return result;
            await Task.Delay(100);
        }

        return null;
    }

    public OrderDbContext CreateDb() =>
        new(new DbContextOptionsBuilder<OrderDbContext>().UseNpgsql(_pg.GetConnectionString()).Options);

    public async Task DisposeAsync()
    {
        await _pg.DisposeAsync();
        await _mq.DisposeAsync();
    }
}
