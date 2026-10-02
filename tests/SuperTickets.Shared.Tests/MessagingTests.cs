using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Order.Data;
using SuperTickets.Shared.Messaging;
using SuperTickets.Shared.Messaging.Contracts;

namespace SuperTickets.Shared.Tests;

public sealed class MessagingTests(MessagingInfra infra) : IClassFixture<MessagingInfra>
{
    private OutboxPublisher<OrderDbContext> CreatePublisher(RabbitMq rabbit)
    {
        var services = new ServiceCollection();
        services.AddScoped(_ => infra.CreateDb());
        return new OutboxPublisher<OrderDbContext>(
            services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(),
            rabbit,
            NullLogger<OutboxPublisher<OrderDbContext>>.Instance);
    }

    private async Task<OutboxMessage> AddOrderCreatedAsync(string correlationId)
    {
        CorrelationContext.Current = correlationId;
        await using var db = infra.CreateDb();
        var row = db.AddToOutbox(new OrderCreated(Guid.NewGuid(), Guid.NewGuid(), 2, "a@b.com", DateTimeOffset.UtcNow));
        await db.SaveChangesAsync();
        CorrelationContext.Current = null;
        return row;
    }

    private sealed class TestConsumer(RabbitMq rabbit, string queue, Func<OrderCreated, Task> handler)
        : QueueConsumer<OrderCreated>(rabbit, queue, NullLogger.Instance)
    {
        public string? SeenCorrelationId { get; private set; }

        protected override Task HandleAsync(OrderCreated message, CancellationToken ct)
        {
            SeenCorrelationId = CorrelationContext.Current;
            return handler(message);
        }
    }

    [Fact]
    public async Task Outbox_row_reaches_queue_with_attributes_and_is_marked_published()
    {
        await using var rabbit = infra.CreateBroker();
        var row = await AddOrderCreatedAsync("corr-123");

        Assert.True(await CreatePublisher(rabbit).PublishPendingAsync() >= 1);

        var msg = await MessagingInfra.GetAsync(rabbit, rabbit.Options.PaymentQueue);
        Assert.NotNull(msg);
        Assert.Equal("OrderCreated", Encoding.UTF8.GetString((byte[])msg.BasicProperties.Headers!["eventType"]!));
        Assert.Equal("corr-123", msg.BasicProperties.CorrelationId);
        Assert.Equal(row.Id.ToString(), msg.BasicProperties.MessageId);
        using var doc = JsonDocument.Parse(msg.Body);
        Assert.Equal(2, doc.RootElement.GetProperty("quantity").GetInt32());
        Assert.Equal("a@b.com", doc.RootElement.GetProperty("customerEmail").GetString());

        await using var db = infra.CreateDb();
        Assert.NotNull((await db.Outbox.SingleAsync(x => x.Id == row.Id)).PublishedAt);
    }

    [Fact]
    public async Task Routing_keeps_other_event_types_out_of_the_queue()
    {
        await using var rabbit = infra.CreateBroker();
        await AddOrderCreatedAsync("c");
        await CreatePublisher(rabbit).PublishPendingAsync();

        // OrderCreated is bound to the payment queue only.
        Assert.NotNull(await MessagingInfra.GetAsync(rabbit, rabbit.Options.PaymentQueue));
        Assert.Null(await MessagingInfra.GetAsync(rabbit, rabbit.Options.NotificationQueue, timeoutMs: 1000));
    }

    [Fact]
    public async Task Failed_handler_leaves_message_and_success_acks_it()
    {
        await using var rabbit = infra.CreateBroker();
        var queue = rabbit.Options.PaymentQueue;
        await AddOrderCreatedAsync("corr-xyz");
        await CreatePublisher(rabbit).PublishPendingAsync();

        var failing = new TestConsumer(rabbit, queue, _ => throw new InvalidOperationException("boom"));
        Assert.Equal(0, await failing.ReceiveOnceAsync());
        Assert.Equal("corr-xyz", failing.SeenCorrelationId);

        // the failed message was requeued, not lost
        var ok = new TestConsumer(rabbit, queue, _ => Task.CompletedTask);
        Assert.Equal(1, await ok.ReceiveOnceAsync());

        Assert.Equal(0, await ok.ReceiveOnceAsync());
        Assert.Null(await MessagingInfra.GetAsync(rabbit, queue, timeoutMs: 500));
    }
}
