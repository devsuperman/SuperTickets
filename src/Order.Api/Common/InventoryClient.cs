using System.Net;
using Polly.CircuitBreaker;
using Polly.Timeout;

namespace Order.Api.Common;

public enum ReserveResult { Reserved, SoldOut, EventNotFound, Unavailable }

/// <summary>
/// Reserve goes through "inventory-reserve" (timeout, retry, circuit breaker); release through
/// "inventory-release" (timeout, retry). Both calls are idempotent by orderId.
/// </summary>
public class InventoryClient(IHttpClientFactory factory, ILogger<InventoryClient> log)
{
    public const string ReserveClient = "inventory-reserve";
    public const string ReleaseClient = "inventory-release";

    record ReserveBody(Guid OrderId, Guid EventId, int Quantity);

    public async Task<ReserveResult> Reserve(Guid orderId, Guid eventId, int quantity, CancellationToken ct)
    {
        try
        {
            using var res = await factory.CreateClient(ReserveClient)
                .PostAsJsonAsync("/inventory/reservations", new ReserveBody(orderId, eventId, quantity), ct);
            if (res.IsSuccessStatusCode) return ReserveResult.Reserved;
            if (res.StatusCode == HttpStatusCode.Conflict) return ReserveResult.SoldOut;
            if (res.StatusCode == HttpStatusCode.NotFound) return ReserveResult.EventNotFound;
            log.LogWarning("Inventory returned {Status} reserving order {OrderId}", (int)res.StatusCode, orderId);
        }
        catch (Exception ex) when (IsDependencyFailure(ex, ct))
        {
            log.LogWarning(ex, "Inventory reserve failed for order {OrderId}", orderId);
        }
        return ReserveResult.Unavailable;
    }

    /// <summary>True when Inventory confirmed the release (204, also if missing).</summary>
    public async Task<bool> Release(Guid orderId, CancellationToken ct)
    {
        try
        {
            using var res = await factory.CreateClient(ReleaseClient).DeleteAsync($"/inventory/reservations/{orderId}", ct);
            if (res.IsSuccessStatusCode) return true;
            log.LogWarning("Inventory returned {Status} releasing order {OrderId}", (int)res.StatusCode, orderId);
        }
        catch (Exception ex) when (IsDependencyFailure(ex, ct))
        {
            log.LogWarning(ex, "Inventory release failed for order {OrderId}", orderId);
        }
        return false;
    }

    static bool IsDependencyFailure(Exception ex, CancellationToken ct) =>
        !ct.IsCancellationRequested &&
        ex is HttpRequestException or TaskCanceledException or TimeoutException or TimeoutRejectedException or BrokenCircuitException;
}
