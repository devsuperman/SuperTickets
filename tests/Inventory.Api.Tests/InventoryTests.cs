using System.Net;
using System.Net.Http.Json;

namespace Inventory.Api.Tests;

public class InventoryTests(InventoryFixture f) : IClassFixture<InventoryFixture>
{
    private static Task<HttpResponseMessage> Reserve(HttpClient c, Guid order, Guid ev, int qty) =>
        c.PostAsJsonAsync("/inventory/reservations", new { orderId = order, eventId = ev, quantity = qty });

    private async Task<Guid> NewEvent(int total)
    {
        var id = Guid.NewGuid();
        Assert.Equal(200, await f.SetCapacity(id, total));
        return id;
    }

    [Fact]
    public async Task Twenty_parallel_reserves_for_one_ticket_yield_one_201()
    {
        var ev = await NewEvent(1);
        var client = f.CreateClient();

        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => Reserve(client, Guid.NewGuid(), ev, 1)));

        Assert.Equal(1, responses.Count(r => r.StatusCode == HttpStatusCode.Created));
        Assert.Equal(19, responses.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        Assert.Equal(0, await f.Available(ev));
        var problem = await responses.First(r => r.StatusCode == HttpStatusCode.Conflict).Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        Assert.Equal("sold_out", problem.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Reserve_replay_is_a_noop()
    {
        var ev = await NewEvent(5);
        var order = Guid.NewGuid();
        var client = f.CreateClient();

        Assert.Equal(HttpStatusCode.Created, (await Reserve(client, order, ev, 2)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Reserve(client, order, ev, 2)).StatusCode);
        Assert.Equal(3, await f.Available(ev));
    }

    [Fact]
    public async Task Release_restores_stock_and_replay_is_a_noop()
    {
        var ev = await NewEvent(5);
        var order = Guid.NewGuid();
        var client = f.CreateClient();
        await Reserve(client, order, ev, 3);
        Assert.Equal(2, await f.Available(ev));

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/inventory/reservations/{order}")).StatusCode);
        Assert.Equal(5, await f.Available(ev));
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/inventory/reservations/{order}")).StatusCode);
        Assert.Equal(5, await f.Available(ev));
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/inventory/reservations/{Guid.NewGuid()}")).StatusCode);

        // Replaying the reserve of a released order does not take stock again.
        Assert.Equal(HttpStatusCode.OK, (await Reserve(client, order, ev, 3)).StatusCode);
        Assert.Equal(5, await f.Available(ev));
    }

    [Fact]
    public async Task Capacity_cut_below_reserved_is_409_and_otherwise_adjusts_available()
    {
        var ev = await NewEvent(10);
        var client = f.CreateClient();
        await Reserve(client, Guid.NewGuid(), ev, 4);

        var cut = await client.PutAsJsonAsync($"/inventory/events/{ev}", new { totalTickets = 3 });
        Assert.Equal(HttpStatusCode.Conflict, cut.StatusCode);
        var problem = await cut.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        Assert.Equal("capacity_below_sold", problem.GetProperty("type").GetString());
        Assert.Equal(6, await f.Available(ev));

        var ok = await client.PutAsJsonAsync($"/inventory/events/{ev}", new { totalTickets = 4 });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(0, await f.Available(ev));
        // Replay is a no-op.
        Assert.Equal(200, await f.SetCapacity(ev, 4));
        Assert.Equal(0, await f.Available(ev));
    }

    [Fact]
    public async Task Unknown_event_and_invalid_input()
    {
        var client = f.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await Reserve(client, Guid.NewGuid(), Guid.NewGuid(), 1)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/events/{Guid.NewGuid()}/availability")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Reserve(client, Guid.NewGuid(), Guid.NewGuid(), 0)).StatusCode);
        Assert.Equal(400, await f.SetCapacity(Guid.NewGuid(), 0));
    }

    [Fact]
    public async Task Demo_error_toggle_fails_reserve_only()
    {
        var ev = await NewEvent(2);
        using var failing = f.WithWebHostBuilder(b => b.UseSetting("Demo:ErrorRate", "1")).CreateClient();

        Assert.Equal(HttpStatusCode.InternalServerError, (await Reserve(failing, Guid.NewGuid(), ev, 1)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await failing.DeleteAsync($"/inventory/reservations/{Guid.NewGuid()}")).StatusCode);
        Assert.Equal(2, await f.Available(ev));
    }
}
