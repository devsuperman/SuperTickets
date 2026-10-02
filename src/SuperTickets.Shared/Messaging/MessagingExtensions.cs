using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace SuperTickets.Shared.Messaging;

public static class MessagingExtensions
{
    /// <summary>Binds <see cref="MessagingOptions"/> and registers the shared RabbitMQ connection.</summary>
    public static IServiceCollection AddSuperTicketsMessaging(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<MessagingOptions>(configuration.GetSection(MessagingOptions.Section));
        services.AddSingleton<RabbitMq>();
        return services;
    }
}
