using Microsoft.EntityFrameworkCore;
using Order.Api.Common;
using Order.Data;

namespace Order.Api.Features.GetOrder;

public static class GetOrder
{
    public static void Map(IEndpointRouteBuilder app) => app.MapGet("/orders/{id:guid}", Handle);

    static async Task<IResult> Handle(Guid id, OrderDbContext db, CancellationToken ct)
    {
        var order = await db.Orders.AsNoTracking().Include(o => o.Tickets).FirstOrDefaultAsync(o => o.Id == id, ct);
        return order is null ? Results.Problem(statusCode: 404, title: "Order not found.") : Results.Ok(OrderDto.From(order));
    }
}
