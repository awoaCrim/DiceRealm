using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// 中立业务 DTO：只表达战役、内容准备、行动、回答、本人确认和结果。
// 运行器、工具、绑定、模型次数与哈希属于服务端内部，不进入这些边界。
// 内容版本（草稿 / 已发布 / 已启用）属于内容准备本身，保留。
public sealed record AdventureActionRequest(string RequestId, int ExpectedVersion, string Text);

public sealed record AdventureConfirmation(string Kind, string WaitId, string Prompt);

public sealed record AdventureSessionView(string SessionId, string Phase, string Question, AdventureConfirmation? Confirmation,
    string Outcome, string Notice, string ActionText, bool Replayed, string ActionId = "",
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? BattleSessionId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? Role = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? ParentSessionId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    bool Opening = false);

// Host-only progress includes the submitted action; step bodies are loaded separately.
// Neither projection exposes provider continuation/thought metadata or private run internals.
public sealed record AdventureProgressActor(string Id, string Name);
public sealed record AdventureRunProgress(string Id, string ActorId, string ActorName, string Status, bool Succeeded,
    HarnessProgressStep[] Steps, string ActionId = "", int Version = 0, string Input = "",
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? Recovery = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? Notice = null);
public sealed record AdventureProgress(AdventureRunProgress[] Runs);
public sealed record AdventureStepDetail(string RunId, string ActionId, string ActorId, int Number, string Kind,
    string Status, string Tool, System.Text.Json.JsonElement? Request, System.Text.Json.JsonElement? Response);

public sealed record AdventureBoard(AdventureSessionView[] Sessions)
{
    // Teammates (actor ids) whose action the host is working on now, so a seat can see it before
    // sending into a busy host. Absent when there are none.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string[]? OthersActing { get; init; }
}

public sealed record AdventureMemoryEntry(string ActionText, string Outcome, int OriginSequence, bool Corrected);

public sealed record AdventureMemory(AdventureMemoryEntry[] Entries);

public sealed record AdventureMethod(string Id, string Description, string Content);

// Fingerprint 只是客户端对比服务器内容的基线；内容标识/版本是内容业务元数据，随请求显式传输，
// 不隐藏，也不在主界面展示。
public sealed record AdventureContentSettings(string ContentId, int ContentVersion, string Prompt,
    AdventureMethod[] Methods, string Fingerprint,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CombatPrompt = null);

public sealed record AdventureSettingsView(int SettingsVersion, int ActiveRevision, int LatestRevision,
    AdventureContentSettings Draft, AdventureContentSettings Active, bool MatchesActive, string? DefaultCombatPrompt = null);

public sealed record AdventureSettingsPreviewRequest(string ContentId, int ContentVersion, string Prompt,
    AdventureMethod[] Methods,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CombatPrompt = null);

public sealed record AdventureSettingsPreview(string ContentId, int ContentVersion, string Prompt, AdventureMethod[] Methods,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CombatPrompt = null);

// 内容标识/版本由客户端随草稿冻结并原样重传；服务端不得从可变当前状态重建已发送命令的身份。
public sealed record SaveAdventureSettingsDraftRequest(string RequestId, int ExpectedSettingsVersion,
    string ContentId, int ContentVersion, string Prompt, AdventureMethod[] Methods,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CombatPrompt = null);

public sealed record PublishAdventureSettingsRequest(string RequestId, int ExpectedSettingsVersion);

public sealed record ActivateAdventureSettingsRequest(string RequestId, int ExpectedSettingsVersion, int Revision);

public sealed record AdventureSettingsResult(AdventureSettingsView Settings, bool Replayed);

public sealed record AdventureSettingsHistoryItem(int Revision, DateTimeOffset SavedAt);

public sealed record AdventureSettingsHistory(AdventureSettingsHistoryItem[] Items, int? NextBefore);

public sealed record AdventureSettingsRevision(int Revision, DateTimeOffset SavedAt, string Prompt, AdventureMethod[] Methods,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CombatPrompt = null);

public sealed record CreateCampaignFromContentRequest(string Name, string CharacterName = "",
    [property: System.Text.Json.Serialization.JsonRequired] AdventureDocument Adventure = null!,
    [property: System.Text.Json.Serialization.JsonRequired] string Prompt = "", AdventureMethod[]? Methods = null, string TemplateId = CharacterEngine.Fighter,
    CharacterCreationChoices? Creation = null, CharacterBuild? Build = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CombatPrompt = null);

