using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Npgsql;
using Testcontainers.PostgreSql;

namespace Inventory.Api.Tests;

public class InventoryFixture : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:16-alpine").Build();

    public string ConnectionString => new NpgsqlConnectionStringBuilder(_postgres.GetConnectionString())
    {
        Database = "inventory"
    }.ConnectionString;

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.UseSetting("ConnectionStrings:Inventory", ConnectionString);

    public async Task InitializeAsync()
    {
        await _postgres.StartAsync();
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();
        await _postgres.DisposeAsync();
    }

    public async Task<int> SetCapacity(Guid eventId, int total) =>
        (int)(await CreateClient().PutAsJsonAsync($"/inventory/events/{eventId}", new { totalTickets = total })).StatusCode;

    public async Task<int> Available(Guid eventId)
    {
        var dto = await CreateClient().GetFromJsonAsync<Availability>($"/events/{eventId}/availability");
        return dto!.Available;
    }

    public record Availability(Guid EventId, int Available);
}
