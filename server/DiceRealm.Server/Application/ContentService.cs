using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record ImportAdventureRequest(string RequestId, int ExpectedVersion, AdventureDocument Document);
public sealed record ImportPromptsRequest(string RequestId, int ExpectedVersion, PromptBundle Document);
public sealed record ActivateContentRequest(string RequestId, int ExpectedVersion);
public sealed record CampaignContentExport(CampaignContentView Status, AdventureDocument? Adventure, PromptBundle? Prompts);

public sealed partial class GameService
{
    private static ContentBinding? Binding(AdventureDocument? d) => d is null ? null : new(d.Id, d.Version, d.Name, JsonFiles.Hash(JsonSerializer.Serialize(d, JsonFiles.Options)));
    private static ContentBinding? Binding(PromptBundle? d) => d is null ? null : new(d.Id, d.Version, d.Name, JsonFiles.Hash(JsonSerializer.Serialize(d, JsonFiles.Options)));
    private static CampaignContentView ContentView(Campaign c)
    {
        string status = ContentRuntime.Ready(c) ? "active" : c.SceneId.Length > 0 ? "legacy_unbound" : c.Adventure is not null && (c.Prompts is not null || c.Harness is not null) ? "ready_to_activate" : "draft";
        return new(status, Binding(c.Adventure), Binding(c.Prompts), status switch
        {
            "active" => "当前战役使用已保存的剧本和提示词版本；外部文件变更不会自动影响存档。",
            "ready_to_activate" => "内容已导入。请检查后启用；启用不生成图片，地图需在图册中单独确认。",
            "legacy_unbound" => "此旧存档没有绑定可导入剧本。历史和角色保留；请导出记录，在新建空白战役中导入你选择的内容。不会自动转换或覆盖旧进度。",
            _ => "请在工作台编辑或导入剧本与提示词包，然后启用。系统不会提供默认剧本或默认提示词。"
        }, c.OfflineTrial, c.InitialAdventureSetup);
    }
    private static void RequireLegacySetup(Campaign c)
    { if (c.InitialAdventureSetup) throw new GameException("initial_setup_required", "请在首次设定中启用剧本与叙事；不使用旧双提示词入口。", 409); }
    private static void ValidatePrompts(PromptBundle? prompts)
    {
        try { PromptBundles.Validate(prompts); }
        catch (ArgumentException ex) { throw new GameException("invalid_prompts", ex.Message); }
    }
    private static void Activate(Campaign c)
    {
        if (c.Adventure is null || (c.Prompts is null && c.Harness is null)) throw new GameException("content_required", "启用前必须导入剧本与提示词包。", 409);
        if (c.ContentActivated || c.SceneId.Length > 0) throw new GameException("content_locked", "不能用导入操作重置已开始或旧版战役。请新建空白战役。", 409);
        ContentValidator.Validate(c.Adventure);
        if (c.Harness is null) ValidatePrompts(c.Prompts);
        c.ContentActivated = true; c.SceneId = AdventureOpenings.SelectScene(c.Adventure); c.VisitedScenes.Add(c.SceneId);
        if (c.Adventure.Opening is not null && c.Harness is not null) c.Opening = new() { SceneId = c.SceneId };
        // Prepared opening knowledge is imported as non-mechanical world memory, never as
        // rewards, facts, routes or combat parameters.
        WorldMemories.Seed(c, c.Version);
    }
    public Task<CampaignContentExport> ExportContent(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(new CampaignContentExport(ContentView(c), c.Adventure, c.Prompts)); }, ct);
    public Task<ActionResponse> ImportAdventure(string id, string token, ImportAdventureRequest request, CancellationToken ct) =>
        ChangeContent(id, token, "adventure", request.RequestId, request.ExpectedVersion, request, c =>
        {
            RequireLegacySetup(c);
            if (c.ContentActivated || c.SceneId.Length > 0) throw new GameException("content_locked", "已开始的战役不能替换剧本。请新建战役并导入；当前进度不会被覆盖。", 409);
            ContentValidator.Validate(request.Document);
            c.Adventure = request.Document;
            return "剧本已校验并保存，尚未启用；未掷骰，也未调用 AI。";
        }, ct);
    public Task<ActionResponse> ImportPrompts(string id, string token, ImportPromptsRequest request, CancellationToken ct) =>
        ChangeContent(id, token, "prompts", request.RequestId, request.ExpectedVersion, request, c =>
        {
            RequireLegacySetup(c);
            RequireLegacyInput(c);
            if (CombatEngine.InCombat(c)) throw new GameException("content_locked", "请在战斗结束后更换提示词版本。", 409);
            SavePrompts(c, request.Document);
            return "提示词包已校验并保存。后续请求使用本次导入的原文；现有规则、剧情事实和角色数值未改变。";
        }, ct);
    public Task<ActionResponse> ActivateContent(string id, string token, ActivateContentRequest request, CancellationToken ct) =>
        ChangeContent(id, token, "activate", request.RequestId, request.ExpectedVersion, request, c =>
        {
            RequireLegacySetup(c);
            Activate(c); return Adventure.Current(c).Arrival;
        }, ct);
    private Task<ActionResponse> ChangeContent(string id, string token, string operation, string requestId, int expectedVersion, object request, Func<Campaign, string> apply, CancellationToken ct)
    {
        if (!Guid.TryParseExact(requestId, "D", out _) || expectedVersion < 1) throw new GameException("invalid_input", "需要合法的 requestId 与 expectedVersion。");
        return store.Access(id, token, true, c =>
        {
            PartyEngine.RequireHost(c);
            string fingerprint = JsonFiles.Hash("content:" + operation + ":" + JsonSerializer.Serialize(request, request.GetType(), JsonFiles.Options));
            var receipt = store.FindReceipt(c, requestId);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "该请求 ID 已用于其他操作。", 409);
                return Task.FromResult(new ActionResponse(Snapshot(c), receipt.Resolution, true));
            }
            if (c.Version != expectedVersion) throw new GameException("stale_version", "状态已更新，请刷新后重新导入。", 409);
            RequireActive(c);
            var summary = apply(c);
            string kind = "content." + operation;
            var resolution = new Resolution("resolved", kind, summary, null, ["content:" + ContentView(c).Status]);
            c.Version++;
            c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, kind, summary, "", "system", DateTimeOffset.UtcNow, resolution, c.ActingActorId));
            c.Receipts.Add(new(requestId, fingerprint, resolution, c.ActingActorId));
            return Task.FromResult(new ActionResponse(Snapshot(c), resolution, false));
        }, ct);
    }
}
