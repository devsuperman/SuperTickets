using Amazon.CDK;
using Amazon.CDK.AWS.SNS;
using Amazon.CDK.AWS.SNS.Subscriptions;
using Amazon.CDK.AWS.SQS;
using Constructs;

namespace SuperTickets.Cdk;

/// <summary>Topic, queues, DLQs and filtered raw-delivery subscriptions (contracts.md#messages).</summary>
public class MessagingStack : Stack
{
    public ITopic Topic { get; }
    public IQueue PaymentQueue { get; }
    public IQueue NotificationQueue { get; }
    public IQueue PaymentDlq { get; }
    public IQueue NotificationDlq { get; }

    public MessagingStack(Construct scope, string id, IStackProps? props = null) : base(scope, id, props)
    {
        Topic = new Topic(this, "Topic", new TopicProps { TopicName = "supertickets-events" });

        (PaymentQueue, PaymentDlq) = Consumer("payment", "OrderCreated");
        (NotificationQueue, NotificationDlq) = Consumer("notification", "PaymentSucceeded");

        _ = new CfnOutput(this, "PaymentDlqUrl", new CfnOutputProps { Value = PaymentDlq.QueueUrl });
        _ = new CfnOutput(this, "NotificationDlqUrl", new CfnOutputProps { Value = NotificationDlq.QueueUrl });
    }

    private (Queue Queue, Queue Dlq) Consumer(string name, string eventType)
    {
        var dlq = new Queue(this, $"{name}-dlq", new QueueProps
        {
            QueueName = $"{name}-dlq",
            RetentionPeriod = Duration.Days(14),
        });
        var queue = new Queue(this, $"{name}-queue", new QueueProps
        {
            QueueName = $"{name}-queue",
            VisibilityTimeout = Duration.Seconds(30),
            ReceiveMessageWaitTime = Duration.Seconds(20),
            DeadLetterQueue = new DeadLetterQueue { Queue = dlq, MaxReceiveCount = 5 },
        });
        Topic.AddSubscription(new SqsSubscription(queue, new SqsSubscriptionProps
        {
            RawMessageDelivery = true,
            FilterPolicy = new Dictionary<string, SubscriptionFilter>
            {
                ["eventType"] = SubscriptionFilter.StringFilter(new StringConditions { Allowlist = [eventType] }),
            },
        }));
        return (queue, dlq);
    }
}
