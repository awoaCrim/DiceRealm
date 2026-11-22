using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// Legacy response fields remain empty/false for older clients; no scene preparation is performed.
public sealed record ScenePreparation(string SceneId, string Title, string Status, string AssetId);
public sealed record ResourceStatus(ProviderUsage[] Usage, ScenePreparation[] MainScenes, bool CanPreGenerate,
    string Policy = "用量记录发出前登记的供应商请求次数，不是金额。失败与手动重试计数；缓存命中和离线模式不计数。AI 按需地图与手工地图共用此账本；失败不会自动补发。",
    string HistoryNote = "场景生图已移除，进入场景或启用剧本不再排队。旧图片与历史计数保留；地图任务使用同一持久用量账本。",
    ProviderTokenUsage? Tokens = null);
public sealed record PreGenerateScenesRequest(string[] SceneIds, bool ConfirmProviderUse);

public sealed partial class GameService
{
    public Task<ResourceStatus> Resources(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => Task.FromResult(BuildResources(c)), ct);
    public Task<ResourceStatus> PreGenerate(string id, string token, PreGenerateScenesRequest request, CancellationToken ct) =>
        store.Access<ResourceStatus>(id, token, false, c => { PartyEngine.RequireHost(c); throw AssetCatalog.Removed(); }, ct);
    private ResourceStatus BuildResources(Campaign c) => new(
        [budget.Read("text", c.Id, !c.OfflineTrial && (interpreter is OpenAiText || narrator is OpenAiText || interpreter is ConfiguredText { AnyEnabled: true })), budget.Read("image", c.Id, !c.OfflineTrial && imageGenerator.Enabled)], [], false, Tokens: budget.ReadTokens(c.Id));
}
