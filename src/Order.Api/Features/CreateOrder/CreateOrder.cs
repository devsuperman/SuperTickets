using System.ComponentModel.DataAnnotations;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Order.Api.Common;
using Order.Data;
using SuperTickets.Shared.Messaging;
using SuperTickets.Shared.Messaging.Contracts;

namespace Order.Api.Features.CreateOrder;

public record CreateOrderRequest(Guid EventId, int Quantity, string? CustomerEmail);

public static class CreateOrder
{
    public static void Map(IEndpointRouteBuilder app) => app.MapPost("/orders", Handle);

    static async Task<IResult> Handle(CreateOrderRequest? body, HttpRequest http, OrderDbContext db,
        InventoryClient inventory, CancellationToken ct)
    {
        var key = http.Headers["Idempotency-Key"].FirstOrDefault();
        var errors = Validate(key, body);
        if (errors.Count > 0) return Results.ValidationProblem(errors);
        var req = body!;
        var email = req.CustomerEmail!.Trim();

        // 1-2. Find the order for this key, or insert a pending one (a unique race returns the winner).
        var order = await db.Orders.Include(o => o.Tickets).FirstOrDefaultAsync(o => o.IdempotencyKey == key, ct);
        if (order is null)
        {
            var now = DateTimeOffset.UtcNow;
            order = new OrderEntity
            {
                Id = Guid.NewGuid(), EventId = req.EventId, Quantity = req.Quantity, CustomerEmail = email,
                Status = OrderStatus.Pending, IdempotencyKey = key!, CreatedAt = now, UpdatedAt = now,
            };
            db.Orders.Add(order);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                db.ChangeTracker.Clear();
                order = await db.Orders.Include(o => o.Tickets).FirstAsync(o => o.IdempotencyKey == key, ct);
            }
        }

        if (order.Status != OrderStatus.Pending || await HasOrderCreated(db, order.Id, ct))
            return Accepted(order);

        // 3. Reserve (timeout, retry, breaker). Replays resume here; reserve is idempotent by orderId.
        switch (await inventory.Reserve(order.Id, order.EventId, order.Quantity, ct))
        {
            case ReserveResult.Reserved:
                // 4. Outbox row and the pending check commit together.
                await using (var tx = await db.Database.BeginTransactionAsync(ct))
                {
                    var touched = await db.Orders.Where(o => o.Id == order.Id && o.Status == OrderStatus.Pending)
                        .ExecuteUpdateAsync(s => s.SetProperty(o => o.UpdatedAt, DateTimeOffset.UtcNow), ct);
                    if (touched == 1 && !await HasOrderCreated(db, order.Id, ct))
                    {
                        db.AddToOutbox(new OrderCreated(order.Id, order.EventId, order.Quantity, order.CustomerEmail, order.CreatedAt));
                        await db.SaveChangesAsync(ct);
                    }
                    await tx.CommitAsync(ct);
                }
                return await Reload(db, order.Id, ct);

            case ReserveResult.SoldOut:
                // 5.
                await db.Orders.Where(o => o.Id == order.Id && o.Status == OrderStatus.Pending)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(o => o.Status, OrderStatus.Cancelled)
                        .SetProperty(o => o.CancelReason, CancelReason.SoldOut)
                        .SetProperty(o => o.UpdatedAt, DateTimeOffset.UtcNow), ct);
                return Problems.SoldOut();

            case ReserveResult.EventNotFound:
                await db.Orders.Where(o => o.Id == order.Id && o.Status == OrderStatus.Pending).ExecuteDeleteAsync(ct);
                return Results.Problem(statusCode: 404, title: "Event not found.");

            default:
                // 6. Stays pending: same-key retry resumes, otherwise the sweeper cleans up.
                return Problems.DependencyUnavailable();
        }
    }

    static IResult Accepted(OrderEntity o) => Results.Accepted($"/orders/{o.Id}", OrderDto.From(o));

    static async Task<IResult> Reload(OrderDbContext db, Guid id, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        return Accepted(await db.Orders.Include(o => o.Tickets).FirstAsync(o => o.Id == id, ct));
    }

    static Task<bool> HasOrderCreated(OrderDbContext db, Guid orderId, CancellationToken ct) =>
        db.Outbox.FromSqlInterpolated($"SELECT * FROM outbox WHERE type = 'OrderCreated' AND payload->>'orderId' = {orderId.ToString()}")
            .AnyAsync(ct);

    static Dictionary<string, string[]> Validate(string? key, CreateOrderRequest? body)
    {
        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrEmpty(key) || key.Length > 100)
            errors["idempotencyKey"] = ["Idempotency-Key header is required (1-100 chars)."];
        if (body is null)
        {
            errors["body"] = ["Request body is required."];
            return errors;
        }
        if (body.EventId == Guid.Empty) errors["eventId"] = ["eventId is required."];
        if (body.Quantity is < 1 or > 10) errors["quantity"] = ["quantity must be between 1 and 10."];
        var email = body.CustomerEmail?.Trim();
        if (string.IsNullOrEmpty(email) || email.Length > 254 || !new EmailAddressAttribute().IsValid(email))
            errors["customerEmail"] = ["customerEmail must be a valid email (max 254 chars)."];
        return errors;
    }
}
