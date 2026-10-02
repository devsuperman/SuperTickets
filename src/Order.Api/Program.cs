using Microsoft.EntityFrameworkCore;
using Order.Api.Common;
using Order.Api.Features.CreateOrder;
using Order.Api.Features.ExpirePending;
using Order.Api.Features.GetOrder;
using Order.Data;
using Polly;
using Polly.CircuitBreaker;
using Polly.Retry;
using SuperTickets.Shared;
using SuperTickets.Shared.Messaging;

var builder = WebApplication.CreateBuilder(args);
var services = builder.Services;
services.AddSuperTicketsDefaults();
services.AddOrderData(builder.Configuration);
services.AddSuperTicketsMessaging(builder.Configuration);
services.AddHostedService<OutboxPublisher<OrderDbContext>>();
services.AddSingleton<Sweeper>();
services.AddHostedService(sp => sp.GetRequiredService<Sweeper>());

static RetryStrategyOptions<HttpResponseMessage> Retry() => new()
{
    MaxRetryAttempts = 2,
    Delay = TimeSpan.FromMilliseconds(200),
    BackoffType = DelayBackoffType.Exponential,
    ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
        .Handle<HttpRequestException>()
        .Handle<Polly.Timeout.TimeoutRejectedException>()
        .HandleResult(r => (int)r.StatusCode >= 500),
};

void InventoryUrl(IServiceProvider sp, HttpClient c) =>
    c.BaseAddress = new Uri(sp.GetRequiredService<IConfiguration>()["Services:InventoryUrl"]!);

services.AddHttpClient(InventoryClient.ReserveClient, InventoryUrl)
    .AddResilienceHandler("inventory-reserve", b => b
        .AddRetry(Retry())
        .AddCircuitBreaker(new CircuitBreakerStrategyOptions<HttpResponseMessage>
        {
            FailureRatio = 0.5,
            MinimumThroughput = 5,
            SamplingDuration = TimeSpan.FromSeconds(30),
            BreakDuration = TimeSpan.FromSeconds(15),
            ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
                .Handle<HttpRequestException>()
                .Handle<Polly.Timeout.TimeoutRejectedException>()
                .HandleResult(r => (int)r.StatusCode >= 500),
        })
        .AddTimeout(TimeSpan.FromSeconds(2)));
services.AddHttpClient(InventoryClient.ReleaseClient, InventoryUrl)
    .AddResilienceHandler("inventory-release", b => b.AddRetry(Retry()).AddTimeout(TimeSpan.FromSeconds(2)));
services.AddScoped<InventoryClient>();

services.AddHealthChecks().AddCheck<PostgresCheck>("postgres");

var app = builder.Build();
using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<OrderDbContext>().Database.Migrate();

app.UseSuperTicketsDefaults();
CreateOrder.Map(app);
GetOrder.Map(app);
app.Run();

public partial class Program;
