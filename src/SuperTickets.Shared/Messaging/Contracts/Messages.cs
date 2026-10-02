namespace SuperTickets.Shared.Messaging.Contracts;

/// <summary>Event published to the topic. The type name is the <c>eventType</c> attribute.</summary>
public interface IMessage;

public sealed record OrderCreated(Guid OrderId, Guid EventId, int Quantity, string CustomerEmail, DateTimeOffset CreatedAt) : IMessage;

public sealed record PaymentSucceeded(Guid OrderId, Guid EventId, int Quantity, string CustomerEmail, DateTimeOffset PaidAt) : IMessage;

public sealed record PaymentFailed(Guid OrderId, Guid EventId, int Quantity, string Reason, DateTimeOffset FailedAt) : IMessage;
