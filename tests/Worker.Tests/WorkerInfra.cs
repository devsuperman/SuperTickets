using System.Net;
using System.Text.Json;
using Amazon.Runtime;
using Amazon.SQS;
using Amazon.SQS.Model;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Order.Data;
using SuperTickets.Shared.Messaging;
using SuperTickets.Shared.Messaging.Contracts;
using Testcontainers.LocalStack;
using Testcontainers.PostgreSql;
using Worker;
using Worker.Features.ProcessPayment;
using Worker.Features.SendNotification;

namespace Worker.Tests;

/// <summary>Real Postgres + LocalStack SQS via Testcontainers.</summary>
public sealed class WorkerInfra : IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:16-alpine").Build();
    private readonly LocalStackContainer _ls = new LocalStackBuilder("localstack/localstack:3.8").Build();

    public IAmazonSQS Sqs { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await Task.WhenAll(_pg.StartAsync(), _ls.StartAsync());
        Sqs = new AmazonSQSClient(new BasicAWSCredentials("test", "test"),
            new AmazonSQSConfig { ServiceURL = _ls.GetConnectionString(), AuthenticationRegion = "us-east-1" });
        await using var db = CreateDb();
        await db.Database.MigrateAsync(); // the Worker never migrates; Order.Api does
    }

    public OrderDbContext CreateDb() =>
        new(new DbContextOptionsBuilder<OrderDbContext>().UseNpgsql(_pg.GetConnectionString()).Options);

    public Task DisposeAsync() => Task.WhenAll(_pg.DisposeAsync().AsTask(), _ls.DisposeAsync().AsTask());

    public async Task<Harness> CreateHarnessAsync(double failureRate = 0, double notificationErrorRate = 0)
    {
        var id = Guid.NewGuid().ToString("N")[..8];
        var h = new Harness(this);
        h.PaymentDlq = await CreateQueueAsync($"payment-dlq-{id}");
        h.NotificationDlq = await CreateQueueAsync($"notification-dlq-{id}");
        h.PaymentQueue = await CreateQueueAsync($"payment-{id}", h.PaymentDlq);
        h.NotificationQueue = await CreateQueueAsync($"notification-{id}", h.NotificationDlq);

        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:Orders"] = _pg.GetConnectionString(),
            ["Services:InventoryUrl"] = "http://inventory.test",
            ["Messaging:PaymentQueueUrl"] = h.PaymentQueue,
            ["Messaging:NotificationQueueUrl"] = h.NotificationQueue,
            ["Payment:FailureRate"] = failureRate.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Demo:NotificationErrorRate"] = notificationErrorRate.ToString(System.Globalization.CultureInfo.InvariantCulture),
        }).Build();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddWorker(config);
        services.AddSingleton(Sqs); // replace the env-configured client
        services.AddHttpClient<Worker.Common.InventoryClient>().ConfigurePrimaryHttpMessageHandler(() => h.Inventory);
        h.Services = services.BuildServiceProvider();

        var hosted = h.Services.GetServices<IHostedService>().ToList();
        h.Payment = hosted.OfType<PaymentConsumer>().Single();
        h.Notification = hosted.OfType<NotificationConsumer>().Single();
        h.Payment.WaitTimeSeconds = h.Notification.WaitTimeSeconds = 1;
        return h;
    }

    /// <summary>Visibility 1 s; with a DLQ, <c>maxReceiveCount</c> 5 (mirrors init-aws.sh).</summary>
    private async Task<string> CreateQueueAsync(string name, string? dlqUrl = null)
    {
        var attrs = new Dictionary<string, string> { ["VisibilityTimeout"] = "1" };
        if (dlqUrl is not null)
        {
            var arn = (await Sqs.GetQueueAttributesAsync(dlqUrl, ["QueueArn"])).Attributes["QueueArn"];
            attrs["RedrivePolicy"] = $$"""{"deadLetterTargetArn":"{{arn}}","maxReceiveCount":"5"}""";
        }

        return (await Sqs.CreateQueueAsync(new CreateQueueRequest { QueueName = name, Attributes = attrs })).QueueUrl;
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

    public Task SendAsync(string queueUrl, object body) =>
        infra.Sqs.SendMessageAsync(queueUrl, JsonSerializer.Serialize(body, MessageJson.Options));

    public Task SendOrderCreatedAsync(OrderEntity o) =>
        SendAsync(PaymentQueue, new OrderCreated(o.Id, o.EventId, o.Quantity, o.CustomerEmail, o.CreatedAt));

    public async Task<OrderEntity> GetOrderAsync(Guid id)
    {
        await using var db = Db();
        return await db.Orders.AsNoTracking().SingleAsync(o => o.Id == id);
    }

    /// <summary>Polls until <paramref name="handled"/> messages succeeded (or time runs out).</summary>
    public static async Task PumpAsync<T>(SqsConsumer<T> consumer, int handled)
    {
        var done = 0;
        for (var i = 0; i < 20 && done < handled; i++) done += await consumer.ReceiveOnceAsync();
        Assert.Equal(handled, done);
    }

    public async Task<int> CountAsync(string queueUrl) =>
        (await infra.Sqs.ReceiveMessageAsync(new ReceiveMessageRequest { QueueUrl = queueUrl, MaxNumberOfMessages = 10, WaitTimeSeconds = 1 })).Messages?.Count ?? 0;
}
