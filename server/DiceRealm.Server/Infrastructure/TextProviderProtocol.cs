using System.Text;
using System.Text.Json;

namespace DiceRealm.Server.Infrastructure;

// Shared wire format for helper text, preparation and its connection probe.
// Reuses the main provider's endpoint/authentication rules; owns no prompts or retries.
internal sealed class TextProviderProtocol
{
    private readonly HarnessProviderSettings settings;
    internal TextProviderProtocol(IConfiguration configuration)
    {
        string endpoint = configuration["TextAi:Endpoint"] ?? "https://api.openai.com/v1/chat/completions";
        settings = new(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["HarnessAi:Endpoint"] = endpoint,
            ["HarnessAi:BaseUrl"] = endpoint is "gemini" or "openai-chat" ? configuration["TextAi:BaseUrl"] : "",
            ["HarnessAi:Model"] = configuration["TextAi:Model"],
            ["HarnessAi:ApiKey"] = configuration["TextAi:ApiKey"]
        }).Build());
    }
    internal HarnessProviderSettings Settings => settings;
    internal string Model => settings.Model;
    internal bool Enabled => settings.Enabled;
    internal bool IsGemini => settings.IsGemini;

    internal HttpRequestMessage CreateRequest(string[] systemPrompts, string userText, bool jsonOutput = true)
    {
        object body;
        if (IsGemini)
        {
            var gemini = new Dictionary<string, object>
            {
                ["contents"] = new[] { new { role = "user", parts = new[] { new { text = userText } } } }
            };
            if (systemPrompts.Length > 0)
                gemini["systemInstruction"] = new { parts = systemPrompts.Select(text => new { text }).ToArray() };
            if (jsonOutput) gemini["generationConfig"] = new { responseMimeType = "application/json" };
            body = gemini;
        }
        else
        {
            var messages = systemPrompts.Select(content => new { role = "system", content }).ToList();
            messages.Add(new { role = "user", content = userText });
            var openAi = new Dictionary<string, object> { ["model"] = Model, ["messages"] = messages };
            if (jsonOutput) openAi["response_format"] = new { type = "json_object" };
            body = openAi;
        }
        var request = new HttpRequestMessage(HttpMethod.Post, settings.Resolve(IsGemini ? "gemini" : "openai-chat"));
        try
        {
            settings.Authenticate(request);
            request.Content = new StringContent(JsonSerializer.Serialize(body, JsonFiles.Options), Encoding.UTF8, "application/json");
            return request;
        }
        catch { request.Dispose(); throw; }
    }

    internal static string ReadText(JsonElement root, bool gemini)
    {
        string? text;
        if (gemini)
        {
            var candidate = root.GetProperty("candidates")[0];
            if (candidate.TryGetProperty("finishReason", out var reason) && reason.GetString() != "STOP")
                throw new InvalidDataException("Gemini text response did not finish normally.");
            text = string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray()
                .Where(part => !part.TryGetProperty("thought", out var thought) || thought.ValueKind != JsonValueKind.True)
                .Select(part => part.TryGetProperty("text", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : ""));
        }
        else text = root.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
        return !string.IsNullOrWhiteSpace(text) ? text : throw new InvalidDataException("Empty text provider response.");
    }
}
