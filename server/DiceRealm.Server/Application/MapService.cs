using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<MapLibraryView> Maps(string id, string token, bool publishedOnly, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            var host = PartyEngine.IsHost(c); var targets = MapMarkers.Targets(c);
            return Task.FromResult(mapCatalog.ListWithSceneStatus(c.Id, host, host && !c.Archived, publishedOnly, c.SceneId, targets,
                !c.Archived && !c.OfflineTrial && imageGenerator.Enabled, SharedBoard.SelectedMapId(c),
                allowFallback: !CombatEngine.InCombat(c) || c.Combat?.BoardLayout is null) with
            {
                SceneOptions = host && !publishedOnly ? targets.Where(t => t.Kind == "scene").Select(t => new MapSceneOption(t.TargetId, t.Label)).ToArray() : null,
                MarkerOptions = host && !publishedOnly ? targets.Where(t => t.Kind != "memory").Select(t => new MapMarkerOption(t.Kind, t.TargetId, t.Label, t.PlayerVisible)).ToArray() : null
            });
        }, ct);
    private SceneMapStatus ReadSceneMapStatus(Campaign campaign, string publicSceneId) =>
        mapCatalog.SceneStatus(campaign.Id, publicSceneId, !campaign.Archived && !campaign.OfflineTrial && imageGenerator.Enabled);

    public Task<MapAssetView> Map(string id, string token, string mapId, CancellationToken ct) =>
        store.Access(id, token, false, c => Task.FromResult(mapCatalog.Get(c.Id, mapId, PartyEngine.IsHost(c), c.SceneId, MapMarkers.Targets(c))), ct);
    public Task<MapImageFile> MapImage(string id, string token, string mapId, CancellationToken ct) =>
        store.Access(id, token, false, c => Task.FromResult(mapCatalog.Image(c.Id, mapId, PartyEngine.IsHost(c))), ct);
    public Task<MapAssetView> CreateMap(string id, string token, CreateMapRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(mapCatalog.Create(c.Id, request, c.Archived, MapMarkers.Targets(c))); }, ct);
    public async Task<MapAssetView> ImportMap(string id, string token, string mapId, ImportMapRequest request, Stream input, CancellationToken ct)
    {
        // Authenticate before receiving up to 32 MiB, without holding a campaign gate during upload.
        await store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(mapCatalog.Get(c.Id, mapId, true)); }, ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await input.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > PngGuard.MaximumMapBytes)
                throw new GameException("map_image_too_large", "地图 PNG 最大 32 MiB。", 413);
            buffer.Write(chunk, 0, read);
        }
        var png = buffer.ToArray();
        // Recheck authorization, map version and archive state after a potentially slow upload.
        return await store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            return Task.FromResult(mapCatalog.Import(c.Id, mapId, request, png, c.Archived, MapMarkers.Targets(c)));
        }, ct);
    }
    public Task<MapAssetView> GenerateMap(string id, string token, string mapId, GenerateMapRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); if (c.OfflineTrial) throw new GameException("trial_provider_disabled", "离线试跑禁止图片模型调用。", 409); return Task.FromResult(mapCatalog.Generate(c.Id, mapId, request, c.Archived, MapMarkers.Targets(c))); }, ct);
    public Task<MapAssetView> PublishMap(string id, string token, string mapId, PublishMapRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(mapCatalog.Publish(c.Id, mapId, request, c.Archived, MapMarkers.Targets(c))); }, ct);
    public Task<MapAssetView> ConfigureMapGrid(string id, string token, string mapId, ConfigureMapGridRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(mapCatalog.ConfigureGrid(c.Id, mapId, request, c.Archived, MapMarkers.Targets(c))); }, ct);
    public Task<MapAssetView> ConfigureMapScenes(string id, string token, string mapId, ConfigureMapScenesRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(mapCatalog.ConfigureScenes(c.Id, mapId, request,
            MapMarkers.Targets(c).Where(t => t.Kind == "scene").Select(t => t.TargetId).ToArray(), c.Archived, MapMarkers.Targets(c))); }, ct);
    public Task<MapAssetView> ConfigureMapMarkers(string id, string token, string mapId, ConfigureMapMarkersRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(mapCatalog.ConfigureMarkers(c.Id, mapId, request, MapMarkers.Targets(c), c.Archived)); }, ct);
}
