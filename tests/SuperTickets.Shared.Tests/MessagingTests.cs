using System.Text.Json;
using Amazon.SQS;
using Amazon.SQS.Model;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Order.Data;
using SuperTickets.Shared.Messaging;
using SuperTickets.Shared.Messaging.Contracts;

namespace SuperTickets.Shared.Tests;

public sealed class MessagingTests(MessagingInfra infra) : IClassFixture<MessagingInfra>
{
    private OutboxPublisher<OrderDbContext> CreatePublisher()
    {
        var services = new ServiceCollection();
        services.AddScoped(_ => infra.CreateDb());
        return new OutboxPublisher<OrderDbContext>(
            services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(),
            infra.Sns,
            Options.Create(new MessagingOptions { TopicArn = infra.TopicArn }),
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

    private sealed class TestConsumer(IAmazonSQS sqs, string url, Func<OrderCreated, Task> handler)
        : SqsConsumer<OrderCreated>(sqs, url, NullLogger.Instance)
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
        var url = await infra.CreateQueueAsync("q-attrs", "OrderCreated");
        var row = await AddOrderCreatedAsync("corr-123");

        Assert.True(await CreatePublisher().PublishPendingAsync() >= 1);

        var msg = await ReceiveOneAsync(url);
        Assert.Equal("OrderCreated", msg.MessageAttributes["eventType"].StringValue);
        Assert.Equal("corr-123", msg.MessageAttributes["correlationId"].StringValue);
        Assert.Equal(row.Id.ToString(), msg.MessageAttributes["messageId"].StringValue);
        using var doc = JsonDocument.Parse(msg.Body);
        Assert.Equal(2, doc.RootElement.GetProperty("quantity").GetInt32());
        Assert.Equal("a@b.com", doc.RootElement.GetProperty("customerEmail").GetString());

        await using var db = infra.CreateDb();
        Assert.NotNull((await db.Outbox.SingleAsync(x => x.Id == row.Id)).PublishedAt);
    }

    [Fact]
    public async Task Filter_keeps_other_event_types_out_of_the_queue()
    {
        var url = await infra.CreateQueueAsync("q-filter", "PaymentSucceeded");
        await AddOrderCreatedAsync("c");
        await CreatePublisher().PublishPendingAsync();

        var r = await infra.Sqs.ReceiveMessageAsync(new ReceiveMessageRequest { QueueUrl = url, WaitTimeSeconds = 2 });
        Assert.Empty(r.Messages ?? []);
    }

    [Fact]
    public async Task Failed_handler_leaves_message_and_success_deletes_it()
    {
        var url = await infra.CreateQueueAsync("q-consumer", "OrderCreated");
        await AddOrderCreatedAsync("corr-xyz");
        await CreatePublisher().PublishPendingAsync();

        var failing = new TestConsumer(infra.Sqs, url, _ => throw new InvalidOperationException("boom")) { WaitTimeSeconds = 5 };
        Assert.Equal(0, await failing.ReceiveOnceAsync());
        Assert.Equal("corr-xyz", failing.SeenCorrelationId);

        // visibility timeout is 1 s: the message comes back, still not deleted
        await Task.Delay(1500);
        var ok = new TestConsumer(infra.Sqs, url, _ => Task.CompletedTask) { WaitTimeSeconds = 5 };
        Assert.Equal(1, await ok.ReceiveOnceAsync());

        await Task.Delay(1500);
        var again = await infra.Sqs.ReceiveMessageAsync(new ReceiveMessageRequest { QueueUrl = url, WaitTimeSeconds = 1 });
        Assert.Empty(again.Messages ?? []);
    }

    private async Task<Message> ReceiveOneAsync(string url)
    {
        for (var i = 0; i < 5; i++)
        {
            var r = await infra.Sqs.ReceiveMessageAsync(new ReceiveMessageRequest
            {
                QueueUrl = url, WaitTimeSeconds = 3, MessageAttributeNames = ["All"],
            });
            if (r.Messages is { Count: > 0 }) return r.Messages[0];
        }

        throw new Xunit.Sdk.XunitException("No message received");
    }
}
