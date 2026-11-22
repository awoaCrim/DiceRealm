using System.Text.Json;
using System.Text.Json.Nodes;

namespace DiceRealm.Server.Infrastructure;

// Host story traces never transport private reasoning or opaque provider continuations.
// The separately authorized diagnostic log keeps its original bytes unchanged.
internal static class ModelRequestPresentation
{
    internal static ModelRequestDetail Public(ModelRequestDetail detail) => detail with
    {
        RequestBody = PublicBody(detail.RequestBody), ResponseBody = PublicBody(detail.ResponseBody)
    };
    private static JsonObject Pick(JsonObject source, params string[] names)
    {
        var result = new JsonObject();
        foreach (string name in names) if (source.TryGetPropertyValue(name, out var value)) result[name] = value?.DeepClone();
        return result;
    }
    private static JsonArray Map(JsonNode? source, Func<JsonObject, JsonNode?> project) => new(
        (source as JsonArray ?? []).OfType<JsonObject>().Select(project).Where(n => n is not null).ToArray());
    private static JsonArray Parts(JsonNode? source) => Map(source, part =>
    {
        if (part["thought"] is JsonValue flag && flag.TryGetValue<bool>(out var thought) && thought) return null;
        return part.ContainsKey("text") ? Pick(part, "text") : part.ContainsKey("functionCall") ? Pick(part, "functionCall") :
            part.ContainsKey("functionResponse") ? Pick(part, "functionResponse") : null;
    });
    private static JsonObject Message(JsonObject source)
    {
        var result = Pick(source, "role", "tool_calls", "tool_call_id");
        result["content"] = source["content"] is JsonArray parts
            ? Map(parts, part => part["type"]?.GetValue<string>() == "text" ? Pick(part, "type", "text") : null)
            : source["content"] is JsonValue text && text.TryGetValue<string>(out _) ? text.DeepClone() : null;
        return result;
    }
    private static string PublicBody(string text)
    {
        try
        {
            if (JsonNode.Parse(text) is not JsonObject body) return "";
            JsonObject result;
            if (body.ContainsKey("contents") || body.ContainsKey("systemInstruction"))
            {
                result = Pick(body, "tools", "generationConfig", "toolConfig", "safetySettings");
                result["systemInstruction"] = new JsonObject { ["parts"] = Parts((body["systemInstruction"] as JsonObject)?["parts"]) };
                result["contents"] = Map(body["contents"], c => new JsonObject { ["role"] = c["role"]?.DeepClone(), ["parts"] = Parts(c["parts"]) });
            }
            else if (body["messages"] is JsonArray)
            {
                result = Pick(body, "model", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "response_format", "reasoning_effort");
                result["messages"] = Map(body["messages"], Message);
            }
            else if (body["candidates"] is JsonArray)
            {
                result = Pick(body, "usageMetadata");
                result["candidates"] = Map(body["candidates"], c => new JsonObject { ["finishReason"] = c["finishReason"]?.DeepClone(),
                    ["content"] = new JsonObject { ["parts"] = Parts((c["content"] as JsonObject)?["parts"]) } });
            }
            else if (body["choices"] is JsonArray)
            {
                result = Pick(body, "usage");
                result["choices"] = Map(body["choices"], c => new JsonObject { ["finish_reason"] = c["finish_reason"]?.DeepClone(), ["message"] = Message(c["message"] as JsonObject ?? []) });
            }
            else return "";
            return result.ToJsonString();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException) { return ""; }
    }
}
