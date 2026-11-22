using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class ImportedMapTests
{
    internal static MapSpecification Spec(string edition = "player", string style = "PUBLIC_STYLE") => new()
    {
        Title = edition + " original", Kind = "dungeon", Edition = edition, Width = 1, Height = 1,
        Grid = new() { Type = "none", Uncalibrated = true },
        ImportSource = new() { SourceUrl = "https://example.invalid/original.png", VisualStyle = style }
    };
    private sealed class Images : IMapImageGenerator
    {
        public bool Enabled => true;
        public string CacheIdentity => "imported-map-test";
        public int Calls;
        public MapGenerationJob? Job;
        public Task<byte[]> Generate(MapGenerationJob job, CancellationToken ct)
        { Calls++; Job = job; return Task.FromResult(AssetTests.Png); }
    }
    private static async Task<HttpResponseMessage> Import(Host h, string id, string mapId, ImportMapRequest request, byte[] png, string type = "image/png")
    {
        using var body = new ByteArrayContent(png); body.Headers.ContentType = new(type);
        return await h.Http.PostAsync($"/api/v1/campaigns/{id}/maps/{mapId}/import?requestId={request.RequestId}&expectedVersion={request.ExpectedVersion}", body);
    }
    public static async Task HttpAuthorityAndReplay()
    {
        var model = new Model((_, _) => throw new Exception("No model calls")); var images = new Images();
        var h = await Host.Start(images: images, configure: Configure(model));
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var guest = await HarnessBoundaryTests.Guest(h, owner);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var before = (await h.Get(id))!.Version;
            var map = await Post<MapAssetView>(h, id, "maps", AssetTests.Create(Spec()));
            var request = new ImportMapRequest(Id(), map.Version);
            Check.Equal(HttpStatusCode.UnsupportedMediaType, (await Import(h, id, map.Id, request, AssetTests.Png, "image/jpeg")).StatusCode);
            Check.Equal(HttpStatusCode.BadRequest, (await Import(h, id, map.Id, request, AssetTests.Png[..33])).StatusCode);
            Check.Equal("draft", (await h.Http.GetFromJsonAsync<MapAssetView>($"/api/v1/campaigns/{id}/maps/{map.Id}"))!.Status);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.Forbidden, (await Import(h, id, map.Id, request, AssetTests.Png)).StatusCode);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var imported = await Import(h, id, map.Id, request, AssetTests.Png); Check.Equal(HttpStatusCode.OK, imported.StatusCode);
            map = (await imported.Content.ReadFromJsonAsync<MapAssetView>())!;
            Check.Equal("ready", map.Status); Check.Equal(0, map.Attempts); Check.Equal(1, map.Width); Check.True(!map.Published);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{map.Id}/generate", AssetTests.Generate(map))).StatusCode);
            map = await Post<MapAssetView>(h, id, $"maps/{map.Id}/scenes", new ConfigureMapScenesRequest(Id(), map.Version, ["harbor"]));
            map = await Post<MapAssetView>(h, id, $"maps/{map.Id}/publish", new PublishMapRequest(Id(), map.Version, true, true));
            var gm = await Post<MapAssetView>(h, id, "maps", AssetTests.Create(Spec("gm", "PRIVATE_STYLE")));
            Check.Equal(HttpStatusCode.OK, (await Import(h, id, gm.Id, new(Id(), 1), AssetTests.Png)).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{gm.Id}/publish", new PublishMapRequest(Id(), 2, true, true))).StatusCode);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var publicMaps = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
            Check.Equal(1, publicMaps.Maps.Length); Check.Equal("ready", publicMaps.Status!.Status);
            Check.True(publicMaps.Maps[0].Specification is null && publicMaps.Maps[0].ImportSource!.VisualStyle == "PUBLIC_STYLE");
            Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/maps/{gm.Id}/image")).StatusCode);
            Check.True((await h.Http.GetByteArrayAsync(map.ImageUrl)).SequenceEqual(AssetTests.Png));
            Check.Equal(before, (await h.Get(id))!.Version); Check.Equal(0, images.Calls);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(HttpStatusCode.OK, (await Import(h, id, map.Id, request, AssetTests.Png)).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await Import(h, id, map.Id, request with { RequestId = Id() }, AssetTests.Png)).StatusCode);
            await Post<ActionResponse>(h, id, "archive", new ArchiveCampaignRequest(Id(), before, true));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, configure: Configure(model));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(HttpStatusCode.OK, (await Import(h, id, map.Id, request, AssetTests.Png)).StatusCode);
            Check.Equal(2, (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!.Maps.Length);
            Check.Equal(0, images.Calls); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task PublicStyleForMissingArea()
    {
        var images = new Images();
        var model = new Model((call, request) =>
        {
            var map = HarnessExecutionProtocolTests.Frame(request).GetProperty("map");
            if (call == 1)
            {
                Check.Equal("missing", map.GetProperty("status").GetString());
                return Tool("map_request", new { kind = "dungeon" });
            }
            return Text("当前新区域地图已申请；这是扩展示意，不是原著地图。");
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(images: images, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var maps = h.App.Services.GetRequiredService<MapCatalog>();
            MapAssetView Install(string edition, string style, bool published, string kind = "dungeon", bool sameAdventure = true)
            {
                var binding = owner.Snapshot.Content!.Adventure!;
                var origin = new MapLibrarySource(new(binding.Id, binding.Version, sameAdventure ? binding.Hash : new string('f', 64)), "test", new string('a', 64), "original.png", JsonFiles.Hash(AssetTests.Png));
                var map = AutomaticMapTests.CatalogCall<MapAssetView>(maps, "CreateLibraryMap", id, AssetTests.Create(Spec(edition, style) with { Kind = kind }), origin);
                map = maps.Import(id, map.Id, new(Id(), 1), AssetTests.Png);
                if (published) map = maps.Publish(id, map.Id, new(Id(), map.Version, true, true));
                return map;
            }
            Install("gm", "PRIVATE_GM_STYLE", false);
            Install("player", "PRIVATE_UNPUBLISHED_STYLE", false);
            Install("player", "PUBLIC_FALLBACK_REGION", true, "region");
            Install("player", "OTHER_ADVENTURE_STYLE", true, sameAdventure: false);
            var original = Install("player", "PUBLIC_DUNGEON_INK_PARCHMENT", true);
            // Existing original associated to a scene is reused even by old map_request contracts.
            var associated = maps.ConfigureScenes(id, original.Id, new(Id(), original.Version, ["beacon"]), ["harbor", "beacon"]);
            var spec = new MapSpecification { Title = "public new area", Prompt = "PUBLIC_CURRENT", Edition = "player", Grid = new() { Uncalibrated = true } };
            string command = Id(), fingerprint = Id();
            var reuse = AutomaticMapTests.CatalogCall<AutomaticMapResponse>(maps, "RequestAutomatic", id, "beacon", 1, PartyEngine.HostId, command, fingerprint, spec);
            Check.Equal(original.Id, reuse.Map.Id); Check.Equal("ready", reuse.Map.Status); Check.Equal(0, images.Calls);
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "探索眼前未有原图的区域");
            var run = await StartHistorical(h, id, request, 41); // Frozen kind-only map request and style provenance.
            run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            await AssetTests.Until(() => Task.FromResult(images.Calls == 1));
            Check.True(images.Job!.Specification.Prompt.Contains("PUBLIC_DUNGEON_INK_PARCHMENT"));
            Check.True(!images.Job.Specification.Prompt.Contains("PRIVATE") && !images.Job.Specification.Prompt.Contains("PUBLIC_FALLBACK_REGION"));
            Check.Equal(original.Id, images.Job.Specification.StyleReference!.MapId);
            Check.True(!images.Job.Specification.Prompt.Contains("OTHER_ADVENTURE_STYLE"));
            Check.Equal(associated.Version, images.Job.Specification.StyleReference.Snapshot!.Version);
            Check.Equal(original.ContentHash, images.Job.Specification.StyleReference.Snapshot.ContentHash);
            Check.Equal("description", images.Job.Specification.StyleReference.Snapshot.ReferenceMode);
            Check.Equal(owner.Snapshot.Content!.Adventure!.Hash, images.Job.Specification.StyleReference.Snapshot.Adventure.Hash);
            Check.True(images.Job.Specification.Title.EndsWith("（扩展）", StringComparison.Ordinal));
            Check.Equal(0, images.Job.Specification.ReferenceImages.Length);
            await AssetTests.Until(() => Task.FromResult(maps.List(id, false, false).Maps.Any(m => m.Id == images.Job.Id)));
            Check.Equal(1, images.Calls); Check.Equal(2, model.Calls);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", request)).Replayed);
            maps = h.App.Services.GetRequiredService<MapCatalog>();
            var replay = AutomaticMapTests.CatalogCall<AutomaticMapResponse>(maps, "RequestAutomatic", id, "beacon", 1, PartyEngine.HostId, command, fingerprint, spec);
            Check.Equal(HarnessJson.Serialize(reuse), HarnessJson.Serialize(replay));
            Check.Equal(1, images.Calls); Check.Equal(2, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
