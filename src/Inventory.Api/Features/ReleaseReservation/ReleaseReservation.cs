using Npgsql;

namespace Inventory.Api.Features.ReleaseReservation;

public static class ReleaseReservation
{
    public static void Map(IEndpointRouteBuilder app) =>
        app.MapDelete("/inventory/reservations/{orderId:guid}", Handle);

    private static async Task<IResult> Handle(Guid orderId, NpgsqlDataSource db, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        await using var release = new NpgsqlCommand("""
            WITH r AS (
                UPDATE reservations SET status = 'released', released_at = now()
                WHERE order_id = @order AND status = 'active'
                RETURNING event_id, quantity
            )
            UPDATE stock SET available = available + r.quantity FROM r WHERE stock.event_id = r.event_id
            """, conn, tx);
        release.Parameters.AddWithValue("order", orderId);
        await release.ExecuteNonQueryAsync(ct);

        await tx.CommitAsync(ct);
        return Results.NoContent();
    }
}
