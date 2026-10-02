using System.Text.Json;

namespace SuperTickets.Shared.Messaging;

public static class MessageJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}
