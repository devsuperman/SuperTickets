using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SuperTickets.Shared.Messaging;

namespace Order.Data;

public sealed class OrderDbContext(DbContextOptions<OrderDbContext> options) : DbContext(options)
{
    public DbSet<OrderEntity> Orders => Set<OrderEntity>();
    public DbSet<PaymentEntity> Payments => Set<PaymentEntity>();
    public DbSet<TicketEntity> Tickets => Set<TicketEntity>();
    public DbSet<OutboxMessage> Outbox => Set<OutboxMessage>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<OrderEntity>(e =>
        {
            e.ToTable("orders", t => t.HasCheckConstraint("ck_orders_status", "status IN ('pending','paid','cancelled')"));
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedNever();
            e.Property(x => x.EventId).HasColumnName("event_id");
            e.Property(x => x.Quantity).HasColumnName("quantity");
            e.Property(x => x.CustomerEmail).HasColumnName("customer_email").HasMaxLength(254);
            e.Property(x => x.Status).HasColumnName("status").HasMaxLength(20);
            e.Property(x => x.CancelReason).HasColumnName("cancel_reason").HasMaxLength(30);
            e.Property(x => x.IdempotencyKey).HasColumnName("idempotency_key").HasMaxLength(100);
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.Property(x => x.UpdatedAt).HasColumnName("updated_at");
            e.HasIndex(x => x.IdempotencyKey).IsUnique().HasDatabaseName("ux_orders_idempotency_key");
            e.HasIndex(x => x.CreatedAt).HasDatabaseName("ix_orders_pending").HasFilter("status = 'pending'");
            e.HasMany(x => x.Tickets).WithOne().HasForeignKey(x => x.OrderId);
        });

        b.Entity<PaymentEntity>(e =>
        {
            e.ToTable("payments");
            e.HasKey(x => x.OrderId);
            e.Property(x => x.OrderId).HasColumnName("order_id").ValueGeneratedNever();
            e.Property(x => x.Succeeded).HasColumnName("succeeded");
            e.Property(x => x.ProcessedAt).HasColumnName("processed_at");
            e.HasOne<OrderEntity>().WithOne().HasForeignKey<PaymentEntity>(x => x.OrderId);
        });

        b.Entity<TicketEntity>(e =>
        {
            e.ToTable("tickets");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedNever();
            e.Property(x => x.OrderId).HasColumnName("order_id");
            e.Property(x => x.Number).HasColumnName("number");
            e.Property(x => x.EventId).HasColumnName("event_id");
            e.Property(x => x.CustomerEmail).HasColumnName("customer_email").HasMaxLength(254);
            e.Property(x => x.Status).HasColumnName("status").HasMaxLength(20);
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.HasIndex(x => new { x.OrderId, x.Number }).IsUnique().HasDatabaseName("ux_tickets_order_number");
        });

        b.AddOutbox();
    }
}

public static class OrderDataExtensions
{
    /// <summary>Registers <see cref="OrderDbContext"/> using <c>ConnectionStrings:Orders</c>.</summary>
    public static IServiceCollection AddOrderData(this IServiceCollection services, IConfiguration configuration) =>
        services.AddDbContext<OrderDbContext>(o => o.UseNpgsql(configuration.GetConnectionString("Orders")));
}
