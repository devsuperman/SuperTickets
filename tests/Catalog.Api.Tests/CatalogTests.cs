using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Catalog.Api.Tests;

[Collection("infra")]
public class CatalogTests(Infra infra)
{
    static object Body(string name = "Rock Night", string venue = "Arena", int total = 100, decimal price = 49.90m, DateTime? startsAt = null) =>
        new { name, venue, startsAt = startsAt ?? DateTime.UtcNow.AddDays(30), totalTickets = total, price };

    static async Task<JsonElement> Json(HttpResponseMessage r) => (await r.Content.ReadFromJsonAsync<JsonElement>());
    static string Cache(HttpResponseMessage r) => r.Headers.GetValues("X-Cache").Single();

    static async Task<Guid> Create(HttpClient admin, object? body = null)
    {
        var r = await admin.PostAsJsonAsync("/admin/events", body ?? Body());
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        return (await Json(r)).GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task Create_returns_201_location_and_calls_inventory()
    {
        await using var f = new CatalogFactory(infra);
        var r = await f.AdminClient().PostAsJsonAsync("/admin/events", Body(name: "  Padded  "));

        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var json = await Json(r);
        var id = json.GetProperty("id").GetGuid();
        Assert.Equal($"/events/{id}", r.Headers.Location!.OriginalString);
        Assert.Equal("Padded", json.GetProperty("name").GetString());
        Assert.Equal(49.90m, json.GetProperty("price").GetDecimal());
        Assert.Equal((id, 100), Assert.Single(f.Inventory.Received));
    }

    [Theory]
    [InlineData("", "Arena", 100, 10.0, 30, "name")]
    [InlineData("   ", "Arena", 100, 10.0, 30, "name")]
    [InlineData("X", "", 100, 10.0, 30, "venue")]
    [InlineData("X", "Arena", 0, 10.0, 30, "totalTickets")]
    [InlineData("X", "Arena", 100001, 10.0, 30, "totalTickets")]
    [InlineData("X", "Arena", 100, 0.0, 30, "price")]
    [InlineData("X", "Arena", 100, 10.123, 30, "price")]
    [InlineData("X", "Arena", 100, 100000.01, 30, "price")]
    [InlineData("X", "Arena", 100, 10.0, -1, "startsAt")]
    public async Task Invalid_body_returns_400_with_field_errors(string name, string venue, int total, double price, int days, string field)
    {
        await using var f = new CatalogFactory(infra);
        var r = await f.AdminClient().PostAsJsonAsync("/admin/events",
            Body(name, venue, total, (decimal)price, DateTime.UtcNow.AddDays(days)));

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.True((await Json(r)).GetProperty("errors").TryGetProperty(field, out _));
        Assert.Equal(0, f.Inventory.Calls);
    }

    [Fact]
    public async Task Search_longer_than_100_chars_returns_400()
    {
        await using var f = new CatalogFactory(infra);
        var r = await f.CreateClient().GetAsync("/events?search=" + new string('a', 101));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Theory]
    [InlineData("POST", false)]
    [InlineData("POST", true)]
    [InlineData("PUT", false)]
    [InlineData("PUT", true)]
    public async Task Admin_without_valid_key_returns_401(string method, bool wrongKey)
    {
        await using var f = new CatalogFactory(infra);
        var c = f.CreateClient();
        if (wrongKey) c.DefaultRequestHeaders.Add("X-Api-Key", "nope");
        var url = method == "POST" ? "/admin/events" : $"/admin/events/{Guid.NewGuid()}";
        var r = await c.SendAsync(new HttpRequestMessage(new HttpMethod(method), url) { Content = JsonContent.Create(Body()) });

        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Equal(0, f.Inventory.Calls);
    }

    [Fact]
    public async Task Get_event_is_MISS_then_HIT_and_404_for_unknown()
    {
        await using var f = new CatalogFactory(infra);
        var id = await Create(f.AdminClient());
        var c = f.CreateClient();

        var first = await c.GetAsync($"/events/{id}");
        var second = await c.GetAsync($"/events/{id}");

        Assert.Equal("MISS", Cache(first));
        Assert.Equal("HIT", Cache(second));
        Assert.Equal((await Json(first)).GetRawText(), (await Json(second)).GetRawText());
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync($"/events/{Guid.NewGuid()}")).StatusCode);
    }

    [Fact]
    public async Task List_is_MISS_then_HIT_ordered_upcoming_and_searchable()
    {
        await using var f = new CatalogFactory(infra);
        var admin = f.AdminClient();
        await Create(admin, Body("Zeta Fest", "Park", startsAt: DateTime.UtcNow.AddDays(20)));
        await Create(admin, Body("Alpha Gig", "Hall", startsAt: DateTime.UtcNow.AddDays(10)));
        var c = f.CreateClient();

        var first = await c.GetAsync("/events");
        var second = await c.GetAsync("/events");
        Assert.Equal("MISS", Cache(first));
        Assert.Equal("HIT", Cache(second));
        var names = (await Json(second)).EnumerateArray().Select(e => e.GetProperty("name").GetString()).ToArray();
        Assert.Equal(new[] { "Alpha Gig", "Zeta Fest" }, names!);

        var byName = await Json(await c.GetAsync("/events?search=ZETA"));
        Assert.Equal("Zeta Fest", Assert.Single(byName.EnumerateArray()).GetProperty("name").GetString());
        var byVenue = await Json(await c.GetAsync("/events?search=hall"));
        Assert.Equal("Alpha Gig", Assert.Single(byVenue.EnumerateArray()).GetProperty("name").GetString());
    }

    [Fact]
    public async Task Admin_write_invalidates_event_and_list_caches()
    {
        await using var f = new CatalogFactory(infra);
        var admin = f.AdminClient();
        var id = await Create(admin);
        await admin.GetAsync($"/events/{id}");
        await admin.GetAsync("/events");
        Assert.Equal("HIT", Cache(await admin.GetAsync($"/events/{id}")));
        Assert.Equal("HIT", Cache(await admin.GetAsync("/events")));

        var put = await admin.PutAsJsonAsync($"/admin/events/{id}", Body(name: "Renamed", total: 200));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var ev = await admin.GetAsync($"/events/{id}");
        Assert.Equal("MISS", Cache(ev));
        Assert.Equal("Renamed", (await Json(ev)).GetProperty("name").GetString());
        var list = await admin.GetAsync("/events");
        Assert.Equal("MISS", Cache(list));
        Assert.Equal("Renamed", (await Json(list)).EnumerateArray().Single().GetProperty("name").GetString());
        Assert.Equal((id, 200), f.Inventory.Received.Last());

        // creating a new event also invalidates the list
        await admin.GetAsync("/events");
        await Create(admin, Body("Second"));
        Assert.Equal("MISS", Cache(await admin.GetAsync("/events")));
    }

    [Fact]
    public async Task Update_unknown_event_returns_404()
    {
        await using var f = new CatalogFactory(infra);
        var r = await f.AdminClient().PutAsJsonAsync($"/admin/events/{Guid.NewGuid()}", Body());
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task Update_after_start_returns_409_event_started()
    {
        await using var f = new CatalogFactory(infra);
        var admin = f.AdminClient();
        var id = await Create(admin, Body(startsAt: DateTime.UtcNow.AddSeconds(2)));
        await Task.Delay(2500);

        var r = await admin.PutAsJsonAsync($"/admin/events/{id}", Body());

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("event_started", (await Json(r)).GetProperty("type").GetString());
    }

    [Fact]
    public async Task Inventory_409_maps_to_capacity_below_sold_and_event_is_unchanged()
    {
        await using var f = new CatalogFactory(infra);
        var admin = f.AdminClient();
        var id = await Create(admin);
        f.Inventory.Status = HttpStatusCode.Conflict;

        var r = await admin.PutAsJsonAsync($"/admin/events/{id}", Body(name: "Changed", total: 1));

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("capacity_below_sold", (await Json(r)).GetProperty("type").GetString());
        Assert.Equal("Rock Night", (await Json(await admin.GetAsync($"/events/{id}"))).GetProperty("name").GetString());
    }

    [Fact]
    public async Task Inventory_failure_returns_503_after_retries_and_nothing_is_saved()
    {
        await using var f = new CatalogFactory(infra);
        var admin = f.AdminClient();
        f.Inventory.Status = HttpStatusCode.InternalServerError;

        var r = await admin.PostAsJsonAsync("/admin/events", Body());

        Assert.True(HttpStatusCode.ServiceUnavailable == r.StatusCode, await r.Content.ReadAsStringAsync());
        Assert.Equal("dependency_unavailable", (await Json(r)).GetProperty("type").GetString());
        Assert.Equal(3, f.Inventory.Calls);
        Assert.Empty((await Json(await admin.GetAsync("/events"))).EnumerateArray());
    }

    [Fact]
    public async Task Redis_down_falls_back_to_postgres_with_MISS()
    {
        await using var f = new CatalogFactory(infra, redis: "localhost:1");
        var admin = f.AdminClient();
        var id = await Create(admin);   // write works, invalidation failure is swallowed

        for (var i = 0; i < 2; i++)
        {
            var ev = await admin.GetAsync($"/events/{id}");
            Assert.Equal(HttpStatusCode.OK, ev.StatusCode);
            Assert.Equal("MISS", Cache(ev));
            var list = await admin.GetAsync("/events");
            Assert.Equal(HttpStatusCode.OK, list.StatusCode);
            Assert.Equal("MISS", Cache(list));
            Assert.Single((await Json(list)).EnumerateArray());
        }
    }
}
