using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record CreateHarnessCampaignRequest(string Name, string CharacterName = "",
    [property: System.Text.Json.Serialization.JsonRequired] AdventureDocument Adventure = null!,
    [property: System.Text.Json.Serialization.JsonRequired] HarnessPreset Preset = null!,
    HarnessSkill[]? Skills = null, string TemplateId = CharacterEngine.Fighter, CharacterCreationChoices? Creation = null, CharacterBuild? Build = null);
public sealed record HarnessInputRequest(string RequestId, int ExpectedVersion, string Text);
public sealed record HarnessResumeRequest(string RequestId, int ExpectedVersion, string Text = "");
public sealed record HarnessWait(string Kind, string Id, string Question = "");
public sealed record HarnessRunView(string Id, string Status, int Version, HarnessWait? Wait, string Text, string Error,
    int ModelAttempts, int ToolSteps, bool Replayed = false, string Notice = "", string Input = "", string IntentId = "",
    HarnessRunBinding? Binding = null, HarnessProgressStep[]? Progress = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? BattleSessionId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? Role = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? ParentRunId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? Recovery = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    bool Opening = false,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    bool FirstCombatInput = false);
public sealed record HarnessRunBinding(string PresetId, int PresetVersion, string ProfileHash, string[] SkillIds);
public sealed record HarnessProgressStep(int Number, string Kind, string Status, string Tool, int? Version, string WaitKind);
public sealed record HarnessActiveRuns(HarnessRunView[] Runs)
{
    // Other seats whose action the host is processing right now. Only the player's adventure
    // board carries it; the harness endpoint's shape is unchanged.
    [System.Text.Json.Serialization.JsonIgnore] public string[] OthersActing { get; init; } = [];
}
public sealed record HarnessAuthorization(string ActorId, int Version, HarnessProfile Profile, bool OfflineTrial, bool OpeningNeeded = false, string? TimelineId = null);
public sealed record HarnessToolDescriptor(string Name, string Description, JsonElement InputSchema);
public sealed record HarnessLimits(int MaxModelCalls = 16, int MaxToolCalls = 32, int MaxOutputCharacters = 8192, int MaxContextBytes = 131072, bool ProviderDefaultOutput = false);
public sealed record HarnessExecution(string ExecutionId, string SystemPrompt, string[] Turns, HarnessToolDescriptor[] Tools, HarnessLimits Limits,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? ContextPolicy = null);
public sealed record HarnessCallback(string Id, string Kind, int Turn, int Sequence, JsonElement Payload);
public sealed record HarnessToolCall(string Id, string Name, JsonElement Arguments);
public sealed record HarnessImage(string MediaType, string Base64);
public sealed record HarnessChatMessage(string Role, string Content, HarnessToolCall[]? ToolCalls = null,
    string? ToolCallId = null, string? Name = null, bool? IsError = null)
{
    // Parent-owned images for the latest execution_state, never Node/HTTP input or transcript data.
    [System.Text.Json.Serialization.JsonIgnore]
    public HarnessImage[] Images { get; init; } = [];
}
public sealed record HarnessModelRequest(string System, HarnessChatMessage[] Messages, HarnessToolDescriptor[] Tools, int MaxTokens)
{
    // Selected by the parent from the frozen Run contract, never accepted from Node.
    [System.Text.Json.Serialization.JsonIgnore]
    public string? ContextPolicy { get; init; }
    // Parent-owned history, never accepted from or sent to the Node wire/HTTP clients.
    [System.Text.Json.Serialization.JsonIgnore]
    public HarnessModelExchange[] ProviderHistory { get; init; } = [];
    // Retain identity binding even if compaction omits every old native assistant exchange.
    [System.Text.Json.Serialization.JsonIgnore]
    public string[] PriorProviderIdentities { get; init; } = [];
    // Trusted live-slot callback. Each extra HTTP attempt reauthorizes and persists its count;
    // never supplied by Node, HTTP, saved records or the provider itself.
    [System.Text.Json.Serialization.JsonIgnore]
    public Func<CancellationToken, Task>? BeforeProviderRetry { get; init; }
    // Freeze selected endpoint/model identity before the first possible send, including
    // requests whose response is lost. This is never provider/wire supplied authority.
    [System.Text.Json.Serialization.JsonIgnore]
    public Func<string, CancellationToken, Task>? BeforeProviderRequest { get; init; }
}
public sealed record HarnessModelReply(string Text, HarnessToolCall[] ToolCalls, int InputTokens, int OutputTokens)
{
    // Null means absent/legacy fallback usage. Only actual response usage informs later history planning.
    [System.Text.Json.Serialization.JsonIgnore]
    public int? ReportedInputTokens { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public HarnessProviderContinuation? ProviderContinuation { get; init; }
}
public sealed record HarnessModelExchange(HarnessModelReply Reply, HarnessProviderContinuation? Continuation);
public sealed record HarnessProviderContinuation(string Identity, JsonElement Data)
{
    public void Validate()
    {
        if (Identity is null || Identity.Length != 64 || Identity.Any(c => !char.IsAsciiHexDigit(c)) || Data.ValueKind != JsonValueKind.Object)
            throw HarnessJson.Conflict("harness_model_output");
        HarnessJson.Validate(Data);
        HarnessJson.Bound(this);
    }
}
public sealed record HarnessToolRequest(string Name, JsonElement Arguments, string ToolCallId);
public sealed record HarnessToolReply(string Content, bool IsError = false, bool Stop = false);
public sealed record HarnessToolOutcome(int Version, HarnessToolReply Reply, HarnessWait? Wait = null, string[]? OfferedIds = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string[]? OfferedMemoryIds = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CompletedNarrative = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? DelegatedSessionId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    bool? ContinueCombat = null);
public sealed record HarnessCompletion(bool Stopped, string Text, int ModelCalls, int ToolCalls);
public sealed record HarnessContinuation(int Version, string Text, HarnessWait? Wait = null, bool Cancelled = false);

public interface IHarnessRuntime
{
    // Local preparation only: no execution, campaign state or model callback.
    Task Prepare(CancellationToken ct) => Task.CompletedTask;
    Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct);
}
public interface IHarnessModel
{
    bool Enabled { get; }
    IHarnessModel Capture() => this;
    Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct);
}

