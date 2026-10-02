using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Order.Api.Features.ExpirePending;
using Order.Data;
using SuperTickets.Shared.Messaging;

namespace Order.Api.Tests;

[Collection("infra")]
public class OrderTests(Infra infra)
{
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();

    [Fact]
    public async Task Same_key_gives_one_order_and_one_outbox_row()
    {
        await using var f = new OrderFactory(infra);
        var client = f.CreateClient();
        var eventId = Guid.NewGuid();

        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => client.SendAsync(f.PostOrder("key-1", eventId))));
        var again = await client.SendAsync(f.PostOrder("key-1", eventId));

        Assert.All(results.Append(again), r => Assert.Equal(HttpStatusCode.Accepted, r.StatusCode));
        var ids = (await Task.WhenAll(results.Append(again).Select(async r => (await Json(r)).GetProperty("id").GetGuid()))).Distinct();
        Assert.Single(ids);
        Assert.Equal(1, await f.WithDb(db => db.Orders.CountAsync()));
        var outbox = await f.WithDb(db => db.Outbox.ToListAsync());
        var row = Assert.Single(outbox);
        Assert.Equal("OrderCreated", row.Type);
        Assert.Contains(ids.Single().ToString(), row.Payload);
    }

    [Fact]
    public async Task Pending_response_has_contract_shape()
    {
        await using var f = new OrderFactory(infra);
        var res = await f.CreateClient().SendAsync(f.PostOrder("shape"));
        var body = await Json(res);
        Assert.Equal("pending", body.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("cancelReason").ValueKind);
        Assert.Equal(0, body.GetProperty("tickets").GetArrayLength());
        Assert.Equal(2, body.GetProperty("quantity").GetInt32());
    }

    [Fact]
    public async Task Sold_out_returns_409_and_cancels_order()
    {
        await using var f = new OrderFactory(infra);
        f.Inventory.Reserve = () => HttpStatusCode.Conflict;
        var client = f.CreateClient();

        var res = await client.SendAsync(f.PostOrder("so"));

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("sold_out", (await Json(res)).GetProperty("type").GetString());
        var order = await f.WithDb(db => db.Orders.SingleAsync());
        Assert.Equal("cancelled", order.Status);
        Assert.Equal("sold_out", order.CancelReason);
        Assert.Equal(0, await f.WithDb(db => db.Outbox.CountAsync()));

        // Replay returns the final order.
        var replay = await client.SendAsync(f.PostOrder("so"));
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        Assert.Equal("cancelled", (await Json(replay)).GetProperty("status").GetString());
        Assert.Equal(1, f.Inventory.ReserveCalls);
    }

    [Fact]
    public async Task Inventory_down_gives_503_then_same_key_retry_succeeds()
    {
        await using var f = new OrderFactory(infra);
        f.Inventory.Reserve = () => HttpStatusCode.InternalServerError;
        var client = f.CreateClient();

        var down = await client.SendAsync(f.PostOrder("retry"));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, down.StatusCode);
        Assert.Equal("dependency_unavailable", (await Json(down)).GetProperty("type").GetString());
        Assert.Equal(3, f.Inventory.ReserveCalls); // 1 + 2 retries
        Assert.Equal("pending", (await f.WithDb(db => db.Orders.SingleAsync())).Status);
        Assert.Equal(0, await f.WithDb(db => db.Outbox.CountAsync()));

        f.Inventory.Reserve = () => HttpStatusCode.Created;
        var ok = await client.SendAsync(f.PostOrder("retry"));

        Assert.Equal(HttpStatusCode.Accepted, ok.StatusCode);
        Assert.Equal(1, await f.WithDb(db => db.Orders.CountAsync()));
        Assert.Equal(1, await f.WithDb(db => db.Outbox.CountAsync()));
    }

    [Fact]
    public async Task Breaker_opens_and_fails_fast()
    {
        await using var f = new OrderFactory(infra);
        f.Inventory.Reserve = () => HttpStatusCode.InternalServerError;
        var client = f.CreateClient();

        for (var i = 0; i < 3; i++)
            Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.SendAsync(f.PostOrder($"b{i}"))).StatusCode);
        var callsWhenOpen = f.Inventory.ReserveCalls;

        var fast = await client.SendAsync(f.PostOrder("b-after"));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, fast.StatusCode);
        Assert.Equal(callsWhenOpen, f.Inventory.ReserveCalls); // Inventory not called
        Assert.True(callsWhenOpen < 9);
    }

    [Fact]
    public async Task Unknown_event_gives_404()
    {
        await using var f = new OrderFactory(infra);
        f.Inventory.Reserve = () => HttpStatusCode.NotFound;
        var res = await f.CreateClient().SendAsync(f.PostOrder("nf"));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal(0, await f.WithDb(db => db.Orders.CountAsync()));
    }

    [Theory]
    [InlineData("", 2, "a@b.com", "idempotencyKey")]
    [InlineData("k", 0, "a@b.com", "quantity")]
    [InlineData("k", 11, "a@b.com", "quantity")]
    [InlineData("k", 1, "nope", "customerEmail")]
    public async Task Invalid_requests_return_400(string key, int quantity, string email, string field)
    {
        await using var f = new OrderFactory(infra);
        var req = new HttpRequestMessage(HttpMethod.Post, "/orders")
        {
            Content = JsonContent.Create(new { eventId = Guid.NewGuid(), quantity, customerEmail = email }),
        };
        if (key != "") req.Headers.Add("Idempotency-Key", key);

        var res = await f.CreateClient().SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.True((await Json(res)).GetProperty("errors").TryGetProperty(field, out _));
    }

    [Fact]
    public async Task Get_order_returns_tickets_or_404()
    {
        await using var f = new OrderFactory(infra);
        var client = f.CreateClient();
        var id = Guid.NewGuid();
        var eventId = Guid.NewGuid();
        await f.WithDb(async db =>
        {
            var now = DateTimeOffset.UtcNow;
            db.Orders.Add(new OrderEntity { Id = id, EventId = eventId, Quantity = 2, CustomerEmail = "a@b.com", Status = "paid", IdempotencyKey = "g", CreatedAt = now, UpdatedAt = now });
            foreach (var n in new[] { 2, 1 })
                db.Tickets.Add(new TicketEntity { Id = Guid.NewGuid(), OrderId = id, Number = n, EventId = eventId, CustomerEmail = "a@b.com", CreatedAt = now });
            return await db.SaveChangesAsync();
        });

        var res = await client.GetAsync($"/orders/{id}");
        var body = await Json(res);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("paid", body.GetProperty("status").GetString());
        Assert.Equal([1, 2], body.GetProperty("tickets").EnumerateArray().Select(t => t.GetProperty("number").GetInt32()));
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/orders/{Guid.NewGuid()}")).StatusCode);
    }

    [Fact]
    public async Task Sweeper_expires_old_pending_orders_and_releases_stock()
    {
        await using var f = new OrderFactory(infra);
        Guid stale = Guid.NewGuid(), fresh = Guid.NewGuid(), paid = Guid.NewGuid();
        await f.WithDb(async db =>
        {
            var now = DateTimeOffset.UtcNow;
            OrderEntity O(Guid id, string status, TimeSpan age) => new()
            {
                Id = id, EventId = Guid.NewGuid(), Quantity = 1, CustomerEmail = "a@b.com", Status = status,
                IdempotencyKey = id.ToString(), CreatedAt = now - age, UpdatedAt = now - age,
            };
            db.Orders.AddRange(O(stale, "pending", TimeSpan.FromMinutes(10)), O(fresh, "pending", TimeSpan.FromMinutes(1)), O(paid, "paid", TimeSpan.FromMinutes(10)));
            return await db.SaveChangesAsync();
        });
        var sweeper = f.Services.GetRequiredService<Sweeper>();

        Assert.Equal(1, await sweeper.SweepOnce());

        var orders = await f.WithDb(db => db.Orders.ToDictionaryAsync(o => o.Id));
        Assert.Equal("cancelled", orders[stale].Status);
        Assert.Equal("expired", orders[stale].CancelReason);
        Assert.Equal("pending", orders[fresh].Status);
        Assert.Equal("paid", orders[paid].Status);
        Assert.Equal([stale], f.Inventory.Released);
    }

    [Fact]
    public async Task Sweeper_leaves_order_pending_when_release_fails()
    {
        await using var f = new OrderFactory(infra);
        var id = Guid.NewGuid();
        await f.WithDb(async db =>
        {
            var old = DateTimeOffset.UtcNow.AddMinutes(-10);
            db.Orders.Add(new OrderEntity { Id = id, EventId = Guid.NewGuid(), Quantity = 1, CustomerEmail = "a@b.com", IdempotencyKey = "x", CreatedAt = old, UpdatedAt = old });
            return await db.SaveChangesAsync();
        });
        f.Inventory.Release = () => HttpStatusCode.InternalServerError;
        var sweeper = f.Services.GetRequiredService<Sweeper>();

        Assert.Equal(0, await sweeper.SweepOnce());
        Assert.Equal("pending", (await f.WithDb(db => db.Orders.SingleAsync())).Status);

        f.Inventory.Release = () => HttpStatusCode.NoContent;
        Assert.Equal(1, await sweeper.SweepOnce());
        Assert.Equal("cancelled", (await f.WithDb(db => db.Orders.SingleAsync())).Status);
    }
}
