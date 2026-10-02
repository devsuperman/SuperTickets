using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using SuperTickets.Shared.Messaging.Contracts;

namespace SuperTickets.Shared.Messaging;

/// <summary>Row of the <c>outbox</c> table. <see cref="Id"/> is sent as the <c>messageId</c> attribute.</summary>
public sealed class OutboxMessage
{
    public Guid Id { get; set; }
    public string Type { get; set; } = "";
    public string Payload { get; set; } = "";
    public string? CorrelationId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? PublishedAt { get; set; }
}

public static class OutboxExtensions
{
    /// <summary>Call from <c>OnModelCreating</c>: maps <see cref="OutboxMessage"/> to <c>outbox</c> (snake_case, jsonb payload, partial index on unpublished rows).</summary>
    public static ModelBuilder AddOutbox(this ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<OutboxMessage>(e =>
        {
            e.ToTable("outbox");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedNever();
            e.Property(x => x.Type).HasColumnName("type").IsRequired();
            e.Property(x => x.Payload).HasColumnName("payload").HasColumnType("jsonb").IsRequired();
            e.Property(x => x.CorrelationId).HasColumnName("correlation_id");
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.Property(x => x.PublishedAt).HasColumnName("published_at");
            e.HasIndex(x => x.CreatedAt).HasDatabaseName("ix_outbox_unpublished").HasFilter("published_at IS NULL");
        });
        return modelBuilder;
    }

    /// <summary>
    /// Adds an event to the outbox in the caller's unit of work; nothing is sent until the caller
    /// runs <c>SaveChanges</c>, so the event commits atomically with the state change.
    /// Uses the ambient correlation ID. Returns the row (its Id is the messageId).
    /// </summary>
    public static OutboxMessage AddToOutbox<TMessage>(this DbContext db, TMessage message) where TMessage : IMessage
    {
        var row = new OutboxMessage
        {
            Id = Guid.NewGuid(),
            Type = typeof(TMessage).Name,
            Payload = JsonSerializer.Serialize(message, MessageJson.Options),
            CorrelationId = CorrelationContext.Current,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Set<OutboxMessage>().Add(row);
        return row;
    }
}
