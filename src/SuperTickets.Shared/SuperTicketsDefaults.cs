using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace SuperTickets.Shared;

public static class SuperTicketsDefaults
{
    /// <summary>Correlation ID handler on every HttpClient, Problem Details, health checks.</summary>
    public static IServiceCollection AddSuperTicketsDefaults(this IServiceCollection services)
    {
        services.AddTransient<CorrelationIdHandler>();
        services.ConfigureHttpClientDefaults(b => b.AddHttpMessageHandler<CorrelationIdHandler>());
        services.AddProblemDetails();
        services.AddHealthChecks();
        return services;
    }

    /// <summary>Correlation ID middleware, Problem Details for errors, <c>GET /health</c>.</summary>
    public static WebApplication UseSuperTicketsDefaults(this WebApplication app)
    {
        app.UseMiddleware<CorrelationIdMiddleware>();
        app.UseExceptionHandler();
        app.UseStatusCodePages();
        app.MapHealthChecks("/health");
        return app;
    }
}
