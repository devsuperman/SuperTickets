using Microsoft.Extensions.Hosting;
using SuperTickets.Shared;

namespace Worker.Tests;

public class HostTests
{
    [Fact]
    public async Task Host_starts_and_stops()
    {
        var builder = Host.CreateApplicationBuilder();
        builder.Services.AddSuperTicketsDefaults();
        using var host = builder.Build();

        await host.StartAsync();
        await host.StopAsync();
    }
}
