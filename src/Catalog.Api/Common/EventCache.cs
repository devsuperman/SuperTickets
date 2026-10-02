using System.Text.Json;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Catalog.Api.Common;

public class CacheOptions
{
    public int TtlSeconds { get; set; } = 60;
}

/// <summary>Redis cache. Every failure is logged and treated as a miss; the cache is optional.</summary>
public class EventCache(IConnectionMultiplexer redis, IOptions<CacheOptions> options, ILogger<EventCache> log)
{
    const string VersionKey = "catalog:version";
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static string EventKey(Guid id) => $"catalog:event:{id}";

    public Task<EventDto?> GetEvent(Guid id) => Get<EventDto>(EventKey(id));
    public Task SetEvent(EventDto e) => Set(EventKey(e.Id), e);

    public async Task<EventDto[]?> GetList(string search)
    {
        var key = await ListKey(search);
        return key is null ? null : await Get<EventDto[]>(key);
    }

    public async Task SetList(string search, EventDto[] events)
    {
        var key = await ListKey(search);
        if (key is not null) await Set(key, events);
    }

    /// <summary>Admin write: drop the event key and bump the list version.</summary>
    public async Task Invalidate(Guid id)
    {
        try
        {
            var db = redis.GetDatabase();
            await db.KeyDeleteAsync(EventKey(id));
            await db.StringIncrementAsync(VersionKey);
        }
        catch (Exception ex) { log.LogWarning(ex, "Redis unavailable, cache not invalidated"); }
    }

    async Task<string?> ListKey(string search)
    {
        try
        {
            var v = await redis.GetDatabase().StringGetAsync(VersionKey);
            return $"catalog:v{(v.HasValue ? (long)v : 0)}:events:{search.ToLowerInvariant()}";
        }
        catch (Exception ex) { log.LogWarning(ex, "Redis unavailable, skipping cache"); return null; }
    }

    async Task<T?> Get<T>(string key)
    {
        try
        {
            var v = await redis.GetDatabase().StringGetAsync(key);
            return v.HasValue ? JsonSerializer.Deserialize<T>((string)v!, Json) : default;
        }
        catch (Exception ex) { log.LogWarning(ex, "Redis unavailable, reading Postgres"); return default; }
    }

    async Task Set<T>(string key, T value)
    {
        try
        {
            var ttl = options.Value.TtlSeconds * (0.9 + Random.Shared.NextDouble() * 0.2);
            await redis.GetDatabase().StringSetAsync(key, JsonSerializer.Serialize(value, Json), TimeSpan.FromSeconds(ttl));
        }
        catch (Exception ex) { log.LogWarning(ex, "Redis unavailable, value not cached"); }
    }
}
