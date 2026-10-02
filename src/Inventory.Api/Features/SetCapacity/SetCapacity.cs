using Npgsql;

namespace Inventory.Api.Features.SetCapacity;

public record SetCapacityRequest(int TotalTickets);

public record CapacityDto(Guid EventId, int TotalTickets, int Available);

public static class SetCapacity
{
    public static void Map(IEndpointRouteBuilder app) =>
        app.MapPut("/inventory/events/{eventId:guid}", Handle);

    private static async Task<IResult> Handle(Guid eventId, SetCapacityRequest request, NpgsqlDataSource db, CancellationToken ct)
    {
        if (request.TotalTickets is < 1 or > 100_000)
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                ["totalTickets"] = ["totalTickets must be between 1 and 100000."]
            });

        // Upsert: create the row, or adjust an existing one unless the cut goes below what is reserved.
        await using var cmd = db.CreateCommand("""
            WITH ins AS (
                INSERT INTO stock (event_id, total_tickets, available) VALUES (@id, @new, @new)
                ON CONFLICT (event_id) DO NOTHING
                RETURNING total_tickets, available
            ), upd AS (
                UPDATE stock SET available = available + (@new - total_tickets), total_tickets = @new
                WHERE event_id = @id AND NOT EXISTS (SELECT 1 FROM ins) AND @new >= total_tickets - available
                RETURNING total_tickets, available
            )
            SELECT total_tickets, available FROM ins UNION ALL SELECT total_tickets, available FROM upd
            """);
        cmd.Parameters.AddWithValue("id", eventId);
        cmd.Parameters.AddWithValue("new", request.TotalTickets);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (await reader.ReadAsync(ct))
            return Results.Ok(new CapacityDto(eventId, reader.GetInt32(0), reader.GetInt32(1)));

        return Results.Problem(
            statusCode: 409,
            title: "Capacity below reserved tickets",
            type: "capacity_below_sold");
    }
}
