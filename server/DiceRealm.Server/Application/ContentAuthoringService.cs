using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record BindPromptsRequest(string RequestId, int ExpectedVersion, string Hash);
public sealed record PreflightRequest(AdventureDocument Document, PromptBundle? Prompts = null);
public sealed record ContentIssue(string Severity, string Path, string Message);
public sealed record ContentPreflight(bool Valid, ContentIssue[] Issues);
public sealed record TrialRequest(string RequestId, int ExpectedVersion, string AccessToken, AdventureDocument Document, PromptBundle Prompts);
public sealed record TrialResponse(CreatedCampaign Trial);

public sealed partial class GameService
{
    private const int MaximumPromptRevisions = 32;
    private static PromptRevision[] PromptHistory(Campaign c) => c.Prompts is null || c.PromptRevisions.Any(r => r.Binding.Hash == Binding(c.Prompts)!.Hash)
        ? c.PromptRevisions.ToArray() : [new(Binding(c.Prompts)!, c.Prompts, null), .. c.PromptRevisions];
    private static void SavePrompts(Campaign c, PromptBundle document)
    {
        ValidatePrompts(document);
        var history = PromptHistory(c); var binding = Binding(document)!;
        if (history.Any(r => r.Binding.Id == binding.Id && r.Binding.Version == binding.Version && r.Binding.Hash != binding.Hash))
            throw new GameException("prompt_version_conflict", "相同提示词包标识和版本不能覆盖不同原文。请填写新的版本号。", 409);
        if (!history.Any(r => r.Binding.Hash == binding.Hash))
        {
            if (history.Length >= MaximumPromptRevisions) throw new GameException("prompt_library_full", "每个战役最多保存 32 个提示词版本；请导出后在新战役继续。不会自动删除历史。", 409);
            history = [.. history, new(binding, document, DateTimeOffset.UtcNow)];
        }
        c.PromptRevisions.Clear(); c.PromptRevisions.AddRange(history); c.Prompts = document;
    }
    public Task<PromptRevision[]> PromptsHistory(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(PromptHistory(c)); }, ct);
    public Task<ActionResponse> BindPrompts(string id, string token, BindPromptsRequest request, CancellationToken ct) =>
        ChangeContent(id, token, "prompts-bind", request.RequestId, request.ExpectedVersion, request, c =>
        {
            if (CombatEngine.InCombat(c)) throw new GameException("content_locked", "请在战斗结束后切换提示词版本。", 409);
            var revision = PromptHistory(c).SingleOrDefault(r => r.Binding.Hash == request.Hash)
                ?? throw new GameException("prompt_revision_missing", "未找到当前战役中的提示词版本。", 404);
            SavePrompts(c, revision.Document);
            return "已明确绑定提示词包 " + revision.Binding.Id + " @ " + revision.Binding.Version + "；后续文本请求使用该原文，历史结果保持不变。";
        }, ct);
    public Task<ContentPreflight> Preflight(string id, string token, PreflightRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(CheckContent(request)); }, ct);
    private static ContentPreflight CheckContent(PreflightRequest request)
    {
        var issues = new List<ContentIssue>();
        try { ContentValidator.Validate(request.Document); }
        catch (GameException ex) { issues.Add(new("error", "document", ex.Message)); }
        if (request.Prompts is not null)
            try { ValidatePrompts(request.Prompts); }
            catch (GameException ex) { issues.Add(new("error", "prompts", ex.Message)); }
        if (issues.Count > 0) return new(false, issues.ToArray());
        var d = request.Document; var reached = new HashSet<string> { d.StartSceneId }; var queue = new Queue<string>(); queue.Enqueue(d.StartSceneId);
        while (queue.TryDequeue(out var current))
            foreach (var exit in d.Scenes.Single(s => s.Id == current).Exits)
                if (reached.Add(exit.Target)) queue.Enqueue(exit.Target);
        foreach (var scene in d.Scenes)
        {
            if (!reached.Contains(scene.Id)) issues.Add(new("warning", "scene:" + scene.Id, "从起点沿路线无法到达。此检查忽略条件，不证明有条件的路线一定可通行。"));
            foreach (var action in scene.Actions)
                if (action.Repeatable && action.Success.Effects.Concat(action.Failure.Effects).Concat(action.Always).Any(e => e.Op == "item" && e.Amount > 0))
                    issues.Add(new("warning", "action:" + action.Id, "可重复行动含物品奖励，可能被反复领取；请检查条件与事实标记。"));
            if (scene.Encounter is { Repeatable: true } encounter && encounter.OnStart.Concat(encounter.Victory.Effects).Any(e => e.Op == "item" && e.Amount > 0))
                issues.Add(new("warning", "encounter:" + encounter.Id, "可重复遭遇含物品奖励；请确认重复领取符合设计。"));
        }
        return new(true, issues.ToArray());
    }
    // The source aggregate is READ ONLY. A durable, separately authenticated campaign is created.
    // Its id is derived from source + request id; retries recover it after a lost response.
    // Derivation also prevents a caller from selecting another live campaign's lock as a trial.
    public Task<TrialResponse> CreateTrial(string id, string token, TrialRequest request, CancellationToken ct) =>
        store.Access(id, token, false, async source =>
        {
            PartyEngine.RequireHost(source);
            if (source.OfflineTrial) throw new GameException("trial_nested", "试跑不能再派生试跑，请回到原战役。", 409);
            if (!Guid.TryParseExact(request.RequestId, "D", out _) || request.RequestId == id || request.ExpectedVersion < 1 || request.AccessToken is null || request.AccessToken.Length != 64 || !request.AccessToken.All(char.IsAsciiHexDigit))
                throw new GameException("invalid_input", "试跑需要独立请求编号与安全凭证。");
            ContentValidator.Validate(request.Document); ValidatePrompts(request.Prompts);
            var fingerprint = JsonFiles.Hash(JsonSerializer.Serialize(request, JsonFiles.Options));
            var trialId = Guid.ParseExact(JsonFiles.Hash("offline-trial:" + id + ":" + request.RequestId)[..32], "N").ToString();
            // Check for a completed prior request before enforcing the current source version.
            try
            {
                return await store.Access(trialId, request.AccessToken, false, c =>
                {
                    if (!c.OfflineTrial || c.TrialSourceId != id || c.TrialFingerprint != fingerprint)
                        throw new GameException("idempotency_conflict", "该试跑请求编号已经用于其他内容。", 409);
                    return Task.FromResult(new TrialResponse(new(request.AccessToken, Snapshot(c))));
                }, ct);
            }
            catch (GameException ex) when (ex.Code == "not_found") { }
            RequireActive(source);
            if (source.Version != request.ExpectedVersion) throw new GameException("stale_version", "原战役已更新，请刷新后重新确认试跑。", 409);
            var trialCharacter = source.Character ?? PartyEngine.Characters(source).Select(p => p.Character).FirstOrDefault()
                ?? throw new GameException("trial_character_required", "离线游玩试跑需要真实角色。请先邀请玩家在客户端完整建卡并审核通过；现在仍可检查和准备内容。", 409);
            var trial = new Campaign
            {
                Id = trialId, Name = "[离线试跑] " + source.Name, TokenHash = JsonFiles.Hash(request.AccessToken),
                Character = source.HostOnlySeat
                    ? JsonSerializer.Deserialize<Character>(JsonSerializer.Serialize(trialCharacter, JsonFiles.Options), JsonFiles.Options)!
                    : CharacterEngine.Create(trialCharacter.Name, trialCharacter.TemplateId, trialCharacter.Creation, trialCharacter.Build),
                Adventure = request.Document,
                OfflineTrial = true, TrialSourceId = id, TrialFingerprint = fingerprint
            };
            SavePrompts(trial, request.Prompts); Activate(trial);
            trial.Events.Add(new(Guid.NewGuid().ToString(), 1, "content.trial", Adventure.Current(trial).Arrival, "", "offline-trial", DateTimeOffset.UtcNow, null));
            store.Create(trial);
            return new TrialResponse(new(request.AccessToken, Snapshot(trial)));
        }, ct);
}
