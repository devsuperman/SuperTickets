namespace Order.Data;

public static class OrderStatus
{
    public const string Pending = "pending";
    public const string Paid = "paid";
    public const string Cancelled = "cancelled";
}

public static class CancelReason
{
    public const string SoldOut = "sold_out";
    public const string PaymentFailed = "payment_failed";
    public const string Expired = "expired";
}

public static class TicketStatus
{
    public const string Valid = "valid";
    public const string Used = "used";
    public const string Cancelled = "cancelled";
}

public sealed class OrderEntity
{
    public Guid Id { get; set; }
    public Guid EventId { get; set; }
    public int Quantity { get; set; }
    public string CustomerEmail { get; set; } = "";
    public string Status { get; set; } = OrderStatus.Pending;
    public string? CancelReason { get; set; }
    public string IdempotencyKey { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public List<TicketEntity> Tickets { get; set; } = [];
}

public sealed class PaymentEntity
{
    public Guid OrderId { get; set; }
    public bool Succeeded { get; set; }
    public DateTimeOffset ProcessedAt { get; set; }
}

public sealed class TicketEntity
{
    public Guid Id { get; set; }
    public Guid OrderId { get; set; }
    public int Number { get; set; }
    public Guid EventId { get; set; }
    public string CustomerEmail { get; set; } = "";
    public string Status { get; set; } = TicketStatus.Valid;
    public DateTimeOffset CreatedAt { get; set; }
}
