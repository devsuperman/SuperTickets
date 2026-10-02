using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Order.Data;

/// <summary>Used by <c>dotnet ef</c> only.</summary>
internal sealed class DesignTimeFactory : IDesignTimeDbContextFactory<OrderDbContext>
{
    public OrderDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<OrderDbContext>()
            .UseNpgsql("Host=localhost;Database=orders;Username=postgres;Password=postgres").Options);
}
