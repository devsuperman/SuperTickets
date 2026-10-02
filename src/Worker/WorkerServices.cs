using Microsoft.Extensions.Http.Resilience;
using Order.Data;
using Polly;
using Polly.Retry;
using SuperTickets.Shared;
using SuperTickets.Shared.Messaging;
using Worker.Common;
using Worker.Features.ProcessPayment;
using Worker.Features.SendNotification;

namespace Worker;

public static class WorkerServices
{
    public static IServiceCollection AddWorker(this IServiceCollection services, IConfiguration config)
    {
        services.AddSuperTicketsDefaults();
        services.AddOrderData(config);
        services.AddSuperTicketsMessaging(config);
        services.Configure<PaymentOptions>(config.GetSection("Payment"));
        services.Configure<DemoOptions>(config.GetSection("Demo"));

        services.AddHttpClient<InventoryClient>(c => c.BaseAddress = new Uri(config["Services:InventoryUrl"]!))
            .AddResilienceHandler("inventory", b => b
                .AddRetry(new RetryStrategyOptions<HttpResponseMessage>
                {
                    MaxRetryAttempts = 3,
                    Delay = TimeSpan.FromMilliseconds(200),
                    BackoffType = DelayBackoffType.Exponential,
                    ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
                        .Handle<HttpRequestException>()
                        .Handle<Polly.Timeout.TimeoutRejectedException>()
                        .HandleResult(r => (int)r.StatusCode >= 500),
                })
                .AddTimeout(TimeSpan.FromSeconds(2)));

        services.AddHostedService<PaymentConsumer>();
        services.AddHostedService<NotificationConsumer>();
        return services;
    }
}
