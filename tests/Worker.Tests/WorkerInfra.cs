using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Order.Data;
using SuperTickets.Shared.Messaging;
using SuperTickets.Shared.Messaging.Contracts;
using RabbitMQ.Client;
using Testcontainers.PostgreSql;
using Testcontainers.RabbitMq;
using Worker;
using Worker.Features.ProcessPayment;
using Worker.Features.SendNotification;

namespace Worker.Tests;

/// <summary>Real Postgres + RabbitMQ via Testcontainers.</summary>
public sealed class WorkerInfra : IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:16-alpine").Build();
    private readonly RabbitMqContainer _mq = new RabbitMqBuilder("rabbitmq:4-alpine").Build();

    public async Task InitializeAsync()
    {
        await Task.WhenAll(_pg.StartAsync(), _mq.StartAsync());
        await using var db = CreateDb();
        await db.Database.MigrateAsync(); // the Worker never migrates; Order.Api does
    }

    public OrderDbContext CreateDb() =>
        new(new DbContextOptionsBuilder<OrderDbContext>().UseNpgsql(_pg.GetConnectionString()).Options);

    public Task DisposeAsync() => Task.WhenAll(_pg.DisposeAsync().AsTask(), _mq.DisposeAsync().AsTask());

    public async Task<Harness> CreateHarnessAsync(double failureRate = 0, double notificationErrorRate = 0)
    {
        var id = Guid.NewGuid().ToString("N")[..8];
        var h = new Harness(this);
        var messaging = new MessagingOptions
        {
            Exchange = $"events-{id}",
            PaymentQueue = $"payment-{id}-queue",
            NotificationQueue = $"notification-{id}-queue",
        };
        h.PaymentQueue = messaging.PaymentQueue;
        h.NotificationQueue = messaging.NotificationQueue;
        h.PaymentDlq = messaging.PaymentDlq;
        h.NotificationDlq = messaging.NotificationDlq;

        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Orders"] = _pg.GetConnectionString(),
            ["Services:InventoryUrl"] = "http://inventory.test",
            ["Messaging:ConnectionString"] = _mq.GetConnectionString(),
            ["Messaging:Exchange"] = messaging.Exchange,
            ["Messaging:PaymentQueue"] = messaging.PaymentQueue,
            ["Messaging:NotificationQueue"] = messaging.NotificationQueue,
            ["Payment:FailureRate"] = failureRate.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Demo:NotificationErrorRate"] = notificationErrorRate.ToString(System.Globalization.CultureInfo.InvariantCulture),
        }).Build();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddWorker(config);
        services.AddHttpClient<Worker.Common.InventoryClient>().ConfigurePrimaryHttpMessageHandler(() => h.Inventory);
        h.Services = services.BuildServiceProvider();

        var hosted = h.Services.GetServices<IHostedService>().ToList();
        h.Payment = hosted.OfType<PaymentConsumer>().Single();
        h.Notification = hosted.OfType<NotificationConsumer>().Single();
        h.Rabbit = h.Services.GetRequiredService<RabbitMq>();
        await h.Rabbit.EnsureTopologyAsync(); // queues must exist before tests publish to them
        return h;
    }
}

public sealed class StubInventory : HttpMessageHandler
{
    public HttpStatusCode Status { get; set; } = HttpStatusCode.NoContent;
    public List<string> Calls { get; } = [];
    public List<string> Succeeded { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var call = $"{request.Method} {request.RequestUri!.AbsolutePath}";
        lock (Calls)
        {
            Calls.Add(call);
            if (Status < (HttpStatusCode)400) Succeeded.Add(call);
        }
        return Task.FromResult(new HttpResponseMessage(Status));
    }

    public int Releases(Guid orderId) =>
        Succeeded.Count(c => c == $"DELETE /inventory/reservations/{orderId}");
}

public sealed class Harness(WorkerInfra infra)
{
    public string PaymentQueue = "", NotificationQueue = "", PaymentDlq = "", NotificationDlq = "";
    public StubInventory Inventory { get; } = new();
    public IServiceProvider Services { get; set; } = null!;
    public RabbitMq Rabbit { get; set; } = null!;
    public PaymentConsumer Payment { get; set; } = null!;
    public NotificationConsumer Notification { get; set; } = null!;
    public OrderDbContext Db() => infra.CreateDb();

    public async Task<Guid> SeedOrderAsync(string status = OrderStatus.Pending, int quantity = 2)
    {
        await using var db = Db();
        var id = Guid.NewGuid();
        db.Orders.Add(new OrderEntity
        {
            Id = id, EventId = Guid.NewGuid(), Quantity = quantity, CustomerEmail = "a@b.com", Status = status,
            CancelReason = status == OrderStatus.Cancelled ? CancelReason.Expired : null,
            IdempotencyKey = id.ToString(), CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync();
        return id;
    }

    /// <summary>Publishes straight to a queue through the default exchange.</summary>
    public async Task SendAsync(string queue, object body)
    {
        await using var channel = await Rabbit.CreateChannelAsync(publisherConfirms: true);
        await channel.BasicPublishAsync("", queue, mandatory: false,
            basicProperties: new BasicProperties { DeliveryMode = DeliveryModes.Persistent },
            body: JsonSerializer.SerializeToUtf8Bytes(body, MessageJson.Options));
    }

    public Task SendOrderCreatedAsync(OrderEntity o) =>
        SendAsync(PaymentQueue, new OrderCreated(o.Id, o.EventId, o.Quantity, o.CustomerEmail, o.CreatedAt));

    public async Task<OrderEntity> GetOrderAsync(Guid id)
    {
        await using var db = Db();
        return await db.Orders.AsNoTracking().SingleAsync(o => o.Id == id);
    }

    /// <summary>Polls until <paramref name="handled"/> messages succeeded (or time runs out).</summary>
    public static async Task PumpAsync<T>(QueueConsumer<T> consumer, int handled)
    {
        var done = 0;
        for (var i = 0; i < 20 && done < handled; i++)
        {
            done += await consumer.ReceiveOnceAsync();
            if (done < handled) await Task.Delay(100);
        }

        Assert.Equal(handled, done);
    }

    public async Task<int> CountAsync(string queue)
    {
        await using var channel = await Rabbit.CreateChannelAsync();
        return (int)(await channel.QueueDeclarePassiveAsync(queue)).MessageCount;
    }
}
