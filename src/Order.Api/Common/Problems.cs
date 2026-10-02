namespace Order.Api.Common;

public static class Problems
{
    public static IResult Business(int status, string type, string title) =>
        Results.Problem(statusCode: status, title: title, type: type);

    public static IResult SoldOut() => Business(409, "sold_out", "Not enough tickets available.");

    public static IResult DependencyUnavailable() =>
        Business(503, "dependency_unavailable", "Inventory is unavailable.");
}
