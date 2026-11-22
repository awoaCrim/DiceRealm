using DiceRealm.Server.Domain;
using System.Text.Json;

namespace DiceRealm.Server.Infrastructure;

// Read-only compatibility for previously generated scene illustrations. It has no worker,
// no queue mutation and no provider dependency. Old image files/heads/jobs are left untouched.
public sealed class AssetCatalog(DataDirectory directory, SceneReferences references)
{
    private readonly string jobs = Path.Combine(directory.Root, "asset-jobs");
    public static GameException Removed() => new("scene_generation_removed", "场景生图已移除。请在独立地图页保存地图规格并明确发起生成。", 410);
    public SceneAsset Ensure(string campaignId, SceneDefinition scene) => Peek(campaignId, scene) ?? new(
        JsonFiles.Hash("scene-generation-removed:" + campaignId + ":" + scene.Id), scene.Id, campaignId, scene.Id,
        "exploration", scene.Title, scene.Summary, "removed", "", "", [], "", [], "", "", "builtin:neutral", 1,
        "scene_generation_removed", 0, null);
    public SceneAsset? Peek(string campaignId, SceneDefinition scene)
    {
        // Existing ready artwork can still be read, without recreating a job after a provider change.
        var existing = Directory.EnumerateFiles(jobs, "*.json").Select(TryRead).OfType<SceneAsset>()
            .Where(a => a.CampaignId == campaignId && a.SceneId == scene.Id && a.Status == "ready")
            .OrderByDescending(a => a.PromptBase == scene.Prompt).ThenByDescending(a => a.Version).FirstOrDefault();
        return existing is null ? null : Get(campaignId, existing.Id);
    }
    private static SceneAsset? TryRead(string path)
    {
        try { return JsonFiles.Read<SceneAsset>(path); }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }
    public SceneAsset Get(string campaignId, string id)
    {
        if (!IsHash(id) || !File.Exists(Path.Combine(jobs, id + ".json"))) throw new GameException("asset_not_found", "未找到旧场景资源。", 404);
        var asset = TryRead(Path.Combine(jobs, id + ".json")) ?? throw new GameException("asset_not_found", "旧场景资源记录不可用。", 404);
        if (asset.CampaignId != campaignId) throw new GameException("asset_not_found", "未找到旧场景资源。", 404);
        if (asset.Status != "ready") return asset with { Status = "removed", Error = "scene_generation_removed", ImageUrl = "", LeaseId = "", RetryAfter = null };
        if (!IsHash(asset.ContentHash) || !File.Exists(ImagePath(asset.ContentHash)) || JsonFiles.Hash(File.ReadAllBytes(ImagePath(asset.ContentHash))) != asset.ContentHash)
            return asset with { Status = "removed", Error = "legacy_image_missing", ImageUrl = "", ContentHash = "" };
        return asset;
    }
    public SceneAsset Revise(string campaignId, SceneDefinition scene, ReviseSceneAssetRequest request) => throw Removed();
    public SceneAsset Retry(string campaignId, string id, string failureId) => throw Removed();
    public ReferenceImage UseAsReference(string campaignId, string id)
    {
        var asset = Get(campaignId, id);
        if (asset.Status != "ready") throw new GameException("asset_not_ready", "只有旧的已就绪图片可登记为参考图。", 409);
        return references.Register(campaignId, asset.Title, File.ReadAllBytes(ImagePath(asset.ContentHash)));
    }
    public static bool IsHash(string? value) => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    public string ImagePath(string hash) => Path.Combine(directory.Root, "assets", hash + ".png");
}
