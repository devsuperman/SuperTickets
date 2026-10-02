using Amazon.SQS;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Order.Data;
using SuperTickets.Shared.Messaging;
using SuperTickets.Shared.Messaging.Contracts;
using Worker.Common;

namespace Worker.Features.ProcessPayment;

/// <summary>OrderCreated → simulated payment → paid or cancelled + outbox event; on failure release stock.</summary>
public sealed class PaymentConsumer(
    IAmazonSQS sqs,
    IOptions<MessagingOptions> messaging,
    IServiceScopeFactory scopes,
    IOptions<PaymentOptions> payment,
    ILogger<PaymentConsumer> logger)
    : SqsConsumer<OrderCreated>(sqs, messaging.Value.PaymentQueueUrl, logger)
{
    protected override async Task HandleAsync(OrderCreated message, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrderDbContext>();

        var succeeded = await db.Payments.Where(p => p.OrderId == message.OrderId)
            .Select(p => (bool?)p.Succeeded).SingleOrDefaultAsync(ct);

        if (succeeded is null)
        {
            succeeded = await PayAsync(db, message, ct);
            if (succeeded is null)
            {
                logger.LogInformation("Order {OrderId} is not pending; payment skipped", message.OrderId);
                return;
            }
        }

        if (succeeded == false)
        {
            // A release error propagates: the message stays on the queue and the (idempotent) release is retried.
            await scope.ServiceProvider.GetRequiredService<InventoryClient>().ReleaseAsync(message.OrderId, ct);
        }
    }

    /// <summary>One transaction: order status, payment row, outbox event. Null when the order is no longer pending.</summary>
    private async Task<bool?> PayAsync(OrderDbContext db, OrderCreated m, CancellationToken ct)
    {
        var ok = Random.Shared.NextDouble() >= payment.Value.FailureRate;
        var now = DateTimeOffset.UtcNow;

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var status = ok ? OrderStatus.Paid : OrderStatus.Cancelled;
        var reason = ok ? null : CancelReason.PaymentFailed;
        var updated = await db.Orders
            .Where(o => o.Id == m.OrderId && o.Status == OrderStatus.Pending)
            .ExecuteUpdateAsync(s => s
                .SetProperty(o => o.Status, status)
                .SetProperty(o => o.CancelReason, reason)
                .SetProperty(o => o.UpdatedAt, now), ct);
        if (updated == 0) return null;

        db.Payments.Add(new PaymentEntity { OrderId = m.OrderId, Succeeded = ok, ProcessedAt = now });
        if (ok) db.AddToOutbox(new PaymentSucceeded(m.OrderId, m.EventId, m.Quantity, m.CustomerEmail, now));
        else db.AddToOutbox(new PaymentFailed(m.OrderId, m.EventId, m.Quantity, "simulated_decline", now));
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return ok;
    }
}
