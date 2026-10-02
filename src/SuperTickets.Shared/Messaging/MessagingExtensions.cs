using Amazon.SimpleNotificationService;
using Amazon.SQS;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace SuperTickets.Shared.Messaging;

public static class MessagingExtensions
{
    /// <summary>
    /// Binds <see cref="MessagingOptions"/> and registers SNS/SQS clients. The SDK reads
    /// AWS_ENDPOINT_URL, AWS_REGION and credentials from the environment (LocalStack locally).
    /// </summary>
    public static IServiceCollection AddSuperTicketsMessaging(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<MessagingOptions>(configuration.GetSection(MessagingOptions.Section));
        services.AddSingleton<IAmazonSimpleNotificationService>(_ => new AmazonSimpleNotificationServiceClient());
        services.AddSingleton<IAmazonSQS>(_ => new AmazonSQSClient());
        return services;
    }
}
