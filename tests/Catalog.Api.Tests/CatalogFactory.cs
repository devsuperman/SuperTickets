using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;
using Testcontainers.Redis;

namespace Catalog.Api.Tests;

/// <summary>Real Postgres + Redis containers, shared by all tests; Inventory is a fake handler.</summary>
public class Infra : IAsyncLifetime
{
    public PostgreSqlContainer Postgres { get; } = new PostgreSqlBuilder("postgres:16-alpine").Build();
    public RedisContainer Redis { get; } = new RedisBuilder("redis:7-alpine").Build();

    public async Task InitializeAsync() => await Task.WhenAll(Postgres.StartAsync(), Redis.StartAsync());
    public async Task DisposeAsync() { await Postgres.DisposeAsync(); await Redis.DisposeAsync(); }
}

[CollectionDefinition("infra")]
public class InfraCollection : ICollectionFixture<Infra>;

/// <summary>Contract-shaped Inventory stub: PUT /inventory/events/{id}.</summary>
public class FakeInventory : HttpMessageHandler
{
    public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
    public int Calls;
    public List<(Guid Id, int Total)> Received { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Interlocked.Increment(ref Calls);
        var id = Guid.Parse(request.RequestUri!.Segments.Last());
        var body = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, int>>(await request.Content!.ReadAsStringAsync(ct))!;
        lock (Received) Received.Add((id, body["totalTickets"]));
        return new HttpResponseMessage(Status)
        {
            Content = JsonContent.Create(new { eventId = id, totalTickets = body["totalTickets"], available = body["totalTickets"] }),
        };
    }
}

public class CatalogFactory(Infra infra, string? redis = null, int ttlSeconds = 60) : WebApplicationFactory<Program>
{
    public FakeInventory Inventory { get; } = new();
    public const string ApiKey = "test-key";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // A fresh database per factory keeps tests independent.
        var cs = new Npgsql.NpgsqlConnectionStringBuilder(infra.Postgres.GetConnectionString()) { Database = "catalog_" + Guid.NewGuid().ToString("N") };
        builder.UseSetting("ConnectionStrings:Catalog", cs.ConnectionString);
        builder.UseSetting("ConnectionStrings:Redis", redis ?? infra.Redis.GetConnectionString());
        builder.UseSetting("Services:InventoryUrl", "http://inventory.test");
        builder.UseSetting("Admin:ApiKey", ApiKey);
        builder.UseSetting("Cache:TtlSeconds", ttlSeconds.ToString());
        builder.ConfigureServices(s => s.AddHttpClient<Common.InventoryClient>()
            .ConfigurePrimaryHttpMessageHandler(() => Inventory));
    }

    public HttpClient AdminClient()
    {
        var c = CreateClient();
        c.DefaultRequestHeaders.Add("X-Api-Key", ApiKey);
        return c;
    }
}
