using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace SuperTickets.Shared;

/// <summary>Ambient correlation ID for the current request or message.</summary>
public static class CorrelationContext
{
    public const string HeaderName = "X-Correlation-Id";

    private static readonly AsyncLocal<string?> Value = new();

    public static string? Current
    {
        get => Value.Value;
        set => Value.Value = value;
    }
}

public sealed class CorrelationIdMiddleware(RequestDelegate next, ILogger<CorrelationIdMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var id = context.Request.Headers[CorrelationContext.HeaderName].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(id) || id.Length > 100)
        {
            id = Guid.NewGuid().ToString();
        }

        CorrelationContext.Current = id;
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[CorrelationContext.HeaderName] = id;
            return Task.CompletedTask;
        });

        using (logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = id }))
        {
            await next(context);
        }
    }
}

/// <summary>Forwards the ambient correlation ID on outgoing HTTP calls.</summary>
public sealed class CorrelationIdHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (CorrelationContext.Current is { } id && !request.Headers.Contains(CorrelationContext.HeaderName))
        {
            request.Headers.Add(CorrelationContext.HeaderName, id);
        }

        return base.SendAsync(request, cancellationToken);
    }
}
