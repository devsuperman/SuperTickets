namespace Catalog.Api.Tests;

[Collection("infra")]
public class HealthTests(Infra infra)
{
    [Fact]
    public async Task Health_returns_200_and_correlation_id()
    {
        await using var f = new CatalogFactory(infra);
        var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Add("X-Correlation-Id", "abc-123");

        var response = await f.CreateClient().SendAsync(request);

        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("abc-123", response.Headers.GetValues("X-Correlation-Id").Single());
    }

    [Fact]
    public async Task Health_is_200_when_redis_is_down()
    {
        await using var f = new CatalogFactory(infra, redis: "localhost:1");
        var response = await f.CreateClient().GetAsync("/health");
        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
    }
}
