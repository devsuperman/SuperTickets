namespace Catalog.Api.Common;

public class AdminKeyFilter(IConfiguration config) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var expected = config["Admin:ApiKey"];
        var given = ctx.HttpContext.Request.Headers["X-Api-Key"].ToString();
        if (string.IsNullOrEmpty(expected) || given != expected)
            return Results.Problem(statusCode: 401, title: "Unauthorized");
        return await next(ctx);
    }
}
