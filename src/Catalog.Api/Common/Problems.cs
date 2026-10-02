namespace Catalog.Api.Common;

public static class Problems
{
    public static IResult Business(int status, string type, string title) =>
        Results.Problem(statusCode: status, title: title, type: type);

    public static IResult DependencyUnavailable() =>
        Business(503, "dependency_unavailable", "Inventory is unavailable.");

    public static IResult CapacityBelowSold() =>
        Business(409, "capacity_below_sold", "totalTickets is below tickets already reserved or sold.");
}
