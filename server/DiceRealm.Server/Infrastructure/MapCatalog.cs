using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

// One map record atomically owns its specification, visibility, task lease and request receipts.
// Scene snapshots never call this module's mutation methods. New map images live outside /assets.
public sealed partial class MapCatalog
{
    public static readonly string[] Kinds = ["world", "region", "settlement", "dungeon", "battle"];
    public static readonly string[] GridTypes = ["none", "square", "hex"];
    public static readonly string[] Purposes = ["region", "settlement", "tactical", "schematic"];
    private readonly object gate = new();
    private readonly string records, images, dataRoot;
    private readonly IMapImageGenerator generator;
    private readonly SceneReferences references;
    private readonly Dictionary<string, (long Length, long Written, long Created, bool Valid)> verifiedImages = new();
    private sealed record SavedMap
    {
        public string Id { get; init; } = "";
        public string CampaignId { get; init; } = "";
        public MapSpecification Specification { get; init; } = new();
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public MapLibrarySource? LibrarySource { get; init; }
        public int Version { get; init; } = 1;
        public string Status { get; init; } = "draft";
        public bool Published { get; init; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? AutomaticSceneId { get; init; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string? AutomaticPurpose { get; init; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public double? AutomaticTacticalExtentFeet { get; init; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
        public bool AutoPublish { get; init; }
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public Dictionary<string, AutomaticMapReceipt>? AutomaticReceipts { get; init; }
        public string[] SceneIds { get; init; } = [];
        public MapMarker[] Markers { get; init; } = [];
        public int Width { get; init; }
        public int Height { get; init; }
        public string ContentHash { get; init; } = "";
        public string Error { get; init; } = "";
        public string ProviderIdentity { get; init; } = "";
        public string LeaseId { get; init; } = "";
        public int Attempts { get; init; }
        public DateTimeOffset? RetryAfter { get; init; }
        public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
        public Dictionary<string, string> Receipts { get; init; } = [];
    }
    public MapCatalog(DataDirectory directory, IMapImageGenerator generator, SceneReferences references, IConfiguration configuration)
    {
        this.generator = generator; this.references = references; dataRoot = directory.Root;
        records = Path.Combine(directory.Root, "maps"); images = Path.Combine(directory.Root, "map-images");
        Directory.CreateDirectory(records); Directory.CreateDirectory(images);
        // The data-directory process lease proves an interrupted attempt no longer has an owner.
        // Do not automatically re-send it: the supplier might already have processed/billed it.
        foreach (var path in Directory.EnumerateFiles(records, "*.json", SearchOption.AllDirectories))
        {
            var map = LoadSaved(path);
            if (map.Status == "generating") Save(map with { Status = "failed", Version = map.Version + 1, LeaseId = "", Error = "map_generation_interrupted", RetryAfter = null });
        }
    }
    private static string Id(string id) => Guid.TryParseExact(id, "D", out var value) && value != Guid.Empty ? value.ToString() : throw new GameException("invalid_map_id", "地图与请求编号必须为非空 UUID。");
    private string Folder(string campaignId) => Path.Combine(records, JsonFiles.CampaignId(campaignId));
    private string PathFor(string campaignId, string id) => Path.Combine(Folder(campaignId), Id(id) + ".json");
    private void Save(SavedMap map) { ValidateAutomaticState(map); JsonFiles.Write(PathFor(map.CampaignId, map.Id), map); }
    private SavedMap Read(string campaignId, string id)
    {
        var path = PathFor(campaignId, id);
        if (!File.Exists(path)) throw new GameException("map_not_found", "未找到可访问的地图。", 404);
        var map = LoadSaved(path);
        if (map.CampaignId != campaignId) throw new GameException("map_not_found", "未找到可访问的地图。", 404);
        return map;
    }
    private string ImagePath(string hash) => Path.Combine(images, hash + ".png");
    private bool ValidImage(string hash)
    {
        if (!AssetCatalog.IsHash(hash)) return false;
        try
        {
            var file = new FileInfo(ImagePath(hash));
            if (!file.Exists || file.Length < 57 || file.Length > PngGuard.MaximumMapBytes) return false;
            var stamp = (file.Length, file.LastWriteTimeUtc.Ticks, file.CreationTimeUtc.Ticks);
            if (verifiedImages.TryGetValue(hash, out var cached) && (cached.Length, cached.Written, cached.Created) == stamp) return cached.Valid;
            var valid = JsonFiles.Hash(File.ReadAllBytes(file.FullName)) == hash;
            if (verifiedImages.Count >= 2048) verifiedImages.Clear();
            verifiedImages[hash] = (stamp.Length, stamp.Item2, stamp.Item3, valid);
            return valid;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
    private static bool IsPlayerMap(SavedMap map) => map.Published && map.Specification.Edition == "player" && map.Status == "ready";
    private MapAssetView View(SavedMap map, bool host, string currentSceneId = "", MapMarkerTarget[]? markerTargets = null)
    {
        bool valid = map.Status == "ready" && ValidImage(map.ContentHash);
        return new(map.Id, map.Specification.Title, map.Specification.Kind, map.Specification.Edition, map.Version,
            map.Status == "ready" && !valid ? "failed" : map.Status, map.Published,
            map.Specification.Width, map.Specification.Height, map.Width, map.Height, map.Specification.Grid,
            valid ? $"/api/v1/campaigns/{map.CampaignId}/maps/{map.Id}/image" : "", valid ? map.ContentHash : "",
            map.Status == "ready" && !valid ? "map_image_missing" : map.Error, map.Attempts, map.CreatedAt, host ? map.Specification : null,
            currentSceneId.Length > 0 && map.SceneIds.Contains(currentSceneId), host ? map.SceneIds : null)
        {
            ImportSource = map.Specification.ImportSource,
            Purpose = map.Specification.Purpose,
            Provenance = new(map.Specification.ImportSource is not null ? "imported_original" : "generated_schematic",
                map.Specification.StyleReference is null ? "none" : map.Specification.StyleReference.Snapshot?.ReferenceMode ?? "description",
                map.Specification.ImportSource is not null ? "导入原图；比例状态另见校准信息。" : "扩展示意，非原版地理；仅公开空间关系有依据，位置与未说明的布局不构成权威事实。"),
            Markers = host || IsPlayerMap(map) ? MapMarkers.Project(map.Markers, markerTargets, host) : [],
            AutomaticMarkers = host || IsPlayerMap(map) ? MapMarkers.Automatic(map.Markers, markerTargets, host) : []
        };
    }
    public MapLibraryView List(string campaignId, bool host, bool canManage, bool publishedOnly = false, string currentSceneId = "", MapMarkerTarget[]? markerTargets = null)
    {
        lock (gate)
        {
            var folder = Folder(campaignId);
            var maps = CampaignMaps(campaignId).ToArray();
            return new(maps.Where(m => host && !publishedOnly || IsPlayerMap(m)).OrderByDescending(m => m.CreatedAt).Select(m => View(m, host && !publishedOnly, currentSceneId, markerTargets)).ToArray(),
                canManage && !publishedOnly, generator.Enabled, Kinds, GridTypes, CurrentSceneId: currentSceneId);
        }
    }
    public MapAssetView Get(string campaignId, string id, bool host, string currentSceneId = "", MapMarkerTarget[]? markerTargets = null)
    {
        lock (gate) { var map = Read(campaignId, id); Authorize(map, host); return View(map, host, currentSceneId, markerTargets); }
    }
    private static void Authorize(SavedMap map, bool host)
    { if (!host && !IsPlayerMap(map)) throw new GameException("map_not_found", "未找到可访问的地图。", 404); }
    public MapImageFile Image(string campaignId, string id, bool host)
    {
        lock (gate)
        {
            var map = Read(campaignId, id); Authorize(map, host);
            if (map.Status != "ready" || !ValidImage(map.ContentHash)) throw new GameException("map_image_unavailable", "地图图片尚未就绪或缓存已损坏。", 404);
            return new(ImagePath(map.ContentHash), map.ContentHash);
        }
    }
    private static string Fingerprint(string operation, object request) => JsonFiles.Hash(operation + ":" + JsonSerializer.Serialize(request, JsonFiles.Options));
    private static bool Replayed(SavedMap map, string requestId, string fingerprint)
    {
        Id(requestId);
        if (!map.Receipts.TryGetValue(requestId, out var existing)) return false;
        if (existing != fingerprint) throw new GameException("map_idempotency_conflict", "同一地图请求编号已用于其他内容。", 409);
        return true;
    }
    private static void CheckWritable(bool archived)
    { if (archived) throw new GameException("campaign_archived", "战役已归档，仍可确认此前已接受的请求，但不能新建地图操作。", 409); }
    private static void Match(SavedMap map, int expectedVersion)
    { if (map.Version != expectedVersion) throw new GameException("stale_map", "地图已更新，请刷新后重新确认操作。", 409); }
    private static SavedMap Receipt(SavedMap map, string requestId, string fingerprint)
    {
        if (map.Receipts.Count >= 2048) throw new GameException("map_receipt_limit", "此地图的操作记录已达上限，请新建地图修订。", 409);
        return map with { Receipts = new(map.Receipts) { [requestId] = fingerprint } };
    }
    public MapAssetView Create(string campaignId, CreateMapRequest request, bool archived = false, MapMarkerTarget[]? markerTargets = null) =>
        CreateCore(campaignId, request, archived, markerTargets, null);
    internal MapAssetView CreateLibraryMap(string campaignId, CreateMapRequest request, MapLibrarySource source) =>
        CreateCore(campaignId, request, false, null, source);
    private MapAssetView CreateCore(string campaignId, CreateMapRequest request, bool archived, MapMarkerTarget[]? markerTargets, MapLibrarySource? source)
    {
        lock (gate)
        {
            Validate(request.Specification);
            if (request.Specification.StyleReference is not null || request.Specification.GenerationBasis is not null)
                throw new GameException("invalid_map_spec", "地图风格引用由服务端从已发布玩家原图选择，不能自行指定。");
            var id = Id(request.RequestId); var fingerprint = Fingerprint("create", request); var path = PathFor(campaignId, id);
            if (File.Exists(path))
            {
                var existing = Read(campaignId, id);
                if (!Replayed(existing, request.RequestId, fingerprint)) throw new GameException("map_idempotency_conflict", "该地图编号已存在。", 409);
                return View(existing, true, markerTargets: markerTargets);
            }
            CheckWritable(archived);
            foreach (var hash in request.Specification.ReferenceImages) references.Read(campaignId, hash);
            var folder = Folder(campaignId);
            if (Directory.Exists(folder) && Directory.EnumerateFiles(folder, "*.json").Take(128).Count() >= 128)
                throw new GameException("map_library_full", "每战役最多保存 128 张地图。不会自动删除旧地图。", 409);
            var map = Receipt(new SavedMap { Id = id, CampaignId = campaignId, Specification = request.Specification, LibrarySource = source }, request.RequestId, fingerprint);
            Save(map); return View(map, true, markerTargets: markerTargets);
        }
    }
    public MapAssetView Import(string campaignId, string id, ImportMapRequest request, byte[] png, bool archived = false, MapMarkerTarget[]? markerTargets = null)
    {
        try { PngGuard.ValidateMap(png); }
        catch (InvalidDataException) { throw new GameException("invalid_png", "地图必须是完整 PNG，最大 32 MiB、单边 8192 像素、总像素 33554432。"); }
        var hash = JsonFiles.Hash(png);
        var (width, height) = PngGuard.Dimensions(png);
        lock (gate)
        {
            var map = Read(campaignId, id);
            var fingerprint = Fingerprint("import", new { request.RequestId, request.ExpectedVersion, ContentHash = hash });
            if (Replayed(map, request.RequestId, fingerprint)) return View(map, true, markerTargets: markerTargets);
            CheckWritable(archived); Match(map, request.ExpectedVersion);
            if (map.Specification.ImportSource is null || map.Status != "draft" || map.Attempts != 0 || map.ProviderIdentity.Length != 0)
                throw new GameException("map_not_importable", "只可向原图草稿导入一次本地 PNG；已就绪或生成地图须新建修订。", 409);
            map = Receipt(map with { Version = map.Version + 1, Status = "ready", Published = false,
                Specification = map.Specification with { Width = width, Height = height, Grid = GridForActualDimensions(map.Specification, width, height) },
                Width = width, Height = height, ContentHash = hash }, request.RequestId, fingerprint);
            // Reuse immutable bytes, never repair/replace an existing hash in-place or create a generator cache identity.
            if (File.Exists(ImagePath(hash)))
            {
                if (!ValidImage(hash)) throw new GameException("map_image_corrupt", "已有地图内容校验失败；请恢复完整备份，不会覆盖原文件。", 409);
            }
            else JsonFiles.WriteBytes(ImagePath(hash), png);
            Save(map); // Ready state and the content-bound receipt publish atomically, after immutable bytes.
            return View(map, true, markerTargets: markerTargets);
        }
    }
    public MapAssetView Generate(string campaignId, string id, GenerateMapRequest request, bool archived = false, MapMarkerTarget[]? markerTargets = null)
    {
        lock (gate)
        {
            var map = Read(campaignId, id); var fingerprint = Fingerprint("generate", request);
            if (Replayed(map, request.RequestId, fingerprint)) return View(map, true, markerTargets: markerTargets);
            CheckWritable(archived); Match(map, request.ExpectedVersion);
            if (map.Specification.ImportSource is not null)
                throw new GameException("map_not_generatable", "本地原图不能重新生成或替换；请新建地图修订。", 409);
            if (!request.ConfirmProviderUse) throw new GameException("confirmation_required", "请明确确认生成地图可能消耗供应商额度。");
            if (map.Status is not ("draft" or "failed") && !(map.Status == "ready" && !ValidImage(map.ContentHash)))
                throw new GameException("map_not_generatable", "地图已在处理或已就绪；若要改图，请保存新的地图规格。", 409);
            if (!generator.Enabled) throw new GameException("image_provider_disabled", "地图生图供应商尚未配置；规格已保存，没有发起请求。", 409);
            foreach (var hash in map.Specification.ReferenceImages) references.Read(campaignId, hash);
            map = Receipt(map with { Version = map.Version + 1, Status = "pending", Published = false, AutoPublish = false, AutomaticTacticalExtentFeet = null, Error = "", ContentHash = "", Width = 0, Height = 0,
                Attempts = 0, RetryAfter = null, LeaseId = "", ProviderIdentity = generator.CacheIdentity }, request.RequestId, fingerprint);
            var cached = CachedHash(map); if (cached is not null) map = Ready(map, cached);
            Save(map); return View(map, true, markerTargets: markerTargets);
        }
    }
    public MapAssetView Publish(string campaignId, string id, PublishMapRequest request, bool archived = false, MapMarkerTarget[]? markerTargets = null)
    {
        lock (gate)
        {
            var map = Read(campaignId, id); var fingerprint = Fingerprint("publish", request);
            if (Replayed(map, request.RequestId, fingerprint)) return View(map, true, markerTargets: markerTargets);
            CheckWritable(archived); Match(map, request.ExpectedVersion);
            if (request.Published && (!request.ConfirmPlayerVisibility || map.Specification.Edition != "player" || map.Status != "ready" || !ValidImage(map.ContentHash)))
                throw new GameException("map_not_publishable", "只可在检查内容后明确发布已就绪的玩家版；主持人版不会向玩家开放。", 409);
            map = Receipt(map with { Version = map.Version + 1, Published = request.Published, AutoPublish = false }, request.RequestId, fingerprint);
            Save(map); return View(map, true, markerTargets: markerTargets);
        }
    }
    public MapAssetView ConfigureGrid(string campaignId, string id, ConfigureMapGridRequest request, bool archived = false, MapMarkerTarget[]? markerTargets = null)
    {
        lock (gate)
        {
            ValidateGrid(request.Grid); ValidatePurpose(request.Purpose);
            var map = Read(campaignId, id); var fingerprint = Fingerprint("grid", request);
            if (Replayed(map, request.RequestId, fingerprint)) return View(map, true, markerTargets: markerTargets);
            CheckWritable(archived); Match(map, request.ExpectedVersion); ValidateGrid(request.Grid);
            // Calibration affects display metadata only. Re-approval is required before players see the change.
            map = Receipt(map with { Version = map.Version + 1, Published = false, AutoPublish = false, AutomaticTacticalExtentFeet = null, Specification = map.Specification with { Grid = request.Grid, Purpose = request.Purpose ?? map.Specification.Purpose } }, request.RequestId, fingerprint);
            Save(map); return View(map, true, markerTargets: markerTargets);
        }
    }
    public MapAssetView ConfigureScenes(string campaignId, string id, ConfigureMapScenesRequest request, string[] allowedSceneIds, bool archived = false, MapMarkerTarget[]? markerTargets = null)
    {
        lock (gate)
        {
            var map = Read(campaignId, id); var fingerprint = Fingerprint("scenes", request);
            if (Replayed(map, request.RequestId, fingerprint)) return View(map, true, markerTargets: markerTargets);
            CheckWritable(archived); Match(map, request.ExpectedVersion);
            if (request.SceneIds is null || request.SceneIds.Length > 128 || request.SceneIds.Distinct().Count() != request.SceneIds.Length ||
                request.SceneIds.Any(scene => string.IsNullOrEmpty(scene) || !allowedSceneIds.Contains(scene)))
                throw new GameException("invalid_map_scenes", "只可关联本战役已启用剧本中的地点，最多 128 项且不重复；空列表解除关联。");
            // Recommendation metadata is host-authored and private. It neither publishes pixels nor edits the prompt/cache identity.
            map = Receipt(map with { Version = map.Version + 1, AutoPublish = false, SceneIds = request.SceneIds.ToArray() }, request.RequestId, fingerprint);
            Save(map); return View(map, true, markerTargets: markerTargets);
        }
    }
    public MapAssetView ConfigureMarkers(string campaignId, string id, ConfigureMapMarkersRequest request, MapMarkerTarget[] targets, bool archived = false)
    {
        lock (gate)
        {
            var map = Read(campaignId, id); var fingerprint = Fingerprint("markers", request);
            if (Replayed(map, request.RequestId, fingerprint)) return View(map, true, markerTargets: targets);
            CheckWritable(archived); Match(map, request.ExpectedVersion); MapMarkers.Validate(request.Markers, targets);
            // Pins alter the published view, not generation identity. Require a fresh publication review.
            map = Receipt(map with { Version = map.Version + 1, Published = false, AutoPublish = false, Markers = request.Markers.ToArray() }, request.RequestId, fingerprint);
            Save(map); return View(map, true, markerTargets: targets);
        }
    }
    private string CacheKey(SavedMap map) => JsonFiles.Hash(JsonSerializer.Serialize(new
    { map.Specification.Prompt, map.Specification.Width, map.Specification.Height, map.Specification.ReferenceImages, map.ProviderIdentity }, JsonFiles.Options));
    private string CachePath(SavedMap map) => Path.Combine(images, CacheKey(map) + ".cache.json");
    private string? CachedHash(SavedMap map)
    {
        var path = CachePath(map); if (!File.Exists(path)) return null;
        var hash = JsonFiles.Read<string>(path); return ValidImage(hash) ? hash : null;
    }
    private SavedMap Ready(SavedMap map, string hash)
    {
        using var file = File.OpenRead(ImagePath(hash)); var header = new byte[24]; file.ReadExactly(header);
        var (width, height) = PngGuard.Dimensions(header);
        var grid = map.AutomaticTacticalExtentFeet is { } feet
            ? new MapGrid { Type = "none", CellPixels = 64, Distance = feet * 64 / Math.Max(width, height), Units = "feet",
                ScaleBasis = new("dm", $"本场局部示意图采用完整成品画布最长边 {feet:G} feet；实际成品 {width}×{height} px，短边同比例。主持设定，非来源测绘。") }
            : GridForActualDimensions(map.Specification, width, height);
        return map with { Specification = map.Specification with { Grid = grid }, Status = "ready", Published = map.Published || map.AutoPublish && map.AutomaticSceneId is not null, ContentHash = hash, Width = width, Height = height, Error = "", LeaseId = "", RetryAfter = null };
    }
    public MapGenerationJob? Claim()
    {
        lock (gate)
        {
            foreach (var path in Directory.EnumerateFiles(records, "*.json", SearchOption.AllDirectories))
            {
                var map = LoadSaved(path);
                if (GameSaveCatalog.IsRestoring(dataRoot, map.CampaignId)) continue;
                if (map.Status != "pending" || map.RetryAfter > DateTimeOffset.UtcNow) continue;
                if (map.ProviderIdentity != generator.CacheIdentity)
                { Save(map with { Status = "failed", Version = map.Version + 1, Error = "image_provider_changed", RetryAfter = null }); continue; }
                var cached = CachedHash(map);
                if (cached is not null) { Save(Ready(map, cached) with { Version = map.Version + 1 }); continue; }
                map = map with { Status = "generating", Version = map.Version + 1, Attempts = map.Attempts + 1, LeaseId = Guid.NewGuid().ToString("N") };
                Save(map); return new(map.Id, map.CampaignId, map.LeaseId, map.ProviderIdentity, map.Specification, map.Attempts);
            }
            return null;
        }
    }
    private static bool Owns(SavedMap map, MapGenerationJob job) => map.Status == "generating" && map.LeaseId == job.LeaseId && job.LeaseId.Length > 0;
    public void Complete(MapGenerationJob job, byte[] png)
    {
        PngGuard.ValidateMap(png);
        lock (gate)
        {
            if (GameSaveCatalog.IsRestoring(dataRoot, job.CampaignId) || !File.Exists(PathFor(job.CampaignId, job.Id))) return;
            var map = Read(job.CampaignId, job.Id); if (!Owns(map, job)) return;
            var hash = JsonFiles.Hash(png); JsonFiles.WriteBytes(ImagePath(hash), png); JsonFiles.Write(CachePath(map), hash);
            Save(Ready(map, hash) with { Version = map.Version + 1 });
        }
    }
    public void Fail(MapGenerationJob job, string error, bool retryable = false)
    {
        lock (gate)
        {
            if (GameSaveCatalog.IsRestoring(dataRoot, job.CampaignId) || !File.Exists(PathFor(job.CampaignId, job.Id))) return;
            var map = Read(job.CampaignId, job.Id); if (!Owns(map, job)) return;
            // Even timeout/5xx may have been billed. One confirmation authorizes one attempt;
            // retrying requires a new host confirmation, regardless of old MaxAttempts settings.
            Save(map with { Status = "failed", Version = map.Version + 1, Error = error, LeaseId = "", RetryAfter = null });
        }
    }
    private static MapGrid GridForActualDimensions(MapSpecification spec, int width, int height) =>
        !spec.Grid.Uncalibrated && (spec.Width != width || spec.Height != height)
            ? spec.Grid with { Uncalibrated = true, ScaleBasis = new("unknown", "成品尺寸与请求不同；原像素比例尚未核验，请按实际成品重新校准。") }
            : spec.Grid;

    public static void ValidatePurpose(string? purpose)
    {
        if (purpose is not null && !Purposes.Contains(purpose))
            throw new GameException("invalid_map_purpose", "地图用途须为 region、settlement、tactical 或 schematic。");
    }
    public static void Validate(MapSpecification? spec)
    {
        if (spec is null || string.IsNullOrWhiteSpace(spec.Title) || spec.Title.Length > 160 || spec.Title.Any(char.IsControl) || !Kinds.Contains(spec.Kind) || spec.Edition is not ("gm" or "player"))
            throw new GameException("invalid_map_spec", "地图需要名称、支持的地图类型和 gm/player 版本。");
        ValidatePurpose(spec.Purpose);
        if (spec.ImportSource is { } source)
        {
            ValidateImportSource(source);
            if (spec.Prompt != "" || spec.ReferenceImages is not { Length: 0 } || spec.StyleReference is not null || spec.GenerationBasis is not null)
                throw new GameException("invalid_map_spec", "原图草稿不接受生图提示词、参考图或生成风格引用。");
            if (spec.Width is < 1 or > 8192 || spec.Height is < 1 or > 8192 || (long)spec.Width * spec.Height > 33554432)
                throw new GameException("invalid_map_size", "原图单边须为 1 至 8192 像素、总像素不超过 33554432；导入后以 PNG 实际尺寸为准。");
        }
        else
        {
            if (string.IsNullOrWhiteSpace(spec.Prompt) || spec.Prompt.Length > 16000 || spec.Prompt.Any(c => char.IsControl(c) && c is not ('\r' or '\n' or '\t')))
                throw new GameException("invalid_map_prompt", "请填写或导入 1 至 16000 字符的地图提示词原文；系统不会添加默认提示词。");
            if (spec.Width is < 256 or > 8192 || spec.Height is < 256 or > 8192 || spec.Width % 64 != 0 || spec.Height % 64 != 0 || (long)spec.Width * spec.Height > 33554432)
                throw new GameException("invalid_map_size", "图片宽高须为 256 至 8192 的 64 倍数，总像素不超过 33554432；供应商还可能限制可用尺寸。");
            if (spec.StyleReference is { } style && (!Guid.TryParseExact(style.MapId, "D", out var sourceId) || sourceId == Guid.Empty ||
                string.IsNullOrWhiteSpace(style.Title) || style.Title.Length > 160 || style.Title.Any(char.IsControl) || !ValidVisualStyle(style.VisualStyle)))
                throw new GameException("invalid_map_style", "地图风格引用须含有效原图编号、名称和公开视觉描述。");
        }
        if (spec.ReferenceImages is null || spec.ReferenceImages.Length > 4 || spec.ReferenceImages.Distinct().Count() != spec.ReferenceImages.Length || spec.ReferenceImages.Any(h => !AssetCatalog.IsHash(h)))
            throw new GameException("invalid_map_references", "只可选择本战役已登记的参考图哈希，最多 4 张且不重复。");
        if (spec.StyleReference?.Snapshot is { } frozen && (frozen.Version < 1 || !AssetCatalog.IsHash(frozen.ContentHash) ||
            frozen.Adventure is null || !AssetCatalog.IsHash(frozen.Adventure.Hash) || frozen.ReferenceMode != "description"))
            throw new GameException("invalid_map_style", "地图风格来源版本无效。");
        if (spec.GenerationBasis is { } basis && (basis.Adventure is null || !AssetCatalog.IsHash(basis.Adventure.Hash) ||
            string.IsNullOrWhiteSpace(basis.SceneId) || basis.StateVersion < 1 || basis.Places is null || basis.Exits is null ||
            basis.Places.Length > 8 || basis.Exits.Length > 16 || basis.Places.Any(p => p is null || p.Revision < 1 || p.Source is not ("preparation" or "dm" or "host"))))
            throw new GameException("invalid_map_basis", "地图公开依据无效。");
        ValidateGrid(spec.Grid);
    }
    private static bool ValidVisualStyle(string? style) => !string.IsNullOrWhiteSpace(style) && style.Length <= 2000 &&
        !style.Any(c => char.IsControl(c) && c is not ('\r' or '\n' or '\t'));
    private static void ValidateImportSource(MapImportSource source)
    {
        if (source.SourceUrl is { } url && (url.Length > 2048 || url.Any(char.IsControl) ||
            !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || string.IsNullOrEmpty(uri.Host) || uri.UserInfo.Length != 0))
            throw new GameException("invalid_map_source", "来源须为不含认证信息的 HTTP/HTTPS URL，最多 2048 字符；服务端不会下载该地址。");
        if (source.VisualStyle is not null && !ValidVisualStyle(source.VisualStyle))
            throw new GameException("invalid_map_style", "公开视觉描述须为 1 至 2000 字符，只描述画面风格，不填写布局、秘密或提示指令。");
    }
    private static void ValidateImportedState(SavedMap map)
    {
        try { Validate(map.Specification); }
        catch (GameException ex) { throw new InvalidDataException("Invalid imported map specification.", ex); }
        if (map.Version < 1 || map.Status is not ("draft" or "ready") || map.Attempts != 0 || map.ProviderIdentity != "" ||
            map.LeaseId != "" || map.RetryAfter is not null || map.Error != "" || map.AutomaticSceneId is not null || map.AutoPublish ||
            map.Status == "draft" && (map.Published || map.ContentHash != "" || map.Width != 0 || map.Height != 0) ||
            map.Status == "ready" && (!AssetCatalog.IsHash(map.ContentHash) || map.Width != map.Specification.Width || map.Height != map.Specification.Height))
            throw new InvalidDataException("Invalid imported map state.");
    }
    public static void ValidateGrid(MapGrid? grid)
    {
        if (grid is null || !GridTypes.Contains(grid.Type) || !double.IsFinite(grid.CellPixels) || grid.CellPixels is < 16 or > 2048 ||
            !double.IsFinite(grid.OffsetX) || Math.Abs(grid.OffsetX) > 8192 || !double.IsFinite(grid.OffsetY) || Math.Abs(grid.OffsetY) > 8192 ||
            !double.IsFinite(grid.Distance) || grid.Distance is <= 0 or > 1000000 || grid.Units is not ("feet" or "miles" or "meters" or "kilometers"))
            throw new GameException("invalid_map_grid", "网格与比例尺不合法。格宽 16 至 2048 像素；偏移范围 ±8192；距离须为正有限数。六角格为平顶，格宽指对角直径。");
        if (grid.ScaleBasis is { } basis && (basis.Kind is not ("source" or "dm" or "unknown") ||
            string.IsNullOrWhiteSpace(basis.Detail) || basis.Detail.Length > 500 || basis.Detail.Any(c => char.IsControl(c) && c is not ('\r' or '\n' or '\t')) ||
            basis.Kind == "unknown" && !grid.Uncalibrated))
            throw new GameException("invalid_map_grid", "比例依据须为 source、dm 或 unknown，并附 1 至 500 字符的公开说明；unknown 必须标为未校准。");
    }
}
