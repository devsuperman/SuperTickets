using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Order.Api.Common;
using Order.Data;
using Testcontainers.PostgreSql;

namespace Order.Api.Tests;

/// <summary>One Postgres container shared by all tests.</summary>
public class Infra : IAsyncLifetime
{
    public PostgreSqlContainer Postgres { get; } = new PostgreSqlBuilder("postgres:16-alpine").Build();
    public async Task InitializeAsync() => await Postgres.StartAsync();
    public async Task DisposeAsync() => await Postgres.DisposeAsync();
}

[CollectionDefinition("infra")]
public class InfraCollection : ICollectionFixture<Infra>;

/// <summary>Contract-shaped Inventory stub; set <see cref="Reserve"/>/<see cref="Release"/> to change behaviour.</summary>
public class FakeInventory : HttpMessageHandler
{
    public Func<HttpStatusCode> Reserve { get; set; } = () => HttpStatusCode.Created;
    public Func<HttpStatusCode> Release { get; set; } = () => HttpStatusCode.NoContent;
    public int ReserveCalls, ReleaseCalls;
    public List<Guid> Released { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        HttpStatusCode status;
        if (request.Method == HttpMethod.Post)
        {
            Interlocked.Increment(ref ReserveCalls);
            status = Reserve();
        }
        else
        {
            Interlocked.Increment(ref ReleaseCalls);
            status = Release();
            if ((int)status < 300) lock (Released) Released.Add(Guid.Parse(request.RequestUri!.Segments.Last()));
        }
        return Task.FromResult(new HttpResponseMessage(status));
    }
}

public class OrderFactory(Infra infra) : WebApplicationFactory<Program>
{
    public FakeInventory Inventory { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // A fresh database per factory keeps tests independent.
        var cs = new Npgsql.NpgsqlConnectionStringBuilder(infra.Postgres.GetConnectionString()) { Database = "orders_" + Guid.NewGuid().ToString("N") };
        builder.UseSetting("ConnectionStrings:Orders", cs.ConnectionString);
        builder.UseSetting("Services:InventoryUrl", "http://inventory.test");
        builder.UseSetting("Orders:PendingTimeoutMinutes", "5");
        builder.ConfigureServices(s =>
        {
            // No background loops in tests: the sweeper is called directly, the outbox is inspected in the table.
            s.RemoveAll<IHostedService>();
            foreach (var name in new[] { InventoryClient.ReserveClient, InventoryClient.ReleaseClient })
                s.AddHttpClient(name).ConfigurePrimaryHttpMessageHandler(() => Inventory);
        });
    }

    public async Task<T> WithDb<T>(Func<OrderDbContext, Task<T>> action)
    {
        using var scope = Services.CreateScope();
        return await action(scope.ServiceProvider.GetRequiredService<OrderDbContext>());
    }

    public HttpRequestMessage PostOrder(string key, Guid? eventId = null, int quantity = 2) =>
        new(HttpMethod.Post, "/orders")
        {
            Headers = { { "Idempotency-Key", key } },
            Content = JsonContent.Create(new { eventId = eventId ?? Guid.NewGuid(), quantity, customerEmail = "a@b.com" }),
        };
}