// Only a trusted model adapter may assert rejection before generation was sent.
// This is an in-process port contract, never evidence derived from model/wire error strings.
public enum HarnessModelRejection { Disabled, Endpoint, Contract, ContextLimit, Quota, Credentials, TransportLimit, BudgetUnknown, ContextPreparation }
public sealed class HarnessModelNotSentException(HarnessModelRejection reason) : Exception("Model generation rejected before send.")
{
    public string Code { get; } = reason switch
    {
        HarnessModelRejection.Disabled => "harness_model_disabled",
        HarnessModelRejection.Endpoint => "harness_model_endpoint",
        HarnessModelRejection.Credentials => "harness_model_credentials",
        HarnessModelRejection.Contract => "harness_model_contract",
        HarnessModelRejection.ContextLimit => "harness_context_limit",
        HarnessModelRejection.TransportLimit => "harness_transport_limit",
        HarnessModelRejection.BudgetUnknown => "harness_context_budget_unknown",
        HarnessModelRejection.ContextPreparation => "harness_context_preparation_failed",
        HarnessModelRejection.Quota => "harness_model_quota_exceeded",
        _ => throw new ArgumentOutOfRangeException(nameof(reason))
    };
}

// One strict parser for untrusted model/wire/tool data; stable canonical hashes ignore object
// property order only, never text, array/tool order, number values or protocol fields.
public static class HarnessJson
{
    public static readonly JsonSerializerOptions Options = new(JsonFiles.Options)
    { WriteIndented = false, PropertyNameCaseInsensitive = false, RespectRequiredConstructorParameters = true, MaxDepth = 32 };
    public static string ProfileHash(HarnessPreset preset, HarnessSkill[] skills) => JsonFiles.Hash(Serialize(new { preset, skills }));
    public static JsonElement Element<T>(T value) => JsonSerializer.SerializeToElement(value, Options);
    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
    public static T Read<T>(JsonElement value)
    {
        Validate(value);
        try { return value.Deserialize<T>(Options) ?? throw new JsonException(); }
        catch (JsonException) { throw new GameException("harness_invalid_payload", "运行器或工具参数不符合合同。"); }
    }
    public static void Validate(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in value.EnumerateObject())
            {
                if (!keys.Add(p.Name)) throw new GameException("harness_invalid_payload", "重复的 JSON 字段。");
                Validate(p.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array) foreach (var child in value.EnumerateArray()) Validate(child);
    }
    public static string Fingerprint(JsonElement value)
    {
        Validate(value);
        JsonNode? Sort(JsonElement x) => x.ValueKind switch
        {
            JsonValueKind.Object => new JsonObject(x.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal)
                .Select(p => new KeyValuePair<string, JsonNode?>(p.Name, Sort(p.Value)))),
            JsonValueKind.Array => new JsonArray(x.EnumerateArray().Select(Sort).ToArray()),
            _ => JsonNode.Parse(x.GetRawText())
        };
        return JsonFiles.Hash(Sort(value)?.ToJsonString() ?? "null");
    }
    public static void Bound<T>(T value, int maximum = 131072)
    {
        if (Encoding.UTF8.GetByteCount(Serialize(value)) > maximum)
            throw new GameException("harness_context_limit", "运行上下文超过限制；不会自动压缩或再次外发。", 409);
    }
    public static GameException Conflict(string code) => new(code, "运行无法继续。请查看已保存的结果；不会自动重试、重掷或替换版本。", 409);
}
