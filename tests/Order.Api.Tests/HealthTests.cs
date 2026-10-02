namespace Order.Api.Tests;

[Collection("infra")]
public class HealthTests(Infra infra)
{
    [Fact]
    public async Task Health_returns_200_and_correlation_id()
    {
        await using var factory = new OrderFactory(infra);
        var client = factory.CreateClient();
        var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Add("X-Correlation-Id", "abc-123");

        var response = await client.SendAsync(request);

        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("abc-123", response.Headers.GetValues("X-Correlation-Id").Single());
    }
}
