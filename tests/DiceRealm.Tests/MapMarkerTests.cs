using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class MapMarkerTests
{
    private static MapMarker Pin(string kind, string target, string visibility = "player", double x = .25, double y = .75) =>
        new(Guid.NewGuid().ToString(), kind, target, x, y, visibility);

    public static async Task PermissionsProjectionAndRecovery()
    {
        const string hiddenScene = "MARKER_PRIVATE_BEACON", hiddenNpc = "MARKER_PRIVATE_NPC", hiddenQuest = "MARKER_PRIVATE_QUEST", unvisited = "MARKER_UNVISITED_SUMMARY";
        var images = new TestImages(); var host = await Host.Start(images: images);
        var root = host.Root; string id = "", token = "", mapId = ""; ConfigureMapMarkersRequest? receipt = null;
        try
        {
            var condition = new ContentCondition { All = ["marker-revealed"] };
            var document = TestContent.Document with
            {
                Scenes = TestContent.Document.Scenes.Select(s => s.Id switch
                {
                    "beacon" => s with { Title = hiddenScene },
                    "causeway" => s with { Summary = unvisited },
                    "harbor" => s with { Actions = [..s.Actions,
                        new() { Id = "marker-show", Kind = "story.markershow", Label = "Reveal annotations", Repeatable = true, Success = new("Shown", [new("fact", "marker-revealed")]) },
                        new() { Id = "marker-hide", Kind = "story.markerhide", Label = "Hide annotations", Repeatable = true, Success = new("Hidden", [new("removeFact", "marker-revealed")]) }] },
                    _ => s
                }).ToArray(),
                Npcs = [new("pin-npc", hiddenNpc, "beacon", "", "Visible NPC summary", condition, new() { All = ["never-met"] }, [])],
                Quests = [new("pin-quest", hiddenQuest, "Visible quest summary", "", condition, new(), new() { All = ["never-completed"] }, [])]
            };
            var created = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Marker QA", "Owner", CharacterEngine.Fighter, document, TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Owner")));
            Check.True(created.StatusCode == HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
            var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!; id = owner.Snapshot.Id; token = owner.AccessToken;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var path = $"/api/v1/campaigns/{id}/maps";
            var map = (await (await host.Http.PostAsJsonAsync(path, AssetTests.Create())).Content.ReadFromJsonAsync<MapAssetView>())!; mapId = map.Id;
            var mapPath = path + "/" + mapId;
            var pins = new[] { Pin("scene", "harbor"), Pin("scene", "harbor", "gm"), Pin("scene", "causeway"), Pin("scene", "beacon"), Pin("npc", "pin-npc"), Pin("quest", "pin-quest") };
            var snapshotBefore = JsonSerializer.Serialize((await host.Get(id))!, JsonFiles.Options);
            receipt = new(Guid.NewGuid().ToString(), map.Version, pins);
            var concurrent = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => host.Http.PostAsJsonAsync(mapPath + "/markers", receipt)));
            foreach (var response in concurrent) Check.Equal(HttpStatusCode.OK, response.StatusCode);
            map = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
            Check.Equal(receipt.ExpectedVersion + 1, map.Version); Check.Equal(pins.Length, map.Markers.Length);
            Check.Equal(snapshotBefore, JsonSerializer.Serialize((await host.Get(id))!, JsonFiles.Options)); Check.Equal(0, images.Calls);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(mapPath + "/markers", receipt with { Markers = [] })).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(mapPath + "/markers", receipt with { RequestId = Guid.NewGuid().ToString() })).StatusCode);
            var library = (await host.Http.GetFromJsonAsync<MapLibraryView>(path))!;
            Check.True(library.MarkerOptions!.Any(t => t.Kind == "npc" && !t.PlayerVisible && t.Label == hiddenNpc));
            Check.Equal(0, (await host.Http.GetFromJsonAsync<MapLibraryView>(path + "?publishedOnly=true"))!.Maps.Length);
            await host.Http.PostAsJsonAsync(mapPath + "/generate", AssetTests.Generate(map));
            await AssetTests.Until(async () => (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!.Status == "ready");
            map = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
            async Task Publish()
            {
                var latest = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
                var response = await host.Http.PostAsJsonAsync(mapPath + "/publish", new PublishMapRequest(Guid.NewGuid().ToString(), latest.Version, true, true));
                Check.Equal(HttpStatusCode.OK, response.StatusCode);
            }
            await Publish();
            var hash = map.ContentHash; var prompt = map.Specification!.Prompt;
            async Task AssertPublic(string url, int count, params string[] forbidden)
            {
                var json = await host.Http.GetStringAsync(url);
                var tree = JsonNode.Parse(json)!;
                Check.True(tree["markerOptions"] is null);
                var view = url == mapPath ? tree : tree["maps"]![0]!;
                Check.True(view["specification"] is null && view["sceneIds"] is null);
                Check.Equal(count, view["markers"]!.AsArray().Count);
                foreach (var secret in forbidden) Check.True(!json.Contains(secret), "Private annotation leaked: " + secret);
            }
            await AssertPublic(path + "?publishedOnly=true", 1, hiddenScene, hiddenNpc, hiddenQuest, unvisited, pins[1].Id);
            var snapshot = (await host.Get(id))!;
            var invite = new InviteRequest(Guid.NewGuid().ToString(), snapshot.Version, new string('a', 64));
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", invite)).StatusCode);
            var joined = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), invite.InviteToken, new string('b', 64), "Reader", Build: FullCreationTests.Named("Reader")));
            var guest = (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            await AssertPublic(path, 1, hiddenScene, hiddenNpc, hiddenQuest, unvisited, pins[1].Id);
            await AssertPublic(mapPath, 1, hiddenScene, hiddenNpc, hiddenQuest, unvisited, pins[1].Id);
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync(mapPath + "/markers", receipt)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = null;
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync(mapPath + "/markers", receipt)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            snapshot = (await host.Get(id))!; snapshot = (await host.Act(snapshot, "talk")).Snapshot;
            await AssertPublic(path + "?publishedOnly=true", 2, hiddenScene, hiddenNpc, hiddenQuest, unvisited, pins[1].Id);
            snapshot = (await host.Act(snapshot, "story.markershow")).Snapshot;
            await AssertPublic(path + "?publishedOnly=true", 4, hiddenScene, unvisited, pins[1].Id);
            // No map mutation is needed when authoritative visibility changes, and NPC location is never projected.
            var publicPins = (await host.Http.GetFromJsonAsync<MapLibraryView>(path + "?publishedOnly=true"))!.Maps.Single().Markers;
            Check.Equal("known", publicPins.Single(p => p.Kind == "npc").State);
            Check.Equal("active", publicPins.Single(p => p.Kind == "quest").State);
            snapshot = (await host.Act(snapshot, "story.markerhide")).Snapshot;
            await AssertPublic(path + "?publishedOnly=true", 2, hiddenScene, hiddenNpc, hiddenQuest, unvisited, pins[1].Id);
            map = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
            Check.Equal(hash, map.ContentHash); Check.Equal(prompt, map.Specification!.Prompt);
            var gameVersion = snapshot.Version;
            receipt = new(Guid.NewGuid().ToString(), map.Version, pins.Select(p => p with { X = .7 }).ToArray());
            var saved = await host.Http.PostAsJsonAsync(mapPath + "/markers", receipt);
            map = (await saved.Content.ReadFromJsonAsync<MapAssetView>())!;
            Check.True(!map.Published); Check.Equal(0, (await host.Http.GetFromJsonAsync<MapLibraryView>(path + "?publishedOnly=true"))!.Maps.Length);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync(mapPath)).StatusCode);
            Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync(mapPath + "/image")).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            await Publish();
            Check.Equal(gameVersion, (await host.Get(id))!.Version); Check.Equal(1, images.Calls);
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/archive", new ArchiveCampaignRequest(Guid.NewGuid().ToString(), gameVersion, true))).StatusCode);
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync(mapPath + "/markers", receipt)).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(mapPath + "/markers", receipt with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = map.Version + 1 })).StatusCode);
        }
        finally { await host.DisposeAsync(); }
        await using var restarted = await Host.Start(root, images: images);
        restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var replay = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{mapId}/markers", receipt);
        Check.Equal(HttpStatusCode.OK, replay.StatusCode);
        var persisted = (await replay.Content.ReadFromJsonAsync<MapAssetView>())!;
        Check.True(persisted.Published && persisted.Markers.Length == 6 && persisted.Markers.All(p => p.X == .7));
        Check.Equal(1, images.Calls);
    }

    public static async Task ValidationAndIsolation()
    {
        await using var host = await Host.Start();
        var owner = await host.Create(); var id = owner.Snapshot.Id;
        var path = $"/api/v1/campaigns/{id}/maps";
        var map = (await (await host.Http.PostAsJsonAsync(path, AssetTests.Create())).Content.ReadFromJsonAsync<MapAssetView>())!;
        var endpoint = path + "/" + map.Id + "/markers";
        var pin = Pin("scene", "harbor");
        var invalid = new MapMarker[][] { null!, [null!], [pin with { Id = "" }], [pin with { Id = Guid.Empty.ToString() }], [pin, pin with { Id = pin.Id.ToUpperInvariant() }],
            [pin with { TargetId = "missing" }], [pin with { Kind = "npc" }], [pin with { Kind = "script" }], [pin with { Visibility = "all" }],
            [pin with { X = -.001 }], [pin with { Y = 1.001 }], Enumerable.Range(0, 129).Select(_ => Pin("scene", "harbor")).ToArray() };
        foreach (var pins in invalid)
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(endpoint, new ConfigureMapMarkersRequest(Guid.NewGuid().ToString(), map.Version, pins))).StatusCode);
        var extra = new { requestId = Guid.NewGuid().ToString(), expectedVersion = map.Version, markers = new[] { new { pin.Id, pin.Kind, pin.TargetId, pin.X, pin.Y, pin.Visibility, command = "travel" } } };
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(endpoint, extra)).StatusCode);
        Check.Equal(map.Version, (await host.Http.GetFromJsonAsync<MapAssetView>(path + "/" + map.Id))!.Version);
        var maximum = new ConfigureMapMarkersRequest(Guid.NewGuid().ToString(), map.Version,
            Enumerable.Range(0, 128).Select(_ => Pin("scene", "harbor", x: .12345678912345678, y: .87654321987654321)).ToArray());
        Check.True(JsonSerializer.SerializeToUtf8Bytes(maximum, JsonFiles.Options).Length > 16 * 1024);
        var accepted = await host.Http.PostAsJsonAsync(endpoint, maximum);
        Check.Equal(HttpStatusCode.OK, accepted.StatusCode);
        map = (await accepted.Content.ReadFromJsonAsync<MapAssetView>())!; Check.Equal(128, map.Markers.Length);
        var oversized = "{\"requestId\":\"" + Guid.NewGuid() + "\",\"markers\":[],\"padding\":\"" + new string('x', 128 * 1024) + "\"}";
        Check.Equal(HttpStatusCode.RequestEntityTooLarge, (await host.Http.PostAsync(endpoint, new StringContent(oversized, System.Text.Encoding.UTF8, "application/json"))).StatusCode);
        var other = await host.Create("Other");
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync(endpoint, new ConfigureMapMarkersRequest(Guid.NewGuid().ToString(), map.Version, [pin]))).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{other.Snapshot.Id}/maps/{map.Id}/markers", new ConfigureMapMarkersRequest(Guid.NewGuid().ToString(), map.Version, [pin]))).StatusCode);
        var blank = (await (await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Blank", "Owner", Build: FullCreationTests.Named("Owner")))).Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", blank.AccessToken);
        path = $"/api/v1/campaigns/{blank.Snapshot.Id}/maps";
        Check.Equal(0, (await host.Http.GetFromJsonAsync<MapLibraryView>(path))!.MarkerOptions!.Length);
        map = (await (await host.Http.PostAsJsonAsync(path, AssetTests.Create())).Content.ReadFromJsonAsync<MapAssetView>())!;
        endpoint = path + "/" + map.Id + "/markers";
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(endpoint, new ConfigureMapMarkersRequest(Guid.NewGuid().ToString(), map.Version, [pin]))).StatusCode);
        Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync(endpoint, new ConfigureMapMarkersRequest(Guid.NewGuid().ToString(), map.Version, []))).StatusCode);
    }

    public static Task LegacyAndFailClosed()
    {
        var root = Path.Combine(Path.GetTempPath(), "dicerealm-marker-legacy-" + Guid.NewGuid());
        var config = AssetTests.Config(new() { ["DataPath"] = root }); var campaign = TestContent.Campaign();
        using var directory = new DataDirectory(config);
        var maps = new MapCatalog(directory, new TestImages(), new SceneReferences(directory), config);
        var create = AssetTests.Create(); var map = maps.Create(campaign.Id, create);
        var recordPath = Path.Combine(root, "maps", campaign.Id, map.Id + ".json");
        var legacy = JsonNode.Parse(File.ReadAllText(recordPath))!.AsObject(); legacy.Remove("markers");
        File.WriteAllText(recordPath, legacy.ToJsonString());
        Check.Equal(0, maps.Get(campaign.Id, map.Id, true).Markers.Length);
        Check.Equal(map.Version, maps.Create(campaign.Id, create).Version); // old create fingerprints remain identical
        var targets = MapMarkers.Targets(campaign); var pin = Pin("scene", "harbor");
        foreach (var value in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
            Check.Throws<GameException>(() => MapMarkers.Validate([pin with { X = value }], targets));
        var receipt = new ConfigureMapMarkersRequest(Guid.NewGuid().ToString(), map.Version, [pin]);
        map = maps.ConfigureMarkers(campaign.Id, map.Id, receipt, targets);
        // Replay checks precede changed target availability and archive; new requests cannot use stale references.
        Check.Equal(map.Version, maps.ConfigureMarkers(campaign.Id, map.Id, receipt, [], archived: true).Version);
        Check.Equal("unavailable", maps.Get(campaign.Id, map.Id, true).Markers.Single().State);
        Check.Throws<GameException>(() => maps.ConfigureMarkers(campaign.Id, map.Id, new(Guid.NewGuid().ToString(), map.Version, [pin]), []));
        map = maps.Generate(campaign.Id, map.Id, AssetTests.Generate(map)); var job = maps.Claim()!; maps.Complete(job, AssetTests.Png);
        map = maps.Get(campaign.Id, map.Id, true);
        maps.Publish(campaign.Id, map.Id, new(Guid.NewGuid().ToString(), map.Version, true, true));
        Check.Equal(0, maps.Get(campaign.Id, map.Id, false).Markers.Length); // no campaign context => never raw pins
        Check.Equal(1, maps.Get(campaign.Id, map.Id, false, markerTargets: targets).Markers.Length);
        map = maps.Get(campaign.Id, map.Id, true);
        map = maps.ConfigureMarkers(campaign.Id, map.Id, new(Guid.NewGuid().ToString(), map.Version, []), targets);
        Check.True(!map.Published && map.Markers.Length == 0);
        Check.Equal(0, maps.ConfigureMarkers(campaign.Id, map.Id, receipt, targets).Markers.Length); // old replay cannot resurrect removed pins
        return Task.CompletedTask;
    }
}
