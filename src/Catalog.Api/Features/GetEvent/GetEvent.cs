using Catalog.Api.Common;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Features.GetEvent;

public static class GetEvent
{
    public static void Map(IEndpointRouteBuilder app) => app.MapGet("/events/{id:guid}", Handle);

    static async Task<IResult> Handle(Guid id, HttpContext ctx, CatalogDb db, EventCache cache)
    {
        if (await cache.GetEvent(id) is { } hit)
        {
            ctx.Response.Headers["X-Cache"] = "HIT";
            return Results.Ok(hit);
        }

        ctx.Response.Headers["X-Cache"] = "MISS";
        var e = await db.Events.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
        if (e is null) return Results.Problem(statusCode: 404, title: "Event not found");

        var dto = e.ToDto();
        await cache.SetEvent(dto);
        return Results.Ok(dto);
    }
}
