namespace Catalog.Api.Common;

public record EventDto(Guid Id, string Name, string Venue, DateTime StartsAt, int TotalTickets, decimal Price);

/// <summary>POST/PUT body: EventDto without id.</summary>
public record EventInput(string? Name, string? Venue, DateTime? StartsAt, int? TotalTickets, decimal? Price);

public static class EventValidator
{
    public static Dictionary<string, string[]> Validate(EventInput i, DateTime nowUtc)
    {
        var errors = new Dictionary<string, string[]>();
        var name = i.Name?.Trim() ?? "";
        var venue = i.Venue?.Trim() ?? "";
        if (name.Length is < 1 or > 200) errors["name"] = ["Name is required, 1-200 characters."];
        if (venue.Length is < 1 or > 200) errors["venue"] = ["Venue is required, 1-200 characters."];
        if (i.StartsAt is not { } s || ToUtc(s) <= nowUtc) errors["startsAt"] = ["StartsAt must be in the future."];
        if (i.TotalTickets is not (>= 1 and <= 100_000)) errors["totalTickets"] = ["TotalTickets must be between 1 and 100000."];
        if (i.Price is not { } p || p < 0.01m || p > 100_000m || decimal.Round(p, 2) != p)
            errors["price"] = ["Price must be between 0.01 and 100000 with at most 2 decimals."];
        return errors;
    }

    public static DateTime ToUtc(DateTime d) =>
        d.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(d, DateTimeKind.Utc) : d.ToUniversalTime();
}
