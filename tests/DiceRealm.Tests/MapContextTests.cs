using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class MapContextTests
{
    public static async Task ContextAndPermissions()
    {
        var images = new TestImages(); var host = await Host.Start(images: images);
        string root = host.Root, id = "", token = "", mapId = "";
        ConfigureMapScenesRequest? receipt = null;
        try
        {
            var owner = await host.Create(); var snapshot = owner.Snapshot; id = snapshot.Id; token = owner.AccessToken;
            var path = $"/api/v1/campaigns/{id}/maps";
            var library = (await host.Http.GetFromJsonAsync<MapLibraryView>(path))!;
            Check.Equal("harbor", library.CurrentSceneId); Check.True(library.SceneOptions!.Any(s => s.Id == "beacon"));
            var map = (await (await host.Http.PostAsJsonAsync(path, AssetTests.Create())).Content.ReadFromJsonAsync<MapAssetView>())!; mapId = map.Id;
            var mapPath = path + "/" + map.Id;
            async Task<MapAssetView> Link(params string[] scenes)
            {
                var latest = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
                var response = await host.Http.PostAsJsonAsync(mapPath + "/scenes", new ConfigureMapScenesRequest(Guid.NewGuid().ToString(), latest.Version, scenes));
                Check.Equal(HttpStatusCode.OK, response.StatusCode); return (await response.Content.ReadFromJsonAsync<MapAssetView>())!;
            }
            map = await Link("harbor", "beacon"); Check.Equal("draft", map.Status); Check.True(!map.Published);
            Check.Equal(0, images.Calls); Check.Equal(1, (await host.Get(id))!.Version);
            var current = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
            Check.True(current.CurrentScene && current.SceneIds!.SequenceEqual(new[] { "harbor", "beacon" }));
            foreach (var invalid in new string[][] { ["not-imported"], ["harbor", "harbor"], [""], null!, Enumerable.Repeat("harbor", 129).ToArray() })
                Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(mapPath + "/scenes", new ConfigureMapScenesRequest(Guid.NewGuid().ToString(), current.Version, invalid))).StatusCode);
            Check.Equal(current.Version, (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!.Version);
            await host.Http.PostAsJsonAsync(mapPath + "/generate", AssetTests.Generate(map));
            await AssetTests.Until(async () => (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!.Status == "ready");
            map = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
            map = (await (await host.Http.PostAsJsonAsync(mapPath + "/publish", new PublishMapRequest(Guid.NewGuid().ToString(), map.Version, true, true))).Content.ReadFromJsonAsync<MapAssetView>())!;
            var hash = map.ContentHash; var prompt = map.Specification!.Prompt;
            receipt = new(Guid.NewGuid().ToString(), map.Version, ["causeway", "beacon"]);
            var replies = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => host.Http.PostAsJsonAsync(mapPath + "/scenes", receipt)));
            foreach (var reply in replies) Check.Equal(HttpStatusCode.OK, reply.StatusCode);
            map = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
            Check.Equal(receipt.ExpectedVersion + 1, map.Version); Check.True(map.Published && !map.CurrentScene);
            Check.Equal(hash, map.ContentHash); Check.Equal(prompt, map.Specification!.Prompt); Check.Equal(1, images.Calls);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(mapPath + "/scenes", receipt with { SceneIds = ["harbor"] })).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(mapPath + "/scenes", receipt with { RequestId = Guid.NewGuid().ToString() })).StatusCode);
            var publicHost = await host.Http.GetStringAsync(path + "?publishedOnly=true");
            Check.True(!publicHost.Contains("sceneIds") && !publicHost.Contains("sceneOptions") && !publicHost.Contains("beacon") && !publicHost.Contains("specification"));
            Check.Equal(1, (await host.Get(id))!.Version);
            var invitation = new InviteRequest(Guid.NewGuid().ToString(), snapshot.Version, new string('a', 64));
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", invitation)).StatusCode);
            var joined = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), invitation.InviteToken, new string('b', 64), "Guest", Build: FullCreationTests.Named("Guest")));
            Check.Equal(HttpStatusCode.OK, joined.StatusCode); var guest = (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            snapshot = (await host.Get(id))!;
            snapshot = (await host.Act(snapshot, "talk")).Snapshot;
            snapshot = (await host.Act(snapshot, "travel", "causeway")).Snapshot;
            map = (await host.Http.GetFromJsonAsync<MapAssetView>(mapPath))!;
            Check.True(map.CurrentScene); Check.Equal(receipt.ExpectedVersion + 1, map.Version); Check.Equal(1, images.Calls);
            var gm = (await (await host.Http.PostAsJsonAsync(path, AssetTests.Create(AssetTests.Spec(edition: "gm")))).Content.ReadFromJsonAsync<MapAssetView>())!;
            await host.Http.PostAsJsonAsync(path + "/" + gm.Id + "/scenes", new ConfigureMapScenesRequest(Guid.NewGuid().ToString(), gm.Version, ["causeway"]));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            foreach (var url in new[] { path, mapPath })
            {
                var json = await host.Http.GetStringAsync(url);
                Check.True(!json.Contains("sceneIds") && !json.Contains("sceneOptions") && !json.Contains("beacon") && !json.Contains("specification"));
                Check.True(json.Contains("\"currentScene\":true"));
            }
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync(mapPath + "/scenes", receipt)).StatusCode);
            Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync(path + "/" + gm.Id)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = null;
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(path)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var version = (await host.Get(id))!.Version;
            var beforeBytes = JsonSerializer.Serialize((await host.Get(id))!, JsonFiles.Options);
            map = await Link(); Check.True(map.Published && !map.CurrentScene && map.SceneIds!.Length == 0);
            Check.Equal(beforeBytes, JsonSerializer.Serialize((await host.Get(id))!, JsonFiles.Options));
            // A received-but-lost older reply confirms without undoing a subsequent unbind.
            var replay = await host.Http.PostAsJsonAsync(mapPath + "/scenes", receipt);
            Check.Equal(map.Version, (await replay.Content.ReadFromJsonAsync<MapAssetView>())!.Version);
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/archive", new ArchiveCampaignRequest(Guid.NewGuid().ToString(), version, true))).StatusCode);
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync(mapPath + "/scenes", receipt)).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(mapPath + "/scenes", new ConfigureMapScenesRequest(Guid.NewGuid().ToString(), map.Version, ["harbor"]))).StatusCode);
        }
        finally { await host.DisposeAsync(); }
        await using var restarted = await Host.Start(root, images: images);
        restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var repeated = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{mapId}/scenes", receipt);
        Check.Equal(HttpStatusCode.OK, repeated.StatusCode);
        var persisted = (await repeated.Content.ReadFromJsonAsync<MapAssetView>())!;
        Check.True(persisted.Published && persisted.SceneIds!.Length == 0); Check.Equal(1, images.Calls);
    }
    public static async Task UnboundAndForeign()
    {
        await using var host = await Host.Start();
        var draft = (await (await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Blank", "Owner", Build: FullCreationTests.Named("Owner")))).Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", draft.AccessToken);
        var path = $"/api/v1/campaigns/{draft.Snapshot.Id}/maps";
        Check.Equal(0, (await host.Http.GetFromJsonAsync<MapLibraryView>(path))!.SceneOptions!.Length);
        var map = (await (await host.Http.PostAsJsonAsync(path, AssetTests.Create())).Content.ReadFromJsonAsync<MapAssetView>())!;
        var request = new ConfigureMapScenesRequest(Guid.NewGuid().ToString(), map.Version, ["harbor"]);
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(path + "/" + map.Id + "/scenes", request)).StatusCode);
        var other = await host.Create();
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync(path + "/" + map.Id + "/scenes", request)).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{other.Snapshot.Id}/maps/{map.Id}/scenes", request)).StatusCode);
    }
}
