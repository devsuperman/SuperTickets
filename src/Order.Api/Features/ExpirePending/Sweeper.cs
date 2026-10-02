using Microsoft.EntityFrameworkCore;
using Order.Api.Common;
using Order.Data;

namespace Order.Api.Features.ExpirePending;

/// <summary>Cancels (reason expired) pending orders older than the timeout, after releasing their stock.</summary>
public sealed class Sweeper(IServiceScopeFactory scopes, IConfiguration config, ILogger<Sweeper> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(config.GetValue("Orders:SweepIntervalSeconds", 30));
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(interval, stoppingToken); }
            catch (OperationCanceledException) { break; }
            try { await SweepOnce(stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Sweep failed; will retry");
            }
        }
    }

    /// <summary>One pass; returns the number of orders expired.</summary>
    public async Task<int> SweepOnce(CancellationToken ct = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<OrderDbContext>();
        var inventory = scope.ServiceProvider.GetRequiredService<InventoryClient>();
        var cutoff = DateTimeOffset.UtcNow - TimeSpan.FromMinutes(config.GetValue("Orders:PendingTimeoutMinutes", 5));

        var ids = await db.Orders.Where(o => o.Status == OrderStatus.Pending && o.CreatedAt < cutoff)
            .OrderBy(o => o.CreatedAt).Select(o => o.Id).Take(100).ToListAsync(ct);

        var expired = 0;
        foreach (var id in ids)
        {
            // A failed release leaves the order pending for the next pass.
            if (!await inventory.Release(id, ct)) continue;
            expired += await db.Orders.Where(o => o.Id == id && o.Status == OrderStatus.Pending)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(o => o.Status, OrderStatus.Cancelled)
                    .SetProperty(o => o.CancelReason, CancelReason.Expired)
                    .SetProperty(o => o.UpdatedAt, DateTimeOffset.UtcNow), ct);
        }
        return expired;
    }
}
