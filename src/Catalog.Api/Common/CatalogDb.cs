using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Common;

public class EventEntity
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Venue { get; set; } = "";
    public DateTime StartsAt { get; set; }
    public int TotalTickets { get; set; }
    public decimal Price { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    public EventDto ToDto() => new(Id, Name, Venue, StartsAt, TotalTickets, Price);
}

public class CatalogDb(DbContextOptions<CatalogDb> options) : DbContext(options)
{
    public DbSet<EventEntity> Events => Set<EventEntity>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<EventEntity>(e =>
        {
            e.ToTable("events");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.Name).HasColumnName("name").HasMaxLength(200);
            e.Property(x => x.Venue).HasColumnName("venue").HasMaxLength(200);
            e.Property(x => x.StartsAt).HasColumnName("starts_at");
            e.Property(x => x.TotalTickets).HasColumnName("total_tickets");
            e.Property(x => x.Price).HasColumnName("price").HasPrecision(10, 2);
            e.Property(x => x.CreatedAt).HasColumnName("created_at");
            e.Property(x => x.UpdatedAt).HasColumnName("updated_at");
            e.HasIndex(x => x.StartsAt);
        });
    }
}
