namespace SuperTickets.Shared.Messaging;

/// <summary>Bound from the <c>Messaging</c> configuration section.</summary>
public sealed class MessagingOptions
{
    public const string Section = "Messaging";

    public string TopicArn { get; set; } = "";
    public string PaymentQueueUrl { get; set; } = "";
    public string NotificationQueueUrl { get; set; } = "";
}
