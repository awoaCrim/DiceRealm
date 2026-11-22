using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed record AutomaticMapView(string Id, string Status, bool Published, string Notice);
public sealed record AutomaticMapResponse(int Version, AutomaticMapView Map);

public sealed partial class MapCatalog
{
    private sealed record AutomaticMapReceipt(string Fingerprint, AutomaticMapResponse Response);
    private static SavedMap LoadSaved(string path)
    {
        var map = JsonFiles.Read<SavedMap>(path);
        ValidateAutomaticState(map);
        return map;
    }
    private static void ValidateAutomaticState(SavedMap map)
    {
        if (map.Specification?.ImportSource is not null) ValidateImportedState(map);
        if (map.LibrarySource is { } origin && (origin.Adventure is null || !AssetCatalog.IsHash(origin.Adventure.Hash) ||
            !AssetCatalog.IsHash(origin.PackageHash) || !AssetCatalog.IsHash(origin.ContentHash) || map.Specification?.ImportSource is null ||
            map.Status == "ready" && map.ContentHash != origin.ContentHash))
            throw new InvalidDataException("Invalid library map provenance.");
        if (map.Specification?.StyleReference is not null || map.Specification?.GenerationBasis is not null ||
            map.Specification?.Purpose is not null || map.Specification?.Grid?.ScaleBasis is not null)
        {
            try { Validate(map.Specification); }
            catch (GameException ex) { throw new InvalidDataException("Invalid map style reference.", ex); }
        }
        if (map.AutomaticPurpose is not null && (!Purposes.Contains(map.AutomaticPurpose) || map.AutomaticSceneId is null) ||
            map.AutomaticTacticalExtentFeet is { } feet && (!double.IsFinite(feet) || feet is < 10 or > 160 || map.AutomaticPurpose != "tactical"))
            throw new InvalidDataException("Invalid automatic map purpose or scale.");
        if (map.AutomaticSceneId is null)
        {
            if (map.AutoPublish) throw new InvalidDataException("Invalid automatic map state.");
            if (map.AutomaticReceipts is null) return; // Existing manual maps retain their original representation.
            // Old map_request contracts can reuse a published manual/imported map. Preserve
            // that exact ready response on its record without claiming automatic provenance.
            if (map.AutomaticReceipts.Count is < 1 or > 2048 || map.Specification?.Edition != "player")
                throw new InvalidDataException("Invalid automatic map receipt.");
        }
        else if (string.IsNullOrWhiteSpace(map.AutomaticSceneId) || map.AutomaticSceneId.Length > 160 ||
            map.Specification?.Edition != "player" || map.Version < 1 ||
            !Guid.TryParseExact(map.Id, "D", out var id) || id == Guid.Empty ||
            map.AutomaticReceipts is null || map.AutomaticReceipts.Count is < 1 or > 2048 ||
            map.AutoPublish && (map.Specification.Grid is null || !map.Specification.Grid.Uncalibrated &&
                !(map.AutomaticPurpose == "tactical" && map.AutomaticTacticalExtentFeet is not null && map.Status == "ready" &&
                    map.Specification.Grid.ScaleBasis?.Kind == "dm")))
            throw new InvalidDataException("Invalid automatic map state.");
        foreach (var (key, receipt) in map.AutomaticReceipts!)
        {
            var response = receipt?.Response;
            if (!AssetCatalog.IsHash(key) || string.IsNullOrWhiteSpace(receipt?.Fingerprint) || receipt.Fingerprint.Length > 128 ||
                response is null || response.Version < 1 || response.Map is null || response.Map.Id != map.Id ||
                response.Map.Status is not ("pending" or "generating" or "ready" or "failed" or "withheld") ||
                response.Map.Published && response.Map.Status != "ready" ||
                map.AutomaticSceneId is null && (response.Map.Status != "ready" || !response.Map.Published) ||
                string.IsNullOrWhiteSpace(response.Map.Notice) || response.Map.Notice.Length > 512)
                throw new InvalidDataException("Invalid automatic map receipt.");
        }
    }
    private static string AutomaticKey(string actor, string commandId) => JsonFiles.Hash(actor + ":" + commandId);
    private IEnumerable<SavedMap> CampaignMaps(string campaignId)
    {
        var folder = Folder(campaignId);
        if (!Directory.Exists(folder)) yield break;
        foreach (var path in Directory.EnumerateFiles(folder, "*.json"))
        {
            var map = LoadSaved(path);
            if (map.CampaignId != campaignId) throw new InvalidDataException("Invalid map ownership.");
            yield return map;
        }
    }
    // Keep list and scene status on the same map snapshot while the queue worker finishes.
    internal MapLibraryView ListWithSceneStatus(string campaignId, bool host, bool canManage, bool publishedOnly,
        string currentSceneId, MapMarkerTarget[] targets, bool generationEnabled, string? selectedMapId = null, bool allowFallback = true)
    {
        lock (gate)
        {
            var library = List(campaignId, host, canManage, publishedOnly, currentSceneId, targets);
            return library with
            {
                GenerationEnabled = generationEnabled,
                SelectedMapId = SelectPlayerMap(library.Maps, selectedMapId, allowFallback)?.Id,
                Status = SceneStatus(campaignId, targets.Any(t => t.Kind == "scene" && t.TargetId == currentSceneId && t.PlayerVisible) ? currentSceneId : "", generationEnabled)
            };
        }
    }
    // Pure read inside an authenticated campaign gate. A public current-scene ID is
    // supplied by the caller; an empty ID must not expose any hidden scene/map identity.
    internal SceneMapStatus SceneStatus(string campaignId, string sceneId, bool generationEnabled)
    {
        lock (gate)
        {
            if (string.IsNullOrEmpty(sceneId)) return new("", "unavailable", false);
            bool enabled = generationEnabled && generator.Enabled;
            var maps = CampaignMaps(campaignId).ToArray();
            // A manually authored player map is as useful as an automatic one. Availability
            // is independent of whether new generation is currently enabled.
            if (maps.Any(map => IsPlayerMap(map) && map.SceneIds.Contains(sceneId) && ValidImage(map.ContentHash)))
                return new(sceneId, "ready", enabled);
            var automatic = maps.Where(map => map.AutomaticSceneId == sceneId)
                .OrderBy(map => map.AutomaticPurpose is null ? 0 : 1).ThenBy(map => map.Id, StringComparer.Ordinal).FirstOrDefault();
            if (automatic is null) return new(sceneId, enabled ? "missing" : "unavailable", enabled);
            string status = automatic.Status == "failed" || automatic.Status == "ready" && !ValidImage(automatic.ContentHash) ? "failed"
                : !automatic.SceneIds.Contains(sceneId) || !automatic.AutoPublish && !automatic.Published ? "withheld"
                : automatic.Status switch
                {
                    "pending" or "generating" => automatic.Status,
                    "ready" => "withheld", // Unpublished pixels are never a readable scene map.
                    _ => throw new InvalidDataException("Invalid automatic map status.")
                };
            return new(sceneId, status, enabled);
        }
    }
    // Called only inside an authenticated campaign gate. Independent map receipts cover the
    // gap between queue commit and run-journal save without changing the game version.
    internal AutomaticMapResponse? AutomaticReceipt(string campaignId, string actor, string commandId, string fingerprint)
    {
        lock (gate)
        {
            string key = AutomaticKey(actor, commandId);
            foreach (var map in CampaignMaps(campaignId))
                if (map.AutomaticReceipts?.TryGetValue(key, out var saved) == true)
                {
                    if (saved.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "地图请求编号已用于另一份请求。", 409);
                    return saved.Response;
                }
            return null;
        }
    }
    // Live progress is separate from the immutable queue receipt. The caller must hold an
    // authenticated campaign gate and supply its still-current scene and requested purpose.
    internal AutomaticMapResponse? AutomaticProgress(string campaignId, string actor, string commandId, string fingerprint,
        string sceneId, string purpose)
    {
        lock (gate)
        {
            string key = AutomaticKey(actor, commandId);
            AutomaticMapResponse? response = null;
            foreach (var map in CampaignMaps(campaignId))
            {
                if (map.AutomaticReceipts is not { } receipts || !receipts.TryGetValue(key, out var saved)) continue;
                if (saved.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "地图请求编号已用于另一份请求。", 409);
                if (response is not null) throw new InvalidDataException("Ambiguous automatic map receipt.");
                response = AutomaticResponse(map, sceneId, saved.Response.Version, true, purpose, requirePublishedReady: true);
            }
            return response;
        }
    }
    internal AutomaticMapResponse RequestAutomatic(string campaignId, string sceneId, int version, string actor,
        string commandId, string fingerprint, MapSpecification specification, AdventureLibrary? library = null,
        int toolContractVersion = 13, double? tacticalExtentFeet = null)
    {
        lock (gate)
        {
            if (AutomaticReceipt(campaignId, actor, commandId, fingerprint) is { } receipt) return receipt;
            Validate(specification);
            bool purposeSlots = toolContractVersion >= 42;
            if (purposeSlots && (specification.Purpose is null || (specification.Purpose == "tactical") != tacticalExtentFeet.HasValue) ||
                tacticalExtentFeet is { } extent && (!double.IsFinite(extent) || extent is < 10 or > 160 || !purposeSlots))
                throw new InvalidOperationException("Automatic local maps require an explicit DM physical extent.");
            if (specification.Edition != "player" || specification.ReferenceImages.Length != 0 || specification.ImportSource is not null ||
                specification.StyleReference is not null || specification.Grid.Type != "none" || !specification.Grid.Uncalibrated || string.IsNullOrWhiteSpace(sceneId))
                throw new InvalidOperationException("Automatic maps require a public scene-only specification.");
            var campaignMaps = CampaignMaps(campaignId).ToArray();
            var associated = campaignMaps.Where(candidate => IsPlayerMap(candidate) && candidate.SceneIds.Contains(sceneId) && ValidImage(candidate.ContentHash) &&
                (!purposeSlots || candidate.Specification.Purpose == specification.Purpose &&
                    (specification.Purpose != "tactical" || UsableTacticalMap(candidate, sceneId))))
                .OrderBy(candidate => candidate.Id, StringComparer.Ordinal).FirstOrDefault();
            if (associated is not null)
                return SaveAutomaticReceipt(associated, actor, commandId, fingerprint,
                    new(version, new(associated.Id, "ready", true, purposeSlots ? ReadyMapNotice(associated) : "地图已可在地图页查看。它是示意图，不构成路线、距离或战斗位置的依据。")));
            // v0..41 keeps its scene slot; v42 has one slot per explicit purpose, never per seat/call.
            // Neither path retries a failed/withheld job just because a new command arrived.
            string slot = purposeSlots ? "automatic-public-map-v2:" + campaignId + ":" + sceneId + ":" + specification.Purpose
                : "automatic-public-map-v1:" + campaignId + ":" + sceneId;
            var digest = Convert.FromHexString(JsonFiles.Hash(slot));
            string id = new Guid(digest.AsSpan(0, 16)).ToString();
            SavedMap map;
            if (File.Exists(PathFor(campaignId, id)))
            {
                map = Read(campaignId, id);
                if (map.AutomaticSceneId != sceneId || purposeSlots && map.AutomaticPurpose != specification.Purpose) throw new GameException("map_idempotency_conflict", "该地图编号已用于另一份地图。", 409);
            }
            else
            {
                if (!generator.Enabled) return new(version, new("", "unavailable", false, "地图生成服务尚未启用，没有发起图片请求。"));
                if (campaignMaps.Length >= 128) throw new GameException("map_library_full", "本战役地图数量已达上限，没有发起图片请求。", 409);
                // Only explicit appearance prose on a valid published PLAYER original is usable.
                // Never inspect authored prompts, GM originals, unpublished records or old geography.
                var originals = campaignMaps.Where(candidate => IsPlayerMap(candidate) &&
                    candidate.Specification.ImportSource?.VisualStyle is not null && ValidImage(candidate.ContentHash)).ToArray();
                var adventure = specification.GenerationBasis?.Adventure;
                var legacy = adventure is not null && library is not null && originals.Any(m => m.LibrarySource is null)
                    ? library.OriginalSources(campaignId, adventure) : null;
                bool SameAdventure(SavedMap candidate) => adventure is not null &&
                    (candidate.LibrarySource is { } origin ? origin.Adventure == adventure && origin.ContentHash == candidate.ContentHash :
                    legacy is not null && legacy.TryGetValue(candidate.Id, out var verified) && verified.Source.ContentHash == candidate.ContentHash &&
                        verified.Specification.ImportSource == candidate.Specification.ImportSource && verified.Specification.Title == candidate.Specification.Title);
                var source = originals.Where(SameAdventure).OrderByDescending(candidate => candidate.Specification.Kind == specification.Kind)
                    .ThenBy(candidate => candidate.Id, StringComparer.Ordinal).FirstOrDefault();
                if (source is not null)
                    specification = HarnessMaps.WithPublicStyle(specification,
                        new(source.Id, source.Specification.Title, source.Specification.ImportSource!.VisualStyle!)
                        { Snapshot = new(source.Version, source.ContentHash, adventure!, "description") });
                Validate(specification);
                map = new SavedMap { Id = id, CampaignId = campaignId, Specification = specification, Status = "pending",
                    SceneIds = [sceneId], AutomaticSceneId = sceneId, AutomaticPurpose = purposeSlots ? specification.Purpose : null,
                    AutomaticTacticalExtentFeet = tacticalExtentFeet, AutoPublish = true, ProviderIdentity = generator.CacheIdentity };
                var cached = CachedHash(map); if (cached is not null) map = Ready(map, cached);
            }
            var response = AutomaticResponse(map, sceneId, version, purposeSlots, specification.Purpose);
            return SaveAutomaticReceipt(map, actor, commandId, fingerprint, response);
        }
    }
    private AutomaticMapResponse AutomaticResponse(SavedMap map, string sceneId, int version, bool purposeSlots,
        string? purpose, bool requirePublishedReady = false)
    {
        // Keep the established queue response unchanged. Only live readiness additionally
        // requires actual publication, never merely an intention to auto-publish later.
        string status = map.Status == "ready" && !ValidImage(map.ContentHash) ? "failed"
            : !map.SceneIds.Contains(sceneId) || !map.AutoPublish && !map.Published ||
                requirePublishedReady && map.Status == "ready" && !map.Published ||
                purposeSlots && (map.Specification.Purpose != purpose ||
                    purpose == "tactical" && map.Status == "ready" && !UsableTacticalMap(map, sceneId))
                ? "withheld" : map.Status;
        return new(version, new(map.Id, status, map.Published && status == "ready", status switch
        {
            "ready" => purposeSlots ? ReadyMapNotice(map) : "地图已可在地图页查看。它是示意图，不构成路线、距离或战斗位置的依据。",
            "pending" or "generating" => "地图正在生成，完成后会自动出现在地图页；无需重复请求。",
            "withheld" when requirePublishedReady && !map.SceneIds.Contains(sceneId) => "本次地图已不再关联当前场景，不能用于本场布局；没有重新生成或发布。",
            "withheld" when requirePublishedReady && map.Specification.Purpose != purpose => "本次地图用途已不符合原请求，不能用于本场布局；没有重新生成或发布。",
            "withheld" when requirePublishedReady && map.Published && map.Status == "ready" => "本次地图尚不符合局部战术图的比例或布局要求，不能用于开战；没有重新生成或修改尺度。",
            "withheld" => "此图已由主持暂停公开；重复请求不会重新生成或发布。",
            "failed" when requirePublishedReady && map.Status == "ready" => "本次地图成品缺失或校验失败，不能用于本场布局；不会重新生成，仍可正常继续冒险。",
            _ => "本次地图生成未完成；可能已经计费，不会自动重试。仍可正常继续冒险。"
        }));
    }
    private bool UsableTacticalMap(SavedMap map, string sceneId)
    {
        try
        {
            var view = View(map, false, sceneId);
            _ = BoardCombat.Layout(view with { Grid = MapScale.TacticalGrid(view) });
            return true;
        }
        catch (GameException) { return false; }
    }
    private static string ReadyMapNotice(SavedMap map) => map.Specification.Purpose == "tactical" && !map.Specification.Grid.Uncalibrated
        ? "已复用或生成当前场景局部战术图。请用 map_select 明确切换，再按新图提供实际落点；旧图坐标不会自动搬运。尺度和依据以该图元数据为准。"
        : "地图已可查看。用途、比例和依据以该图元数据为准；未知尺度不能精确测距，选图不会移动单位或改变路线。";

    private AutomaticMapResponse SaveAutomaticReceipt(SavedMap map, string actor, string commandId, string fingerprint, AutomaticMapResponse response)
    {
        if (map.AutomaticReceipts?.Count >= 2048) throw new GameException("map_receipt_limit", "此地图的请求记录已达上限；仍可从地图页查看。", 409);
        map = map with { AutomaticReceipts = new(map.AutomaticReceipts ?? []) { [AutomaticKey(actor, commandId)] = new(fingerprint, response) } };
        Save(map); // Map state and original tool response publish together, including reused originals.
        return response;
    }
}
