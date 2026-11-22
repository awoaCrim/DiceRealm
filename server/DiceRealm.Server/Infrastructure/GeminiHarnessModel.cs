using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

// Native non-streaming generateContent. The parent owns all requests, budgets and replay.
public sealed class GeminiHarnessModel(HttpClient http, IConfiguration configuration, ProviderBudget budget,
    ILogger<GeminiHarnessModel>? logger = null) : IHarnessModel
{
    private readonly HarnessProviderSettings settings = new(configuration);
    public bool Enabled => settings.Enabled;
    private sealed record NativeHistory(JsonElement[] Parts, string[] ToolCallIds);
    private sealed record ParsedParts(string Text, HarnessToolCall[] Calls);
    private sealed record NativeCall(string Name, string? Id);
    private sealed record Content(string Role, List<JsonElement> Parts);

    private (Uri Uri, string Identity, string Body) Wire(HarnessModelRequest request)
    {
        var uri = settings.Resolve("gemini");
        string identity = JsonFiles.Hash("gemini\n" + uri.AbsoluteUri + "\n" + settings.Model);
        string body;
        try
        {
            int imageBase64Bytes = HarnessProviderJson.ImageBase64Bytes(request.Messages);
            var payload = Build(request, identity);
            body = HarnessProviderJson.Serialize(payload);
            HarnessProviderJson.Bound(body, imageBase64Bytes, request.ContextPolicy);
        }
        catch (GameException ex) when (ex.Code == "harness_context_limit")
        { throw new HarnessModelNotSentException(HarnessModelRejection.ContextLimit); }
        catch (Exception ex) when (ex is GameException or JsonException or InvalidOperationException or ArgumentException or KeyNotFoundException)
        { throw new HarnessModelNotSentException(HarnessModelRejection.Contract); }
        using (var preflight = new HttpRequestMessage(HttpMethod.Post, uri)) settings.Authenticate(preflight);
        return (uri, identity, body);
    }

    public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
    {
        var (uri, identity, body) = Wire(request);
        if (request.BeforeProviderRequest is { } bind) await bind(identity, ct);
        return await HarnessProviderRetry.Execute(settings, budget, request, campaignId, Send, logger, ct);

        async Task<HarnessModelReply> Send(CancellationToken attemptCt)
        {
            using var message = new HttpRequestMessage(HttpMethod.Post, uri);
            settings.Authenticate(message);
            message.Content = new StringContent(body, Encoding.UTF8, "application/json");
            string stage = "send";
            int? status = null, responseBytes = null;
            string shape = "unread";
            try
            {
                using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, attemptCt);
                status = (int)response.StatusCode;
                stage = "status";
                HarnessProviderRetry.EnsureSuccess(response);
                stage = "read";
                byte[] bytes = await BoundedHttp.Read(response.Content, 256 * 1024, attemptCt);
                responseBytes = bytes.Length;
                stage = "json";
                using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
                var root = document.RootElement;
                shape = Shape(root);
                stage = "reply";
                HarnessJson.Validate(root);
                if (Field(root, "error").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)) throw Output();
                if (Field(Field(root, "promptFeedback"), "blockReason").ValueKind == JsonValueKind.String)
                    throw HarnessJson.Conflict("harness_model_blocked");
                var candidates = root.GetProperty("candidates");
                if (candidates.GetArrayLength() != 1) throw Output();
                var candidate = candidates[0];
                string? finish = candidate.GetProperty("finishReason").GetString();
                if (finish is "SAFETY" or "RECITATION" or "BLOCKLIST" or "PROHIBITED_CONTENT" or "SPII" or "IMAGE_SAFETY")
                    throw HarnessJson.Conflict("harness_model_blocked");
                if (finish == "MAX_TOKENS") throw HarnessJson.Conflict("harness_model_incomplete");
                if (finish != "STOP") throw Output();
                var content = candidate.GetProperty("content");
                if (content.GetProperty("role").GetString() != "model") throw Output();
                var parts = content.GetProperty("parts").EnumerateArray().Select(p => p.Clone()).ToArray();
                var parsed = ParseParts(parts, offered: request.Tools);
                var continuation = new HarnessProviderContinuation(identity,
                    HarnessJson.Element(new NativeHistory(parts, parsed.Calls.Select(c => c.Id).ToArray())));
                continuation.Validate();
                stage = "usage";
                // New history planning uses only actual response usage. Missing usage remains
                // unknown (ReportedInputTokens=null), never an estimate from serialized bytes.
                bool reportedOnly = request.ContextPolicy == HarnessContextCompactor.HistoryPolicy;
                int input = reportedOnly ? 0 : Encoding.UTF8.GetByteCount(body), output = reportedOnly ? 0 : Math.Max(1, bytes.Length);
                var usage = Field(root, "usageMetadata");
                if (usage.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
                {
                    if (usage.ValueKind != JsonValueKind.Object) throw Output();
                    input = Count(usage, "promptTokenCount", input, request.ContextPolicy == HarnessContextCompactor.HistoryPolicy);
                    output = checked(Count(usage, "candidatesTokenCount", output, request.ContextPolicy == HarnessContextCompactor.HistoryPolicy) +
                        Count(usage, "thoughtsTokenCount", 0, request.ContextPolicy == HarnessContextCompactor.HistoryPolicy));
                }
                if (request.ContextPolicy != HarnessContextCompactor.HistoryPolicy && (input > 1000000 || output > 1000000)) throw Output();
                budget.RecordTextUsage(campaignId, root, gemini: true);
                return new(parsed.Text, parsed.Calls, input, output) { ProviderContinuation = continuation,
                    ReportedInputTokens = Field(usage, "promptTokenCount").ValueKind == JsonValueKind.Number ? input : null };
            }
            catch (Exception ex)
            {
                // Closed labels and numeric counts only. Exception objects and native parts may contain private data.
                logger?.LogWarning("Harness Gemini failed: stage={Stage}, error={ErrorType}, status={Status}, bytes={ResponseBytes}, shape={Shape}",
                    stage, ex.GetType().Name, status, responseBytes, shape);
                throw;
            }
        }
    }

    private JsonElement Build(HarnessModelRequest request, string identity)
    {
        if (request.MaxTokens is < 0 or > 4096 || request.Messages is null || request.Messages.Length < 1 ||
            request.ContextPolicy != HarnessContextCompactor.HistoryPolicy && request.Messages.Length > 128 ||
            request.Tools is null || request.ProviderHistory is null || request.System is null || request.PriorProviderIdentities is null ||
            request.PriorProviderIdentities.Any(prior => prior != identity)) throw Output();
        var contents = new List<Content>();
        var outstanding = new Dictionary<string, NativeCall>(StringComparer.Ordinal);
        int assistant = 0;
        for (int messageIndex = 0; messageIndex < request.Messages.Length; messageIndex++)
        {
            var message = request.Messages[messageIndex];
            if (message is null || message.Content is null) throw Output();
            if (message.Role == "assistant")
            {
                if (outstanding.Count != 0 || assistant >= request.ProviderHistory.Length) throw Output();
                var exchange = request.ProviderHistory[assistant++];
                var saved = exchange.Continuation;
                if (saved is null || saved.Identity != identity) throw Output();
                saved.Validate();
                var native = HarnessJson.Read<NativeHistory>(saved.Data);
                if (native.ToolCallIds is null) throw Output();
                var parsed = ParseParts(native.Parts, native.ToolCallIds);
                if (parsed.Text != exchange.Reply.Text || message.Content != parsed.Text ||
                    !SameCalls(parsed.Calls, exchange.Reply.ToolCalls) || !SameCalls(parsed.Calls, message.ToolCalls ?? [])) throw Output();
                contents.Add(new("model", native.Parts.ToList()));
                int index = 0;
                foreach (var part in native.Parts)
                {
                    if (!part.TryGetProperty("functionCall", out var call)) continue;
                    string? nativeId = call.TryGetProperty("id", out var id) ? id.GetString() : null;
                    outstanding.Add(parsed.Calls[index++].Id, new(call.GetProperty("name").GetString()!, nativeId));
                }
            }
            else if (message.Role == "tool")
            {
                if (message.ToolCallId is null || !outstanding.Remove(message.ToolCallId, out var call) || call.Name != message.Name) throw Output();
                var response = new Dictionary<string, object>
                {
                    ["name"] = call.Name,
                    ["response"] = message.IsError == true ? new { error = HarnessProviderJson.Message(message, messageIndex == 0) } : (object)new { output = HarnessProviderJson.Message(message, messageIndex == 0) }
                };
                if (call.Id is not null) response["id"] = call.Id;
                var part = HarnessJson.Element(new { functionResponse = response });
                if (contents.LastOrDefault() is { Role: "user" } last && last.Parts.Any(p => p.TryGetProperty("functionResponse", out _)))
                    last.Parts.Add(part);
                else contents.Add(new("user", [part]));
            }
            else if (message.Role == "user")
            {
                if (outstanding.Count != 0) throw Output();
                var parts = new List<JsonElement> { HarnessJson.Element(new { text = HarnessProviderJson.Message(message, messageIndex == 0) }) };
                parts.AddRange(message.Images.Select(image => HarnessJson.Element(new
                {
                    inlineData = new { mimeType = image.MediaType, data = image.Base64 }
                })));
                contents.Add(new("user", parts));
            }
            else throw Output();
        }
        if (assistant != request.ProviderHistory.Length || outstanding.Count != 0) throw Output();
        var generation = new Dictionary<string, object> { ["candidateCount"] = 1, ["thinkingConfig"] = ThinkingConfig() };
        if (request.MaxTokens > 0) generation["maxOutputTokens"] = request.MaxTokens;
        return HarnessJson.Element(new
        {
            systemInstruction = new { parts = new[] { new { text = request.System } } }, contents,
            tools = new[] { new { functionDeclarations = request.Tools.Select(t => new { name = t.Name, description = t.Description, parametersJsonSchema = t.InputSchema }).ToArray() } },
            generationConfig = generation
        });
    }
    private Dictionary<string, object> ThinkingConfig()
    {
        var config = new Dictionary<string, object> { ["includeThoughts"] = settings.IncludeThoughts };
        if (settings.ThinkingLevel == "off") config["thinkingBudget"] = 0;
        else config["thinkingLevel"] = settings.ThinkingLevel;
        return config;
    }
    private static bool SameCalls(HarnessToolCall[] a, HarnessToolCall[] b) =>
        HarnessJson.Fingerprint(HarnessJson.Element(a)) == HarnessJson.Fingerprint(HarnessJson.Element(b));

    private static ParsedParts ParseParts(JsonElement[] parts, string[]? savedIds = null, HarnessToolDescriptor[]? offered = null)
    {
        if (parts is null || parts.Length is < 1 or > 128) throw Output();
        var text = new StringBuilder();
        var calls = new List<HarnessToolCall>();
        foreach (var part in parts)
        {
            if (part.ValueKind != JsonValueKind.Object || part.EnumerateObject().Any(p => p.Name is not ("text" or "functionCall" or "thought" or "thoughtSignature"))) throw Output();
            HarnessJson.Validate(part);
            bool signed = part.TryGetProperty("thoughtSignature", out var signature);
            if (signed)
            {
                string? value = signature.GetString();
                if (string.IsNullOrEmpty(value) || value.Length % 4 != 0 || value.Length > 120000 ||
                    value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('+' or '/' or '=')) ||
                    !Convert.TryFromBase64String(value, new byte[value.Length], out _)) throw Output();
            }
            bool thinking = part.TryGetProperty("thought", out var thought) && thought.GetBoolean();
            bool hasText = part.TryGetProperty("text", out var partText), hasCall = part.TryGetProperty("functionCall", out var call);
            if (hasText && hasCall || !hasText && !hasCall && !signed || thinking && !hasText) throw Output();
            if (hasText)
            {
                if (partText.ValueKind != JsonValueKind.String) throw Output();
                if (!thinking) text.Append(partText.GetString());
            }
            if (!hasCall) continue;
            if (calls.Count >= 8 || call.ValueKind != JsonValueKind.Object ||
                call.EnumerateObject().Any(p => p.Name is not ("name" or "args" or "id"))) throw Output();
            string? name = call.GetProperty("name").GetString();
            // A fresh response may only call tools this request actually offered. It must never be
            // checked against a historical catalog: newer contracts add tools (board v27) that no
            // frozen version contains. Replayed native history passes no offer list; Build instead
            // matches it against the saved reply identity via SameCalls, so valid old calls stand.
            if (name is null || offered is not null && !offered.Any(t => t.Name == name)) throw Output();
            var args = call.TryGetProperty("args", out var arguments) ? arguments.Clone() : HarnessJson.Element(new { });
            if (args.ValueKind != JsonValueKind.Object) throw Output();
            string? nativeId = call.TryGetProperty("id", out var idValue) ? idValue.GetString() : null;
            if (idValue.ValueKind != JsonValueKind.Undefined && (string.IsNullOrWhiteSpace(nativeId) || nativeId.Length > 128 ||
                nativeId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('_' or '-')))) throw Output();
            string id = savedIds is null ? nativeId ?? "gemini_" + Guid.NewGuid().ToString("N") :
                calls.Count < savedIds.Length ? savedIds[calls.Count] : throw Output();
            if (string.IsNullOrWhiteSpace(id) || id.Length > 128 || nativeId is not null && id != nativeId) throw Output();
            calls.Add(new(id, name!, args));
        }
        if (text.Length > 8192 || text.Length == 0 && calls.Count == 0 || calls.Select(c => c.Id).Distinct().Count() != calls.Count ||
            savedIds is not null && savedIds.Length != calls.Count) throw Output();
        return new(text.ToString(), calls.ToArray());
    }
    private static int Count(JsonElement usage, string field, int fallback, bool largeWindow = false)
    {
        if (!usage.TryGetProperty(field, out var value)) return fallback;
        int count = value.GetInt32();
        if (count < 0 || !largeWindow && count > 1000000) throw Output();
        return count;
    }
    private static GameException Output() => HarnessJson.Conflict("harness_model_output");
    private static JsonElement Field(JsonElement element, string name) => element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var field) ? field : default;
    private static string Shape(JsonElement root)
    {
        var candidates = Field(root, "candidates");
        int count = candidates.ValueKind == JsonValueKind.Array ? candidates.GetArrayLength() : 0;
        var first = count > 0 ? candidates[0] : default;
        var finish = Field(first, "finishReason");
        string label = finish.ValueKind == JsonValueKind.String ? finish.GetString() switch
        {
            "STOP" => "STOP", "MAX_TOKENS" => "MAX_TOKENS", "SAFETY" => "SAFETY", "MALFORMED_FUNCTION_CALL" => "MALFORMED_FUNCTION_CALL", _ => "other"
        } : finish.ValueKind.ToString();
        return $"root={root.ValueKind}, candidates={candidates.ValueKind}/{count}, finish={label}, parts={Field(Field(first, "content"), "parts").ValueKind}, usage={Field(root, "usageMetadata").ValueKind}";
    }
}
