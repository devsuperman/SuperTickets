using System.Net;

namespace Catalog.Api.Common;

public class InventoryOptions
{
    public string InventoryUrl { get; set; } = "http://inventory-api:8080";
}

public enum CapacityResult { Ok, BelowSold, Unavailable }

public class InventoryClient(HttpClient http, ILogger<InventoryClient> log)
{
    record CapacityBody(int TotalTickets);

    /// <summary>PUT /inventory/events/{id}. 409 means below sold; anything else non-2xx (after retries) is unavailable.</summary>
    public async Task<CapacityResult> SetCapacity(Guid eventId, int totalTickets, CancellationToken ct)
    {
        try
        {
            // StringContent is re-readable, so the retry strategy can resend it.
            using var content = new StringContent(
                System.Text.Json.JsonSerializer.Serialize(new CapacityBody(totalTickets), System.Text.Json.JsonSerializerOptions.Web),
                System.Text.Encoding.UTF8, "application/json");
            using var res = await http.PutAsync($"/inventory/events/{eventId}", content, ct);
            if (res.IsSuccessStatusCode) return CapacityResult.Ok;
            if (res.StatusCode == HttpStatusCode.Conflict) return CapacityResult.BelowSold;
            log.LogWarning("Inventory returned {Status} for capacity of {EventId}", (int)res.StatusCode, eventId);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or TimeoutException
                                       or Polly.Timeout.TimeoutRejectedException)
        {
            if (ct.IsCancellationRequested) throw;
            log.LogWarning(ex, "Inventory call failed for {EventId}", eventId);
        }
        return CapacityResult.Unavailable;
    }
}
