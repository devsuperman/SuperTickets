namespace SuperTickets.Shared.Messaging;

/// <summary>Bound from the <c>Messaging</c> configuration section. Names default to the contract in docs/project/contracts.md.</summary>
public sealed class MessagingOptions
{
    public const string Section = "Messaging";

    public string ConnectionString { get; set; } = "amqp://guest:guest@localhost:5672";
    public string Exchange { get; set; } = "supertickets-events";
    public string PaymentQueue { get; set; } = "payment-queue";
    public string NotificationQueue { get; set; } = "notification-queue";
    public int MaxDeliveries { get; set; } = 5;

    public string PaymentDlq => DlqName(PaymentQueue);
    public string NotificationDlq => DlqName(NotificationQueue);

    private static string DlqName(string queue) =>
        queue.EndsWith("-queue", StringComparison.Ordinal) ? queue[..^"-queue".Length] + "-dlq" : queue + "-dlq";
}
