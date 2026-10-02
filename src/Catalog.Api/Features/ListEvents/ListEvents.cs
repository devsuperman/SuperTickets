using Catalog.Api.Common;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Features.ListEvents;

public static class ListEvents
{
    public static void Map(IEndpointRouteBuilder app) => app.MapGet("/events", Handle);

    static async Task<IResult> Handle(string? search, HttpContext ctx, CatalogDb db, EventCache cache)
    {
        search = search?.Trim() ?? "";
        if (search.Length > 100)
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["search"] = ["Search must be at most 100 characters."] });

        if (await cache.GetList(search) is { } hit)
        {
            ctx.Response.Headers["X-Cache"] = "HIT";
            return Results.Ok(hit);
        }

        var now = DateTime.UtcNow;
        var q = db.Events.AsNoTracking().Where(e => e.StartsAt > now);
        if (search.Length > 0)
        {
            var pattern = $"%{search.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_")}%";
            q = q.Where(e => EF.Functions.ILike(e.Name, pattern) || EF.Functions.ILike(e.Venue, pattern));
        }
        var events = (await q.OrderBy(e => e.StartsAt).Take(100).ToListAsync()).Select(e => e.ToDto()).ToArray();

        await cache.SetList(search, events);
        ctx.Response.Headers["X-Cache"] = "MISS";
        return Results.Ok(events);
    }
}
