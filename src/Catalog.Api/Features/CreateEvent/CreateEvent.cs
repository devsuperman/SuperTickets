using Catalog.Api.Common;

namespace Catalog.Api.Features.CreateEvent;

public static class CreateEvent
{
    public static void Map(IEndpointRouteBuilder app) =>
        app.MapPost("/admin/events", Handle).AddEndpointFilter<AdminKeyFilter>();

    static async Task<IResult> Handle(EventInput input, CatalogDb db, InventoryClient inventory, EventCache cache, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var errors = EventValidator.Validate(input, now);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var id = Guid.NewGuid();
        switch (await inventory.SetCapacity(id, input.TotalTickets!.Value, ct))
        {
            case CapacityResult.BelowSold: return Problems.CapacityBelowSold();
            case CapacityResult.Unavailable: return Problems.DependencyUnavailable();
        }

        var e = new EventEntity
        {
            Id = id,
            Name = input.Name!.Trim(),
            Venue = input.Venue!.Trim(),
            StartsAt = EventValidator.ToUtc(input.StartsAt!.Value),
            TotalTickets = input.TotalTickets.Value,
            Price = input.Price!.Value,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Events.Add(e);
        await db.SaveChangesAsync(ct);
        await cache.Invalidate(id);
        return Results.Created($"/events/{id}", e.ToDto());
    }
}
