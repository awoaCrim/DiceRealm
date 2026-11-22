using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed record BoardMapCapture(MapAssetView Map, byte[] Png)
{
    public MapAssetView[] Maps { get; init; } = [];
}
public sealed partial class MapCatalog
{
    // Metadata, permissions and content-addressed bytes are captured under the same map gate.
    // Automatic generation can finish independently of the campaign gate.
    public BoardMapCapture? CapturePlayerBoard(string campaignId, string sceneId, MapMarkerTarget[] targets,
        string? selectedMapId = null, bool allowFallback = true)
    {
        lock (gate)
        {
            var views = ScenePlayerMaps(campaignId, sceneId, targets);
            var view = SelectPlayerMap(views, selectedMapId, allowFallback);
            if (view is null) return null;
            var png = File.ReadAllBytes(ImagePath(view.ContentHash));
            if (JsonFiles.Hash(png) != view.ContentHash) return new(view with { Status = "failed" }, []) { Maps = views };
            return new(view, png) { Maps = views };
        }
    }
    private MapAssetView[] ScenePlayerMaps(string campaignId, string sceneId, MapMarkerTarget[]? targets = null) => CampaignMaps(campaignId)
        .Where(m => IsPlayerMap(m) && m.SceneIds.Contains(sceneId)).OrderByDescending(m => m.CreatedAt)
        .Select(m => View(m, false, sceneId, targets)).ToArray();

    // Callers supply the newest-first snapshot. View.Status includes unavailable image bytes;
    // a saved ready flag alone must not select a map the player cannot actually read.
    private static MapAssetView? SelectPlayerMap(MapAssetView[] maps, string? selectedMapId, bool allowFallback)
    {
        var ready = maps.Where(m => m.CurrentScene && m.Published && m.Edition == "player" && m.Status == "ready").ToArray();
        return ready.FirstOrDefault(m => m.Id == selectedMapId) ?? (allowFallback ? ready.FirstOrDefault() : null);
    }

    internal MapAssetView? SelectedPlayerMap(string campaignId, string sceneId, string? selectedMapId, bool allowFallback = true)
    {
        lock (gate) return SelectPlayerMap(ScenePlayerMaps(campaignId, sceneId), selectedMapId, allowFallback);
    }
    internal string? SelectedPlayerMapId(string campaignId, string sceneId, string? selectedMapId, bool allowFallback = true) =>
        SelectedPlayerMap(campaignId, sceneId, selectedMapId, allowFallback)?.Id;
}
