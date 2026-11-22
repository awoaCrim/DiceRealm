using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

// Only explicitly registered, campaign-owned PNGs may leave the server as references.
// Paths/URLs from the client are never interpreted as files or fetched remotely.
public sealed class SceneReferences(DataDirectory directory)
{
    private readonly object gate = new();
    private string Root => Path.Combine(directory.Root, "references");
    private string ImagePath(string hash) => Path.Combine(Root, "images", hash + ".png");
    private string OwnerPath(string campaignId) => Path.Combine(Root, JsonFiles.CampaignId(campaignId));

    public ReferenceImage Register(string campaignId, string name, byte[] png)
    {
        name = GameService.Text(name, 80, "name");
        try { PngGuard.Validate(png); }
        catch (InvalidDataException) { throw new GameException("invalid_png", "参考图必须是完整 PNG，最大 10 MiB、4096×4096 像素。"); }
        var hash = JsonFiles.Hash(png);
        lock (gate)
        {
            var owned = Path.Combine(OwnerPath(campaignId), hash + ".json");
            var existing = File.Exists(owned) ? JsonFiles.Read<ReferenceImage>(owned) : null;
            if (existing is null && List(campaignId).Length >= 64)
                throw new GameException("reference_capacity", "每个开发战役最多保存 64 张参考图。", 409);
            JsonFiles.WriteBytes(ImagePath(hash), png);
            var result = existing ?? new ReferenceImage(hash, name, png.Length, DateTimeOffset.UtcNow);
            JsonFiles.Write(owned, result);
            return result;
        }
    }

    public ReferenceImage[] List(string campaignId)
    {
        lock (gate)
        {
            var path = OwnerPath(campaignId);
            return Directory.Exists(path) ? Directory.EnumerateFiles(path, "*.json")
                .Select(JsonFiles.Read<ReferenceImage>).OrderBy(r => r.CreatedAt).ToArray() : [];
        }
    }

    public byte[] Read(string campaignId, string hash)
    {
        lock (gate)
        {
            if (!AssetCatalog.IsHash(hash) || !File.Exists(Path.Combine(OwnerPath(campaignId), hash + ".json")))
                throw new GameException("reference_not_found", "参考图不属于当前战役，或尚未登记。", 404);
            var path = ImagePath(hash);
            if (!File.Exists(path)) throw new GameException("reference_content_missing", "参考图文件缺失，请重新登记。", 409);
            var png = File.ReadAllBytes(path);
            if (JsonFiles.Hash(png) != hash) throw new GameException("reference_content_missing", "参考图校验失败，请重新登记。", 409);
            PngGuard.Validate(png);
            return png;
        }
    }
}
