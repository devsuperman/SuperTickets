using Catalog.Api.Common;
using Catalog.Api.Features.CreateEvent;
using Catalog.Api.Features.GetEvent;
using Catalog.Api.Features.ListEvents;
using Catalog.Api.Features.UpdateEvent;
using Microsoft.EntityFrameworkCore;
using Polly;
using StackExchange.Redis;
using SuperTickets.Shared;

var builder = WebApplication.CreateBuilder(args);
var services = builder.Services;
services.AddSuperTicketsDefaults();

// Config is read lazily so tests can override it after Program starts building.
services.AddDbContext<CatalogDb>((sp, o) =>
    o.UseNpgsql(sp.GetRequiredService<IConfiguration>().GetConnectionString("Catalog")));

services.Configure<CacheOptions>(builder.Configuration.GetSection("Cache"));
services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var opts = ConfigurationOptions.Parse(sp.GetRequiredService<IConfiguration>().GetConnectionString("Redis")!);
    opts.AbortOnConnectFail = false;                 // start without Redis
    opts.BacklogPolicy = BacklogPolicy.FailFast;     // fail fast while it is down
    opts.ConnectTimeout = 1000;
    opts.AsyncTimeout = 1000;
    opts.SyncTimeout = 1000;
    return ConnectionMultiplexer.Connect(opts);
});
services.AddScoped<EventCache>();

services.AddHttpClient<InventoryClient>((sp, c) =>
        c.BaseAddress = new Uri(sp.GetRequiredService<IConfiguration>()["Services:InventoryUrl"]!))
    .AddResilienceHandler("inventory", b => b
        .AddRetry(new Polly.Retry.RetryStrategyOptions<HttpResponseMessage>
        {
            MaxRetryAttempts = 2,
            Delay = TimeSpan.FromMilliseconds(200),
            BackoffType = DelayBackoffType.Exponential,
            ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
                .Handle<HttpRequestException>()
                .Handle<Polly.Timeout.TimeoutRejectedException>()
                .HandleResult(r => (int)r.StatusCode >= 500),
        })
        .AddTimeout(TimeSpan.FromSeconds(2)));

services.AddScoped<AdminKeyFilter>();
services.AddHealthChecks()
    .AddCheck<PostgresCheck>("postgres")
    .AddCheck<RedisCheck>("redis");

var app = builder.Build();
using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<CatalogDb>().Database.Migrate();

app.UseSuperTicketsDefaults();
ListEvents.Map(app);
GetEvent.Map(app);
CreateEvent.Map(app);
UpdateEvent.Map(app);
app.Run();

public partial class Program;
