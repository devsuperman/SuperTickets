using Inventory.Api.Common;
using Microsoft.Extensions.Options;
using Npgsql;

namespace Inventory.Api.Features.ReserveStock;

public record ReserveRequest(Guid OrderId, Guid EventId, int Quantity);

public record ReservationDto(Guid OrderId, Guid EventId, int Quantity, string Status);

public static class ReserveStock
{
    public static void Map(IEndpointRouteBuilder app) =>
        app.MapPost("/inventory/reservations", Handle);

    private static async Task<IResult> Handle(
        ReserveRequest request, NpgsqlDataSource db, IOptions<DemoOptions> demo, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        if (request.OrderId == Guid.Empty) errors["orderId"] = ["orderId is required."];
        if (request.EventId == Guid.Empty) errors["eventId"] = ["eventId is required."];
        if (request.Quantity is < 1 or > 10) errors["quantity"] = ["quantity must be between 1 and 10."];
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        // Demo toggles (reserve only): simulate a slow or failing Inventory.
        if (demo.Value.DelayMs > 0) await Task.Delay(demo.Value.DelayMs, ct);
        if (demo.Value.ErrorRate > 0 && Random.Shared.NextDouble() < demo.Value.ErrorRate)
            return Results.Problem(statusCode: 500, title: "Simulated inventory error");

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        int inserted;
        await using (var insert = new NpgsqlCommand("""
            INSERT INTO reservations (order_id, event_id, quantity, status)
            SELECT @order, @event, @qty, 'active'
            WHERE EXISTS (SELECT 1 FROM stock WHERE event_id = @event)
            ON CONFLICT (order_id) DO NOTHING
            """, conn, tx))
        {
            insert.Parameters.AddWithValue("order", request.OrderId);
            insert.Parameters.AddWithValue("event", request.EventId);
            insert.Parameters.AddWithValue("qty", request.Quantity);
            inserted = await insert.ExecuteNonQueryAsync(ct);
        }

        if (inserted == 0)
        {
            // Either a replay (existing reservation) or an unknown event.
            await using var existing = new NpgsqlCommand(
                "SELECT event_id, quantity, status FROM reservations WHERE order_id = @order", conn, tx);
            existing.Parameters.AddWithValue("order", request.OrderId);
            await using var reader = await existing.ExecuteReaderAsync(ct);
            if (await reader.ReadAsync(ct))
                return Results.Ok(new ReservationDto(request.OrderId, reader.GetGuid(0), reader.GetInt32(1), reader.GetString(2)));
            return Results.Problem(statusCode: 404, title: "Event not found");
        }

        int updated;
        await using (var take = new NpgsqlCommand(
            "UPDATE stock SET available = available - @qty WHERE event_id = @event AND available >= @qty", conn, tx))
        {
            take.Parameters.AddWithValue("qty", request.Quantity);
            take.Parameters.AddWithValue("event", request.EventId);
            updated = await take.ExecuteNonQueryAsync(ct);
        }

        if (updated == 0)
        {
            await tx.RollbackAsync(ct);
            return Results.Problem(statusCode: 409, title: "Not enough tickets available", type: "sold_out");
        }

        await tx.CommitAsync(ct);
        return Results.Created($"/inventory/reservations/{request.OrderId}",
            new ReservationDto(request.OrderId, request.EventId, request.Quantity, "active"));
    }
}
