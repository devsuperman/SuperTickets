using Order.Data;

namespace Order.Api.Common;

public record TicketDto(Guid Id, int Number, string Status);

public record OrderDto(Guid Id, Guid EventId, int Quantity, string CustomerEmail, string Status,
    string? CancelReason, DateTimeOffset CreatedAt, List<TicketDto> Tickets)
{
    public static OrderDto From(OrderEntity o) => new(o.Id, o.EventId, o.Quantity, o.CustomerEmail, o.Status,
        o.CancelReason, o.CreatedAt,
        [.. o.Tickets.OrderBy(t => t.Number).Select(t => new TicketDto(t.Id, t.Number, t.Status))]);
}
