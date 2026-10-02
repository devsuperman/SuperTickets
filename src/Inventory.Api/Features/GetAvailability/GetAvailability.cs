using Npgsql;

namespace Inventory.Api.Features.GetAvailability;

public record AvailabilityDto(Guid EventId, int Available);

public static class GetAvailability
{
    public static void Map(IEndpointRouteBuilder app) =>
        app.MapGet("/events/{id:guid}/availability", Handle);

    private static async Task<IResult> Handle(Guid id, NpgsqlDataSource db, CancellationToken ct)
    {
        await using var cmd = db.CreateCommand("SELECT available FROM stock WHERE event_id = @id");
        cmd.Parameters.AddWithValue("id", id);
        return await cmd.ExecuteScalarAsync(ct) is int available
            ? Results.Ok(new AvailabilityDto(id, available))
            : Results.Problem(statusCode: 404, title: "Event not found");
    }
}
