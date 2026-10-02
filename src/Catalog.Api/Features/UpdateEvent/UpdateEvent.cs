using Catalog.Api.Common;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Features.UpdateEvent;

public static class UpdateEvent
{
    public static void Map(IEndpointRouteBuilder app) =>
        app.MapPut("/admin/events/{id:guid}", Handle).AddEndpointFilter<AdminKeyFilter>();

    static async Task<IResult> Handle(Guid id, EventInput input, CatalogDb db, InventoryClient inventory, EventCache cache, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var errors = EventValidator.Validate(input, now);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var e = await db.Events.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (e is null) return Results.Problem(statusCode: 404, title: "Event not found");
        if (e.StartsAt <= now) return Problems.Business(409, "event_started", "The event has already started.");

        switch (await inventory.SetCapacity(id, input.TotalTickets!.Value, ct))
        {
            case CapacityResult.BelowSold: return Problems.CapacityBelowSold();
            case CapacityResult.Unavailable: return Problems.DependencyUnavailable();
        }

        e.Name = input.Name!.Trim();
        e.Venue = input.Venue!.Trim();
        e.StartsAt = EventValidator.ToUtc(input.StartsAt!.Value);
        e.TotalTickets = input.TotalTickets.Value;
        e.Price = input.Price!.Value;
        e.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        await cache.Invalidate(id);
        return Results.Ok(e.ToDto());
    }
}
