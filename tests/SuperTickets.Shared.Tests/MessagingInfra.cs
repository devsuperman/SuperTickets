using Amazon;
using Amazon.Runtime;
using Amazon.SimpleNotificationService;
using Amazon.SimpleNotificationService.Model;
using Amazon.SQS;
using Amazon.SQS.Model;
using Microsoft.EntityFrameworkCore;
using Order.Data;
using Testcontainers.LocalStack;
using Testcontainers.PostgreSql;

namespace SuperTickets.Shared.Tests;

/// <summary>Real Postgres + LocalStack (SNS/SQS) via Testcontainers, shared by the messaging tests.</summary>
public sealed class MessagingInfra : IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:16-alpine").Build();
    private readonly LocalStackContainer _ls = new LocalStackBuilder("localstack/localstack:3.8").Build();

    public IAmazonSimpleNotificationService Sns { get; private set; } = null!;
    public IAmazonSQS Sqs { get; private set; } = null!;
    public string TopicArn { get; private set; } = "";
    public string PaymentQueueUrl { get; private set; } = "";

    public async Task InitializeAsync()
    {
        await Task.WhenAll(_pg.StartAsync(), _ls.StartAsync());
        var creds = new BasicAWSCredentials("test", "test");
        var endpoint = _ls.GetConnectionString();
        Sns = new AmazonSimpleNotificationServiceClient(creds, new AmazonSimpleNotificationServiceConfig { ServiceURL = endpoint, AuthenticationRegion = "us-east-1" });
        Sqs = new AmazonSQSClient(creds, new AmazonSQSConfig { ServiceURL = endpoint, AuthenticationRegion = "us-east-1" });

        TopicArn = (await Sns.CreateTopicAsync("supertickets-events")).TopicArn;
        PaymentQueueUrl = await CreateQueueAsync("payment-queue", "OrderCreated");

        await using var db = CreateDb();
        await db.Database.MigrateAsync();
    }

    /// <summary>Queue with visibility 1 s, subscribed raw with an eventType filter (mirrors init-aws.sh).</summary>
    public async Task<string> CreateQueueAsync(string name, string eventType)
    {
        var url = (await Sqs.CreateQueueAsync(new CreateQueueRequest
        {
            QueueName = name,
            Attributes = new() { ["VisibilityTimeout"] = "1" },
        })).QueueUrl;
        var arn = (await Sqs.GetQueueAttributesAsync(url, ["QueueArn"])).Attributes["QueueArn"];
        await Sns.SubscribeAsync(new SubscribeRequest
        {
            TopicArn = TopicArn,
            Protocol = "sqs",
            Endpoint = arn,
            Attributes = new()
            {
                ["RawMessageDelivery"] = "true",
                ["FilterPolicy"] = $$"""{"eventType":["{{eventType}}"]}""",
            },
        });
        return url;
    }

    public OrderDbContext CreateDb() =>
        new(new DbContextOptionsBuilder<OrderDbContext>().UseNpgsql(_pg.GetConnectionString()).Options);

    public async Task DisposeAsync()
    {
        await _pg.DisposeAsync();
        await _ls.DisposeAsync();
    }
}