// 业务阶段投影。`unconfirmed` 表示已有模型步骤开始但没有可靠回执：禁止补发，也不回滚已提交效果。
public static class AdventureSessions
{
    public const string Working = "working";
    public const string Delegated = "delegated";
    public const string NeedsAnswer = "needsAnswer";
    public const string NeedsConfirmation = "needsConfirmation";
    public const string Ready = "ready";
    public const string Unconfirmed = "unconfirmed";
    public const string Stopping = "stopping";
    public const string Stopped = "stopped";
    public const string Failed = "failed";
    public const string Blocked = "blocked";
    public const string Done = "done";

    public static bool HasUnconfirmedSteps(HarnessRunView run) =>
        run.Progress?.Any(step => step.Kind == "model" && step.Status == "started") ?? false;

    public static string Phase(HarnessRunView run) => run.Recovery == "blocked" ? Blocked : run.Recovery is "delegation" or "return" ? Ready : run.Status switch
    {
        "running" => Working,
        "delegated" => Delegated,
        "waiting" => run.Wait?.Kind == "player" ? NeedsAnswer : NeedsConfirmation,
        "interrupted" => HasUnconfirmedSteps(run) ? Unconfirmed : Ready,
        "unknown" => Unconfirmed,
        "cancelling" => Stopping,
        "cancelled" => Stopped,
        "failed" => Failed,
        _ => Done
    };

    // 停止披露只说明业务后果与去哪个本人入口处理；不把 rolls/respond、decision=cancel、
    // intentId/rollId 等内核协议字段展示给普通用户（原兼容 API 仍保留原文）。
    public static string ContextFailureNotice(string error) => error switch
    {
        "harness_transport_limit" => "后续回应已暂停：本次资料超过服务端传输容量，未发送这一次模型请求。已保存的行动与骰点保留；请让管理员检查上下文处理，不要重复已执行的步骤。",
        "harness_context_budget_unknown" => "后续回应已暂停：无法确认当前模型的输入容量。已保存的行动与骰点保留；请让管理员检查模型配置与计数支持，不要重复已执行的步骤。",
        "harness_context_preparation_failed" => "后续回应已暂停：现有历史与当前行动资料暂时无法完整装入请求。已保存的行动与骰点保留；需要先完成上下文整理，不会自动重做行动。",
        "harness_context_limit" => "后续回应已暂停：当前行动资料超过可用上下文容量。已保存的行动与骰点保留；请让管理员检查上下文处理，不要重复已执行的步骤。",
        _ => ""
    };

    public static string Notice(HarnessRunView run)
    {
        if (run.Status == "failed" && ContextFailureNotice(run.Error) is { Length: > 0 } contextNotice) return contextNotice;
        if (run.Error == "combat_prompt_required")
            return "战斗尚未交给独立主持：此房间缺少战斗主持提示词。请由主持在「主持要求 → 战斗主持」导入并保存应用，然后从当前局面重新发起行动。已保存的站位、遭遇与骰点保留，不会重建或重掷。";
        if (run.Notice.Length == 0) return "";
        if (run.Status == "delegated" || run.Recovery is not null) return run.Notice;
        return run.Wait?.Kind switch
        {
            "roll" => "已停止后续生成；关联的投掷没有被撤销。请在本页「本人待投掷」的明确放弃入口处理，已提交的游戏效果和可能发生的供应商调用不会撤回。",
            "intent" => "已停止后续生成；关联的来源选择没有被撤销。请在本页「本人待确认事项」的明确放弃入口处理，已提交的游戏效果和可能发生的供应商调用不会撤回。",
            "ruling" => "已停止后续生成；已提交的主持裁定请求保留，请在主持裁定入口处理。已经提交的游戏效果不会撤回。",
            _ => "已停止后续生成；已经提交的游戏效果和可能发生的供应商调用不会撤回。"
        };
    }

    // 业务视图只保留用户回答/确认所需的内容；等待投掷或来源确认的机械细节仍以本人当前快照为准。
    public static AdventureSessionView View(HarnessRunView run) => new(run.Id, Phase(run), run.Wait?.Question ?? "",
        run.Wait is null || run.Wait.Kind == "player" ? null : new AdventureConfirmation(run.Wait.Kind, run.Wait.Id, run.Wait.Question),
        run.Text, Notice(run), run.FirstCombatInput ? "" : run.Input, run.Replayed, run.IntentId, run.BattleSessionId, run.Role, run.ParentRunId, run.Opening);
}
