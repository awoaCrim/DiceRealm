using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class WorldMapTests
{
    private static MapMarker Pin(string scene, string visibility = "player") => new(Id(), "scene", scene, .25, .75, visibility);
    public static async Task AutomaticPublicAssociationsAndMapIsolation()
    {
        var images = new TestImages(); var model = new Model((_, _) => throw new Exception("no provider"));
        var document = TestContent.Document with { InitialKnowledge =
        [
            new("memory-npc", "npc", "船长", "在港口等待的公开消息。", "harbor", "public"),
            new("unlocated", "clue", "远处消息", "没有地点关联。", "", "public"),
            new("hidden", "npc", "PRIVATE-NPC", "PRIVATE-BODY", "harbor", "host"),
            new("arrival", "quest", "ARRIVAL-QUEST", "ARRIVAL-BODY", "beacon", "arrival", "beacon")
        ] };
        var host = await Host.Start(images: images, configure: Configure(model));
        try
        {
            var owner = await Create(host, document); string id = owner.Snapshot.Id;
            var guest = await HarnessBoundaryTests.Guest(host, owner);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string endpoint = $"/api/v1/campaigns/{id}/maps";
            var map = await Post<MapAssetView>(host, id, "maps", AssetTests.Create());
            var pin = Pin("harbor"); var secretAnchor = Pin("beacon");
            map = await Post<MapAssetView>(host, id, $"maps/{map.Id}/markers", new ConfigureMapMarkersRequest(Id(), map.Version, [pin, secretAnchor]));
            Check.Equal(2, map.Markers.Length); Check.Equal(1, map.AutomaticMarkers.Length);
            Check.Equal("memory-npc", map.AutomaticMarkers[0].TargetId);
            Check.Equal(pin.X, map.AutomaticMarkers[0].X); Check.Equal(pin.Y, map.AutomaticMarkers[0].Y);
            Check.True(Guid.TryParseExact(map.AutomaticMarkers[0].Id, "D", out _));
            var automaticId = map.AutomaticMarkers[0].Id;
            var library = (await host.Http.GetFromJsonAsync<MapLibraryView>(endpoint))!;
            Check.True(library.MarkerOptions!.All(o => o.Kind != "memory"));
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(endpoint + "/" + map.Id + "/markers",
                new ConfigureMapMarkersRequest(Id(), map.Version, [new(automaticId, "memory", "memory-npc", .25, .75, "player")]))).StatusCode);
            await Post<MapAssetView>(host, id, $"maps/{map.Id}/generate", AssetTests.Generate(map));
            await AssetTests.Until(async () => (await host.Http.GetFromJsonAsync<MapAssetView>(endpoint + "/" + map.Id))!.Status == "ready");
            map = (await host.Http.GetFromJsonAsync<MapAssetView>(endpoint + "/" + map.Id))!;
            map = await Post<MapAssetView>(host, id, $"maps/{map.Id}/publish", new PublishMapRequest(Id(), map.Version, true, true));
            string mapFile = Path.Combine(host.Root, "maps", id, map.Id + ".json"); byte[] mapBytes = File.ReadAllBytes(mapFile);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var publicMap = (await host.Http.GetFromJsonAsync<MapAssetView>(endpoint + "/" + map.Id))!;
            Check.Equal(1, publicMap.Markers.Length); Check.Equal(1, publicMap.AutomaticMarkers.Length);
            Check.True(!HarnessJson.Serialize(publicMap).Contains("PRIVATE") && !HarnessJson.Serialize(publicMap).Contains("ARRIVAL"));
            var game = host.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
            var state = (await host.Get(id))!;
            var write = await game.HarnessTool(id, guest.AccessToken, auth.ActorId, Id(), "核对船长消息", state.Version, Id(), Id(),
                new("world_record", HarnessJson.Element(new NarrativeHarnessArgs("船长已启程，港口留下书信。",
                    [new("memory-npc", "npc", "船长的留言", "他已出发；此标记表示留言所在港口，并非实时位置。", "resolved", "harbor")])), "memory"),
                [], default, auth.Profile, 6, offeredMemoryIds: ["memory-npc"]);
            publicMap = (await host.Http.GetFromJsonAsync<MapAssetView>(endpoint + "/" + map.Id))!;
            Check.Equal(automaticId, publicMap.AutomaticMarkers.Single().Id); Check.Equal("resolved", publicMap.AutomaticMarkers.Single().State);
            Check.Equal("船长的留言", publicMap.AutomaticMarkers.Single().Label); Check.Equal(map.Version, publicMap.Version);
            Check.True(publicMap.Published && mapBytes.SequenceEqual(File.ReadAllBytes(mapFile))); Check.Equal(1, images.Calls); Check.Equal(0, model.Calls);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            state = (await Post<ActionResponse>(host, id, "world/correct", new CorrectWorldMemoryRequest(Id(), write.Version, "memory-npc", 2,
                "PRIVATE-CORRECTION", "PRIVATE-CORRECTION-BODY", "resolved", true, "隐藏失实记录"))).Snapshot;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            publicMap = (await host.Http.GetFromJsonAsync<MapAssetView>(endpoint + "/" + map.Id))!;
            Check.Equal(0, publicMap.AutomaticMarkers.Length); Check.True(mapBytes.SequenceEqual(File.ReadAllBytes(mapFile)));
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, images: images, configure: Configure(model));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            publicMap = (await host.Http.GetFromJsonAsync<MapAssetView>(endpoint + "/" + map.Id))!;
            Check.Equal(0, publicMap.AutomaticMarkers.Length); Check.Equal(1, publicMap.Markers.Length); Check.Equal(1, images.Calls);
        }
        finally { await host.DisposeAsync(); }
    }
    public static Task AnchorsFailClosedAndBounded()
    {
        var c = TestContent.Campaign(); var player = Pin("harbor"); var host = Pin("harbor", "gm");
        for (int i = 0; i < 150; i++) c.WorldMemory.Add(new("m" + i, "clue", "记录" + i, "公开说明", "known", "harbor", 1, 1, i + 1, "player", "fixture"));
        var targets = MapMarkers.Targets(c);
        Check.Equal(0, MapMarkers.Automatic([player], null, false).Length);
        Check.Equal(0, MapMarkers.Automatic([host], targets, false).Length);
        Check.Equal(0, MapMarkers.Automatic([], targets, false).Length);
        var derived = MapMarkers.Automatic([player, host], targets, true);
        Check.Equal(128, derived.Length); Check.True(derived.All(m => m.X == player.X && m.Y == player.Y && m.Visibility == "player"));
        Check.Equal("m149", derived[0].TargetId);
        Check.Equal(HarnessJson.Serialize(derived), HarnessJson.Serialize(MapMarkers.Automatic([player], targets, false)));
        var removed = targets.Where(t => t.Kind != "scene").ToArray();
        Check.Equal(0, MapMarkers.Automatic([player], removed, true).Length);
        return Task.CompletedTask;
    }
    public static async Task WaitingCancellationStaleAndCorruptPreservation()
    {
        foreach (bool stale in new[] { false, true })
        {
            var model = new Model((n, _) => n == 1 ? Tool("context_read") : Tool("world_route_propose", new WorldRouteProposal("", "", "mill", 180, true, true, "公开路线")));
            await using var host = await Host.Start(configure: Configure(model));
            var owner = await Create(host, TestContent.Document with { InitialKnowledge = [new("mill", "place", "旧磨坊", "公开路线的终点。", "", "public")] });
            string id = owner.Snapshot.Id; var run = await Start(host, owner.Snapshot); run = await Settled(host, id, run.Id);
            Check.Equal("waiting", run.Status); var state = (await host.Get(id))!;
            if (stale)
            {
                state = (await host.Act(state, "observe")).Snapshot;
                var rejected = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/intents/respond", new IntentResponseRequest(Id(), state.Version, run.Wait!.Id, "choose", "world-route"));
                Check.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
                Check.Equal("intent_context_changed", JsonDocument.Parse(await rejected.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
            }
            state = (await Post<ActionResponse>(host, id, "intents/respond", new IntentResponseRequest(Id(), state.Version, run.Wait!.Id, "cancel"))).Snapshot;
            Check.Equal("harbor", state.Scene.Id); Check.Equal(0L, state.ElapsedSeconds); Check.True(state.Map.Nodes.All(n => n.Title != "旧磨坊"));
            var store = host.App.Services.GetRequiredService<CampaignStore>();
            await store.Access(id, owner.AccessToken, false, c => { Check.True(c.WorldAtlas is null); return Task.FromResult(0); });
            // Temporary corruption injection simulates a future or damaged save. Reads reject,
            // do not repair/downgrade it, and still authenticate before reporting its contents.
            string path = Path.Combine(host.Root, "campaigns", id + ".sqlite");
            using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()))
            {
                db.Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT json FROM state WHERE id=1";
                var saved = JsonNode.Parse((string)cmd.ExecuteScalar()!)!.AsObject();
                saved["worldAtlas"] = new JsonObject { ["schemaVersion"] = 999, ["places"] = new JsonArray(), ["routes"] = new JsonArray() };
                cmd.CommandText = "UPDATE state SET json=$json WHERE id=1"; cmd.Parameters.AddWithValue("$json", saved.ToJsonString()); cmd.ExecuteNonQuery();
            }
            byte[] before = File.ReadAllBytes(path);
            var invalid = await host.Http.GetAsync($"/api/v1/campaigns/{id}"); Check.Equal(HttpStatusCode.Conflict, invalid.StatusCode);
            Check.Equal("invalid_world_atlas", JsonDocument.Parse(await invalid.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", new string('f', 64));
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync($"/api/v1/campaigns/{id}")).StatusCode);
            Check.True(before.SequenceEqual(File.ReadAllBytes(path))); Check.Equal(2, model.Calls);
        }
    }
}
