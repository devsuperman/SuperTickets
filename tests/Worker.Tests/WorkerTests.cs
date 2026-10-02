using System.Net;
using Microsoft.EntityFrameworkCore;
using Order.Data;

namespace Worker.Tests;

public sealed class WorkerTests(WorkerInfra infra) : IClassFixture<WorkerInfra>
{
    private static async Task<List<string>> OutboxTypes(OrderDbContext db, Guid orderId) =>
        (await db.Outbox.AsNoTracking().ToListAsync()).Where(o => o.Payload.Contains(orderId.ToString())).Select(o => o.Type).ToList();

    [Fact]
    public async Task Duplicate_OrderCreated_gives_one_payment_and_one_event()
    {
        var h = await infra.CreateHarnessAsync(failureRate: 0);
        var id = await h.SeedOrderAsync();
        var order = await h.GetOrderAsync(id);
        await h.SendOrderCreatedAsync(order);
        await h.SendOrderCreatedAsync(order);

        await Harness.PumpAsync(h.Payment, 2);

        await using var db = h.Db();
        Assert.Equal(OrderStatus.Paid, (await h.GetOrderAsync(id)).Status);
        Assert.Equal(1, await db.Payments.CountAsync(p => p.OrderId == id));
        Assert.Equal(1, (await OutboxTypes(db, id)).Count(t => t == "PaymentSucceeded"));
        Assert.Empty(h.Inventory.Calls);
    }

    [Fact]
    public async Task Payment_failure_cancels_order_and_releases_stock()
    {
        var h = await infra.CreateHarnessAsync(failureRate: 1);
        var id = await h.SeedOrderAsync();
        await h.SendOrderCreatedAsync(await h.GetOrderAsync(id));

        await Harness.PumpAsync(h.Payment, 1);

        var order = await h.GetOrderAsync(id);
        Assert.Equal(OrderStatus.Cancelled, order.Status);
        Assert.Equal(CancelReason.PaymentFailed, order.CancelReason);
        Assert.Equal(1, h.Inventory.Releases(id));
        await using var db = h.Db();
        Assert.Equal(1, (await OutboxTypes(db, id)).Count(t => t == "PaymentFailed"));
    }

    [Fact]
    public async Task Release_error_leaves_message_and_redelivery_releases_without_a_second_payment()
    {
        var h = await infra.CreateHarnessAsync(failureRate: 1);
        h.Inventory.Status = HttpStatusCode.InternalServerError;
        var id = await h.SeedOrderAsync();
        await h.SendOrderCreatedAsync(await h.GetOrderAsync(id));

        Assert.Equal(0, await h.Payment.ReceiveOnceAsync()); // retried, then failed: message stays
        Assert.True(h.Inventory.Calls.Count > 1);            // retry happened
        Assert.Equal(OrderStatus.Cancelled, (await h.GetOrderAsync(id)).Status);

        h.Inventory.Status = HttpStatusCode.NoContent;
        await Harness.PumpAsync(h.Payment, 1);

        Assert.Equal(1, h.Inventory.Releases(id));
        await using var db = h.Db();
        Assert.Equal(1, await db.Payments.CountAsync(p => p.OrderId == id));
        Assert.Equal(1, (await OutboxTypes(db, id)).Count(t => t == "PaymentFailed"));
    }

    [Fact]
    public async Task Already_cancelled_order_is_untouched()
    {
        var h = await infra.CreateHarnessAsync(failureRate: 0);
        var id = await h.SeedOrderAsync(OrderStatus.Cancelled);
        await h.SendOrderCreatedAsync(await h.GetOrderAsync(id));

        await Harness.PumpAsync(h.Payment, 1);

        var order = await h.GetOrderAsync(id);
        Assert.Equal(OrderStatus.Cancelled, order.Status);
        Assert.Equal(CancelReason.Expired, order.CancelReason);
        await using var db = h.Db();
        Assert.False(await db.Payments.AnyAsync(p => p.OrderId == id));
        Assert.Empty(await OutboxTypes(db, id));
        Assert.Empty(h.Inventory.Calls);
    }

    [Fact]
    public async Task Duplicate_PaymentSucceeded_creates_quantity_tickets()
    {
        var h = await infra.CreateHarnessAsync();
        var id = await h.SeedOrderAsync(OrderStatus.Paid, quantity: 3);
        var order = await h.GetOrderAsync(id);
        var evt = new { orderId = id, eventId = order.EventId, quantity = 3, customerEmail = "a@b.com", paidAt = DateTimeOffset.UtcNow };
        await h.SendAsync(h.NotificationQueue, evt);
        await h.SendAsync(h.NotificationQueue, evt);

        await Harness.PumpAsync(h.Notification, 2);

        await using var db = h.Db();
        var numbers = await db.Tickets.Where(t => t.OrderId == id).OrderBy(t => t.Number).Select(t => t.Number).ToListAsync();
        Assert.Equal([1, 2, 3], numbers);
        Assert.All(await db.Tickets.Where(t => t.OrderId == id).ToListAsync(),
            t => { Assert.Equal(TicketStatus.Valid, t.Status); Assert.Equal(order.EventId, t.EventId); });
    }

    [Fact]
    public async Task Throwing_handler_moves_message_to_DLQ_after_5_receives()
    {
        var h = await infra.CreateHarnessAsync(notificationErrorRate: 1);
        var id = await h.SeedOrderAsync(OrderStatus.Paid);
        await h.SendAsync(h.NotificationQueue, new { orderId = id, eventId = Guid.NewGuid(), quantity = 2, customerEmail = "a@b.com", paidAt = DateTimeOffset.UtcNow });

        // Every receive fails (handler throws); after 5 receives the broker moves the message to the DLQ.
        var inDlq = 0;
        for (var i = 0; i < 20 && inDlq == 0; i++)
        {
            Assert.Equal(0, await h.Notification.ReceiveOnceAsync());
            inDlq = await h.CountAsync(h.NotificationDlq);
        }

        Assert.Equal(1, inDlq);
        await using var db = h.Db();
        Assert.False(await db.Tickets.AnyAsync(t => t.OrderId == id));
    }
}
