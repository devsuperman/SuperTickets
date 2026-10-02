namespace Worker.Common;

public sealed class PaymentOptions
{
    public double FailureRate { get; set; } = 0.1;
}

public sealed class DemoOptions
{
    public double NotificationErrorRate { get; set; }
}
