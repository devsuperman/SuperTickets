using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using StackExchange.Redis;

namespace Catalog.Api.Common;

/// <summary>Postgres is required.</summary>
public sealed class PostgresCheck(IServiceScopeFactory scopes) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var ok = await scope.ServiceProvider.GetRequiredService<CatalogDb>().Database.CanConnectAsync(ct);
        return ok ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy("Postgres unreachable");
    }
}

/// <summary>Redis is optional: reported as degraded, never unhealthy.</summary>
public sealed class RedisCheck(IConnectionMultiplexer redis) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        try
        {
            await redis.GetDatabase().PingAsync();
            return HealthCheckResult.Healthy();
        }
        catch (Exception ex) { return HealthCheckResult.Degraded("Redis unreachable", ex); }
    }
}
