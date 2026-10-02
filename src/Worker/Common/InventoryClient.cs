namespace Worker.Common;

public class InventoryClient(HttpClient http)
{
    /// <summary>DELETE /inventory/reservations/{orderId}: idempotent. Throws on failure (after retries) so the message is redelivered.</summary>
    public async Task ReleaseAsync(Guid orderId, CancellationToken ct)
    {
        using var res = await http.DeleteAsync($"/inventory/reservations/{orderId}", ct);
        res.EnsureSuccessStatusCode();
    }
}
