using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace SuperTickets.Shared.Tests;

public class DefaultsTests
{
    private static async Task<WebApplication> StartAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddSuperTicketsDefaults();
        var app = builder.Build();
        app.UseSuperTicketsDefaults();
        app.MapGet("/boom", () => { throw new InvalidOperationException("boom"); });
        await app.StartAsync();
        return app;
    }

    [Fact]
    public async Task Generates_correlation_id_when_missing()
    {
        await using var app = await StartAsync();
        var response = await app.GetTestClient().GetAsync("/health");

        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        Assert.True(Guid.TryParse(response.Headers.GetValues("X-Correlation-Id").Single(), out _));
    }

    [Fact]
    public async Task Errors_are_problem_details_with_correlation_id()
    {
        await using var app = await StartAsync();
        var request = new HttpRequestMessage(HttpMethod.Get, "/boom");
        request.Headers.Add("X-Correlation-Id", "c-1");
        var response = await app.GetTestClient().SendAsync(request);

        Assert.Equal(System.Net.HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("c-1", response.Headers.GetValues("X-Correlation-Id").Single());
    }

    [Fact]
    public async Task Outgoing_handler_forwards_correlation_id()
    {
        string? seen = null;
        var handler = new CorrelationIdHandler
        {
            InnerHandler = new StubHandler(r => seen = r.Headers.GetValues("X-Correlation-Id").Single())
        };
        CorrelationContext.Current = "out-1";
        await new HttpClient(handler).GetAsync("http://x/");

        Assert.Equal("out-1", seen);
    }

    private sealed class StubHandler(Action<HttpRequestMessage> onSend) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            onSend(request);
            return Task.FromResult(new HttpResponseMessage());
        }
    }
}
