using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;

namespace DiceRealm.Server.Infrastructure;

// Explicit separate opt-in. Configured retries share the live slot, durable budget and owner cancellation.
public sealed class OpenAiHarnessModel(HttpClient http, IConfiguration configuration, ProviderBudget budget,
    ILogger<OpenAiHarnessModel>? logger = null) : IHarnessModel
{
    private readonly HarnessProviderSettings settings = new(configuration);
    public bool Enabled => settings.Enabled;
    public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
    {
        var uri = settings.Resolve("openai-chat");
        string identity = JsonFiles.Hash("openai-chat\n" + uri.AbsoluteUri + "\n" + settings.Model);
        int imageBase64Bytes = HarnessProviderJson.ImageBase64Bytes(request.Messages);
        if (request.PriorProviderIdentities.Any(prior => prior != identity) || request.ProviderHistory.Any(h => h.Continuation is not null))
            throw new HarnessModelNotSentException(HarnessModelRejection.Contract);
        var messages = new List<object> { new { role = "system", content = request.System } };
        for (int messageIndex = 0; messageIndex < request.Messages.Length; messageIndex++)
        {
            var m = request.Messages[messageIndex];
            if (m.Role == "user")
            {
                string text = HarnessProviderJson.Message(m, messageIndex == 0);
                if (m.Images.Length == 0) messages.Add(new { role = "user", content = text });
                else
                {
                    var content = new List<object> { new { type = "text", text } };
                    content.AddRange(m.Images.Select(image => (object)new
                    {
                        type = "image_url", image_url = new { url = "data:" + image.MediaType + ";base64," + image.Base64 }
                    }));
                    messages.Add(new { role = "user", content });
                }
            }
            else if (m.Role == "tool") messages.Add(new { role = "tool", content = HarnessProviderJson.Message(m, messageIndex == 0), tool_call_id = m.ToolCallId });
            else if (m.Role == "assistant")
            {
                if (m.ToolCalls is { Length: > 0 }) messages.Add(new { role = "assistant", content = m.Content,
                    tool_calls = m.ToolCalls.Select(t => new { id = t.Id, type = "function", function = new { name = t.Name, arguments = HarnessProviderJson.Serialize(t.Arguments) } }).ToArray() });
                else messages.Add(new { role = "assistant", content = m.Content });
            }
            else throw new HarnessModelNotSentException(HarnessModelRejection.Contract);
        }
        var payload = new Dictionary<string, object>
        {
            ["model"] = settings.Model, ["messages"] = messages, ["stream"] = false,
            ["tools"] = request.Tools.Select(t => new { type = "function", function = new { name = t.Name, description = t.Description, parameters = t.InputSchema } }).ToArray()
        };
        if (request.MaxTokens > 0) payload["max_tokens"] = request.MaxTokens;
        if (settings.ThinkingLevel != "off") payload["reasoning_effort"] = settings.ThinkingLevel;
        string body = HarnessProviderJson.Serialize(payload);
        HarnessProviderJson.Bound(body, imageBase64Bytes, request.ContextPolicy);
        using (var preflight = new HttpRequestMessage(HttpMethod.Post, uri)) settings.Authenticate(preflight);
        if (request.BeforeProviderRequest is { } bind) await bind(identity, ct);
        return await HarnessProviderRetry.Execute(settings, budget, request, campaignId, Send, logger, ct);

        async Task<HarnessModelReply> Send(CancellationToken attemptCt)
        {
            using var message = new HttpRequestMessage(HttpMethod.Post, uri);
            settings.Authenticate(message);
            message.Content = new StringContent(body, Encoding.UTF8, "application/json");
            string stage = "send";
            int? status = null, responseBytes = null;
            var shape = ResponseShape.Capture(default);
            try
            {
                using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, attemptCt);
                status = (int)response.StatusCode; stage = "status";
                HarnessProviderRetry.EnsureSuccess(response);
                stage = "read";
                var bytes = await BoundedHttp.Read(response.Content, 256 * 1024, attemptCt);
                responseBytes = bytes.Length; stage = "json";
                using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
                var root = document.RootElement; shape = ResponseShape.Capture(root); stage = "reply";
                HarnessJson.Validate(root);
                var choices = root.GetProperty("choices");
                if (choices.GetArrayLength() != 1) throw HarnessJson.Conflict("harness_model_output");
                var value = choices[0].GetProperty("message");
                string? finish = choices[0].GetProperty("finish_reason").GetString();
                if (finish == "content_filter" || value.TryGetProperty("refusal", out var refusal) && refusal.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(refusal.GetString()))
                    throw HarnessJson.Conflict("harness_model_blocked");
                if (finish == "length") throw HarnessJson.Conflict("harness_model_incomplete");
                if (finish is not ("stop" or "tool_calls")) throw HarnessJson.Conflict("harness_model_output");
                string text = value.TryGetProperty("content", out var content) && content.ValueKind != JsonValueKind.Null ? content.GetString() ?? "" : "";
                var tools = new List<HarnessToolCall>();
                // Text-only compatible responses may explicitly return null instead of omitting the list.
                if (value.TryGetProperty("tool_calls", out var calls) && calls.ValueKind != JsonValueKind.Null)
                {
                    if (calls.GetArrayLength() > 8) throw HarnessJson.Conflict("harness_model_output");
                    foreach (var call in calls.EnumerateArray())
                    {
                        if (call.GetProperty("type").GetString() != "function") throw HarnessJson.Conflict("harness_model_output");
                        var function = call.GetProperty("function");
                        using var args = JsonDocument.Parse(function.GetProperty("arguments").GetString()!, new JsonDocumentOptions { MaxDepth = 32 });
                        HarnessJson.Validate(args.RootElement);
                        tools.Add(new(call.GetProperty("id").GetString()!, function.GetProperty("name").GetString()!, args.RootElement.Clone()));
                    }
                }
                stage = "usage";
                // New history planning records actual usage only; legacy accounting stays frozen.
                bool reportedOnly = request.ContextPolicy == HarnessContextCompactor.HistoryPolicy;
                int inputTokens = reportedOnly ? 0 : Encoding.UTF8.GetByteCount(body);
                int outputTokens = reportedOnly ? 0 : Math.Max(1, bytes.Length);
                if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
                {
                    if (usage.TryGetProperty("prompt_tokens", out var input)) inputTokens = input.GetInt32();
                    if (usage.TryGetProperty("completion_tokens", out var output)) outputTokens = output.GetInt32();
                }
                if (text.Length > 8192 || text.Length == 0 && tools.Count == 0 || inputTokens < 0 || outputTokens < 0 ||
                    request.ContextPolicy != HarnessContextCompactor.HistoryPolicy && (inputTokens > 1000000 || outputTokens > 1000000) ||
                    tools.Any(t => string.IsNullOrWhiteSpace(t.Id) || t.Id.Length > 128 || !request.Tools.Any(d => d.Name == t.Name) || t.Arguments.ValueKind != JsonValueKind.Object) ||
                    tools.Select(t => t.Id).Distinct().Count() != tools.Count) throw HarnessJson.Conflict("harness_model_output");
                budget.RecordTextUsage(campaignId, root);
                return new(text, tools.ToArray(), inputTokens, outputTokens)
                { ReportedInputTokens = usage.ValueKind == JsonValueKind.Object && usage.TryGetProperty("prompt_tokens", out var reported) &&
                    reported.ValueKind == JsonValueKind.Number ? inputTokens : null };
            }
            catch (Exception ex)
            {
                // Shape contains only controlled labels/counts; never pass an exception object,
                // provider text, property names supplied by the provider, headers or request data.
                logger?.LogWarning("Harness provider failed: stage={Stage}, error={ErrorType}, status={Status}, bytes={ResponseBytes}, shape={Shape}",
                    stage, ex.GetType().Name, status, responseBytes, shape);
                throw;
            }
        }
    }
    private sealed record ResponseShape(string Root, string Choices, int ChoiceCount, string Finish,
        string Message, string Content, string ToolCalls, string Usage, string InputUsage, string OutputUsage, string Error)
    {
        private static JsonElement Field(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object &&
            value.TryGetProperty(name, out var field) ? field : default;
        public static ResponseShape Capture(JsonElement root)
        {
            var choices = Field(root, "choices"); int count = choices.ValueKind == JsonValueKind.Array ? choices.GetArrayLength() : 0;
            var choice = count > 0 ? choices[0] : default;
            var message = Field(choice, "message"); var usage = Field(root, "usage"); var finish = Field(choice, "finish_reason");
            string finishLabel = finish.ValueKind == JsonValueKind.String ? finish.GetString() switch
            {
                "stop" => "stop", "tool_calls" => "tool_calls", "length" => "length",
                "content_filter" => "content_filter", "function_call" => "function_call", _ => "other"
            } : finish.ValueKind.ToString();
            return new(root.ValueKind.ToString(), choices.ValueKind.ToString(), count, finishLabel,
                message.ValueKind.ToString(), Field(message, "content").ValueKind.ToString(), Field(message, "tool_calls").ValueKind.ToString(),
                usage.ValueKind.ToString(), Field(usage, "prompt_tokens").ValueKind.ToString(), Field(usage, "completion_tokens").ValueKind.ToString(),
                Field(root, "error").ValueKind.ToString());
        }
    }
}
