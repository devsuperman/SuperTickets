using Microsoft.Extensions.Diagnostics.HealthChecks;
using Order.Data;

namespace Order.Api.Common;

public sealed class PostgresCheck(IServiceScopeFactory scopes) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var ok = await scope.ServiceProvider.GetRequiredService<OrderDbContext>().Database.CanConnectAsync(ct);
        return ok ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy("Postgres unreachable");
    }
}
