using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;

namespace Inventory.Api.Common;

public class PostgresHealthCheck(NpgsqlDataSource db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        await using var cmd = db.CreateCommand("SELECT 1");
        await cmd.ExecuteScalarAsync(ct);
        return HealthCheckResult.Healthy();
    }
}
