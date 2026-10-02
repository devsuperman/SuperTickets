using Amazon.SQS;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Order.Data;
using SuperTickets.Shared.Messaging;
using SuperTickets.Shared.Messaging.Contracts;
using Worker.Common;

namespace Worker.Features.SendNotification;

/// <summary>PaymentSucceeded → tickets 1..quantity (idempotent) and a logged confirmation.</summary>
public sealed class NotificationConsumer(
    IAmazonSQS sqs,
    IOptions<MessagingOptions> messaging,
    IServiceScopeFactory scopes,
    IOptions<DemoOptions> demo,
    ILogger<NotificationConsumer> logger)
    : SqsConsumer<PaymentSucceeded>(sqs, messaging.Value.NotificationQueueUrl, logger)
{
    protected override async Task HandleAsync(PaymentSucceeded m, CancellationToken ct)
    {
        if (Random.Shared.NextDouble() < demo.Value.NotificationErrorRate)
        {
            throw new InvalidOperationException("Simulated notification error");
        }

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrderDbContext>();
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO tickets (id, order_id, number, event_id, customer_email, status, created_at)
            SELECT gen_random_uuid(), {m.OrderId}, n, {m.EventId}, {m.CustomerEmail}, {TicketStatus.Valid}, {DateTimeOffset.UtcNow}
            FROM generate_series(1, {m.Quantity}) AS n
            ON CONFLICT (order_id, number) DO NOTHING
            """, ct);

        logger.LogInformation("Confirmation sent to {Email}: order {OrderId}, {Quantity} ticket(s)", m.CustomerEmail, m.OrderId, m.Quantity);
    }
}
