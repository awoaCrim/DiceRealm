using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;

namespace DiceRealm.Tests;

internal static class AssetTests
{
    // A transparent test pixel, never presented as generated map artwork.
    internal static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
    internal static IConfiguration Config(Dictionary<string, string?>? values = null) => new ConfigurationBuilder().AddInMemoryCollection(values ?? []).Build();
    internal static MapSpecification Spec(string prompt = "User supplied test map\r\nDo not append any extra text", int width = 1536, int height = 1024, string edition = "player") => new()
    { Title = "Test map", Kind = "dungeon", Edition = edition, Prompt = prompt, Width = width, Height = height, Grid = new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet" } };
    internal static CreateMapRequest Create(MapSpecification? spec = null) => new(Guid.NewGuid().ToString(), spec ?? Spec());
    internal static GenerateMapRequest Generate(MapAssetView map) => new(Guid.NewGuid().ToString(), map.Version, true);
    public static Task Catalog()
    {
        var root = Path.Combine(Path.GetTempPath(), "dicerealm-maps-" + Guid.NewGuid()); var config = Config(new() { ["DataPath"] = root });
        var one = Guid.NewGuid().ToString(); var two = Guid.NewGuid().ToString(); var generator = new TestImages();
        string id; MapGenerationJob abandoned;
        using (var directory = new DataDirectory(config))
        {
            Check.Throws<IOException>(() => new DataDirectory(config)); var refs = new SceneReferences(directory); var maps = new MapCatalog(directory, generator, refs, config);
            var request = Create(); var map = maps.Create(one, request); id = map.Id;
            Check.Equal("draft", map.Status); Check.True(maps.Claim() is null); Check.Equal(map.Id, maps.Create(one, request).Id);
            Check.Throws<GameException>(() => maps.Create(one, request with { Specification = Spec("different") }));
            Check.Throws<GameException>(() => maps.Generate(one, id, Generate(map) with { ConfirmProviderUse = false }));
            Check.Equal("draft", maps.Get(one, id, true).Status); var send = Generate(map);
            maps.Generate(one, id, send); Check.Equal("pending", maps.Generate(one, id, send).Status); abandoned = maps.Claim()!;
        }
        using (var directory = new DataDirectory(config))
        {
            var refs = new SceneReferences(directory); var maps = new MapCatalog(directory, generator, refs, config);
            var interrupted = maps.Get(one, id, true); Check.Equal("failed", interrupted.Status); Check.Equal("map_generation_interrupted", interrupted.Error);
            Check.True(maps.Claim() is null, "Restart cannot silently rebill an interrupted job");
            maps.Generate(one, id, Generate(interrupted)); var active = maps.Claim()!;
            maps.Complete(abandoned, Png); Check.Equal("generating", maps.Get(one, id, true).Status);
            maps.Complete(active, Png); maps.Fail(active, "stale_failure"); var ready = maps.Get(one, id, true);
            Check.Equal("ready", ready.Status); Check.Equal(1, ready.Width); Check.Equal(1, ready.Height); Check.Equal(1536, ready.RequestedWidth);
            Check.True(maps.List(one, false, false).Maps.Length == 0); Check.Throws<GameException>(() => maps.Image(one, id, false));
            var publish = new PublishMapRequest(Guid.NewGuid().ToString(), ready.Version, true, true);
            maps.Publish(one, id, publish); Check.True(maps.Publish(one, id, publish).Published);
            Check.Equal(1, maps.List(one, false, false).Maps.Length); Check.True(maps.Get(one, id, false).Specification is null);
            Check.True(!JsonSerializer.Serialize(maps.Get(one, id, false)).Contains("User supplied")); Check.True(maps.Image(one, id, false).Path.Contains("map-images"));
            Check.Throws<GameException>(() => maps.Get(two, id, true)); Check.Throws<GameException>(() => maps.Get(one, "../../escape", true));
            var other = maps.Create(two, Create()); other = maps.Generate(two, other.Id, Generate(other));
            Check.Equal("ready", other.Status); Check.Equal(0, other.Attempts); Check.Equal(ready.ContentHash, other.ContentHash);
            var sized = maps.Create(one, Create(Spec(width: 1024, height: 1536))); maps.Generate(one, sized.Id, Generate(sized));
            var attempt = maps.Claim()!; Check.Equal(1024, attempt.Specification.Width); maps.Fail(attempt, "rejected");
            var failed = maps.Get(one, sized.Id, true); var retry = Generate(failed); maps.Generate(one, sized.Id, retry);
            var second = maps.Claim()!; maps.Complete(attempt, Png); Check.Equal("generating", maps.Get(one, sized.Id, true).Status);
            maps.Fail(second, "new_failure"); Check.Equal("failed", maps.Generate(one, sized.Id, retry).Status);
            Check.True(maps.Claim() is null, "A repeated retry receipt cannot resubmit a later failure");
            var current = maps.Get(one, id, true);
            maps.ConfigureGrid(one, id, new(Guid.NewGuid().ToString(), current.Version, new() { Type = "hex", CellPixels = 100, Distance = 2, Units = "miles" }));
            Check.Equal(0, maps.List(one, false, false).Maps.Length); Check.Equal("ready", maps.Get(one, id, true).Status);
            Check.Throws<GameException>(() => maps.Publish(one, id, publish with { RequestId = Guid.NewGuid().ToString() }));
            File.WriteAllText(maps.Image(two, other.Id, true).Path, "corrupted"); Check.Equal("failed", maps.Get(one, id, true).Status);
            var invalid = Png.ToArray(); invalid[45] ^= 1;
            foreach (var png in new[] { Png[..33], Png[..^12], Png.Concat(new byte[] { 0 }).ToArray(), invalid }) Check.Throws<InvalidDataException>(() => PngGuard.ValidateMap(png));
            PngGuard.Validate(Png); PngGuard.ValidateMap(Png);
            foreach (var spec in new[] { Spec("") , Spec(width: 1234), Spec(width: 8192, height: 8192), Spec() with { Kind = "scene" }, Spec() with { Grid = new() { CellPixels = double.NaN } } }) Check.Throws<GameException>(() => maps.Create(one, Create(spec)));
            var changed = maps.Create(one, Create(Spec("queued before config change"))); maps.Generate(one, changed.Id, Generate(changed));
            var newProvider = new MapCatalog(directory, new TestImages("changed-provider"), refs, config); Check.True(newProvider.Claim() is null);
            Check.Equal("image_provider_changed", newProvider.Get(one, changed.Id, true).Error);
        }
        return Task.CompletedTask;
    }
    public static async Task Http()
    {
        await using var host = await Host.Start(); var created = await host.Create(); var s = created.Snapshot; string route = $"/api/v1/campaigns/{s.Id}";
        using var upload = new ByteArrayContent(Png); upload.Headers.ContentType = new("image/png");
        var response = await host.Http.PostAsync(route + "/references?name=Test", upload); Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var reference = (await response.Content.ReadFromJsonAsync<ReferenceImage>())!;
        Check.Equal(1, (await host.Http.GetFromJsonAsync<ReferenceImage[]>(route + "/references"))!.Length);
        Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync("/assets/" + reference.Id + ".png")).StatusCode);
        Check.Equal("removed", (await host.Http.GetFromJsonAsync<SceneAsset>(route + "/assets/" + s.SceneAsset.Id))!.Status);
        Check.Equal(HttpStatusCode.Gone, (await host.Http.PostAsJsonAsync(route + "/scene-asset", new ReviseSceneAssetRequest(s.SceneAsset.Id, "old prompt", "", [], []))).StatusCode);
        Check.Equal(HttpStatusCode.Gone, (await host.Http.PostAsJsonAsync(route + "/assets/" + s.SceneAsset.Id + "/retry", new RetrySceneAssetRequest("old"))).StatusCode);
        Check.Equal(HttpStatusCode.Gone, (await host.Http.PostAsJsonAsync(route + "/resources/pregenerate", new PreGenerateScenesRequest(["harbor"], true))).StatusCode);
        using var invalid = new ByteArrayContent(Png[..33]); invalid.Headers.ContentType = new("image/png"); Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync(route + "/references", invalid)).StatusCode);
        // The server rejects by Content-Length before reading and closes the connection; with
        // 100-continue the client receives that 413 instead of racing a 10 MiB write into a closed socket.
        using var large = new HttpRequestMessage(HttpMethod.Post, route + "/references") { Content = new ByteArrayContent(new byte[PngGuard.MaximumBytes + 1]) };
        large.Content.Headers.ContentType = new("image/png"); large.Headers.ExpectContinue = true;
        Check.Equal(HttpStatusCode.RequestEntityTooLarge, (await host.Http.SendAsync(large)).StatusCode);
        var request = Create(Spec() with { ReferenceImages = [reference.Id] });
        response = await host.Http.PostAsJsonAsync(route + "/maps", request); Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var map = (await response.Content.ReadFromJsonAsync<MapAssetView>())!; Check.Equal("draft", map.Status);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(route + "/maps/" + map.Id + "/generate", Generate(map))).StatusCode);
        Check.Equal(1, (await host.Get(s.Id))!.Version);
        var other = await host.Create("Other");
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(route + "/maps")).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{other.Snapshot.Id}/maps", Create(Spec() with { ReferenceImages = [reference.Id] }))).StatusCode);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        using var forged = new StringContent("{\"requestId\":\"" + Guid.NewGuid() + "\",\"specification\":{\"title\":\"bad\",\"prompt\":\"map\",\"hitPoints\":999}}", Encoding.UTF8, "application/json");
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync(route + "/maps", forged)).StatusCode);
    }
    public static async Task Provider()
    {
        var values = new Dictionary<string, string?> { ["DataPath"] = Path.Combine(Path.GetTempPath(), "map-provider-" + Guid.NewGuid()), ["ImageAi:ApiKey"] = "fake-key", ["ImageAi:Model"] = "fake-model", ["ImageAi:Endpoint"] = "https://image.invalid/generations", ["ImageAi:EditsEndpoint"] = "https://image.invalid/edits", ["ImageAi:SendResponseFormat"] = "false", ["ProviderLimits:ImageCampaignDaily"] = "20", ["ProviderLimits:ImageDaily"] = "20" };
        using var directory = new DataDirectory(Config(values)); var refs = new SceneReferences(directory); var id = Guid.NewGuid().ToString(); var owned = refs.Register(id, "test", Png);
        var budget = new ProviderBudget(directory, Config(values)); var handler = new RecordingHandler(); var ai = new OpenAiImages(new HttpClient(handler), Config(values), refs, budget);
        var job = new MapGenerationJob(Guid.NewGuid().ToString(), id, "test", ai.CacheIdentity, Spec(), 1);
        Check.True((await ai.Generate(job, default)).SequenceEqual(Png));
        using (var body = JsonDocument.Parse(handler.Body)) { Check.Equal(job.Specification.Prompt, body.RootElement.GetProperty("prompt").GetString()); Check.Equal("1536x1024", body.RootElement.GetProperty("size").GetString()); Check.True(!body.RootElement.TryGetProperty("response_format", out _)); }
        var withReference = job with { Specification = Spec(width: 1024, height: 1536) with { ReferenceImages = [owned.Id] } };
        try { await ai.Generate(withReference, default); throw new Exception("Opt-in bypassed"); } catch (ImageGenerationException ex) { Check.Equal("reference_upload_disabled", ex.Code); }
        Check.Equal(1, handler.Calls); values["ImageAi:AllowReferenceUpload"] = "true"; ai = new(new HttpClient(handler), Config(values), refs, budget);
        await ai.Generate(withReference, default); Check.Equal("/edits", handler.Path); Check.True(handler.Body.Contains("1024x1536") && handler.Body.Contains(owned.Id + ".png"));
        handler.Status = HttpStatusCode.BadRequest; try { await ai.Generate(job, default); throw new Exception("400 accepted"); } catch (ImageGenerationException ex) { Check.True(!ex.Retryable); }
        handler.Status = HttpStatusCode.TooManyRequests; try { await ai.Generate(job, default); throw new Exception("429 accepted"); } catch (ImageGenerationException ex) { Check.Equal("image_rate_limited", ex.Code); }
        handler.Status = HttpStatusCode.OK; handler.Response = "{\"data\":[{\"url\":\"http://127.0.0.1/private\"}]}";
        try { await ai.Generate(job, default); throw new Exception("Provider URL accepted"); } catch (InvalidDataException) { }
        int calls = handler.Calls; Check.Throws<GameException>(() => MapCatalog.Validate(Spec(width: 8192, height: 8192))); Check.Equal(calls, handler.Calls);
        Check.True(!ai.CacheIdentity.Contains("fake-model") && !ai.CacheIdentity.Contains("image.invalid"));
    }
    public static async Task Worker()
    {
        var images = new TestImages(failures: 1); await using var host = await Host.Start(images: images, configure: b => b.Configuration["ImageAi:MaxAttempts"] = "2");
        var owner = await host.Create(); var s = owner.Snapshot; await Task.Delay(650); Check.Equal(0, images.Calls);
        Check.Equal("removed", s.SceneAsset.Status); Check.Equal(0, Directory.GetFiles(Path.Combine(host.Root, "asset-jobs")).Length);
        var path = $"/api/v1/campaigns/{s.Id}/maps";
        var map = (await (await host.Http.PostAsJsonAsync(path, Create())).Content.ReadFromJsonAsync<MapAssetView>())!;
        await host.Http.PostAsJsonAsync(path + "/" + map.Id + "/generate", Generate(map));
        await Until(async () => (await host.Http.GetFromJsonAsync<MapAssetView>(path + "/" + map.Id))!.Status == "failed");
        await Task.Delay(2300); Check.Equal(1, images.Calls);
        var failed = (await host.Http.GetFromJsonAsync<MapAssetView>(path + "/" + map.Id))!;
        Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync(path + "/" + map.Id + "/generate", Generate(failed))).StatusCode);
        await Until(async () => (await host.Http.GetFromJsonAsync<MapAssetView>(path + "/" + map.Id))!.Status == "ready"); Check.Equal(2, images.Calls);
        map = (await host.Http.GetFromJsonAsync<MapAssetView>(path + "/" + map.Id))!;
        Check.True((await host.Http.GetByteArrayAsync(map.ImageUrl)).SequenceEqual(Png)); Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync("/assets/" + map.ContentHash + ".png")).StatusCode);
        Check.Equal(1, (await host.Get(s.Id))!.Version);
        var second = await host.Create(); path = $"/api/v1/campaigns/{second.Snapshot.Id}/maps";
        var reused = (await (await host.Http.PostAsJsonAsync(path, Create())).Content.ReadFromJsonAsync<MapAssetView>())!;
        reused = (await (await host.Http.PostAsJsonAsync(path + "/" + reused.Id + "/generate", Generate(reused))).Content.ReadFromJsonAsync<MapAssetView>())!;
        Check.Equal("ready", reused.Status); Check.Equal(2, images.Calls);
    }
    public static async Task PassiveLegacyAndArchivedReplay()
    {
        var images = new TestImages(); string root, campaign, token, oldPath, oldBytes; CreateMapRequest create; MapAssetView map;
        await using (var host = await Host.Start(images: images))
        {
            root = host.Root; var owner = await host.Create(); var snap = owner.Snapshot; campaign = snap.Id; token = owner.AccessToken;
            var old = snap.SceneAsset with { Id = JsonFiles.Hash("old-job"), Status = "pending", PromptBase = "old prompt must never run", Attempts = 0 };
            oldPath = Path.Combine(root, "asset-jobs", old.Id + ".json"); JsonFiles.Write(oldPath, old); oldBytes = File.ReadAllText(oldPath);
            File.WriteAllText(Path.Combine(root, "asset-jobs", "broken.json"), "{broken");
            Check.Equal("removed", (await host.Get(campaign))!.SceneAsset.Status);
            var observed = await host.Act(snap, "talk");
            var travel = observed.Snapshot.AvailableActions.First(a => a.Kind == "travel");
            await host.Act(observed.Snapshot, travel.Kind, travel.Target);
            await Task.Delay(650); Check.Equal(0, images.Calls); Check.Equal(oldBytes, File.ReadAllText(oldPath));
            create = Create(Spec(new string('文', 10000))); // Valid UTF-8 body over the usual 16 KiB command bound.
            var path = $"/api/v1/campaigns/{campaign}/maps";
            var response = await host.Http.PostAsJsonAsync(path, create); Check.Equal(HttpStatusCode.OK, response.StatusCode);
            map = (await response.Content.ReadFromJsonAsync<MapAssetView>())!;
            var current = (await host.Get(campaign))!;
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/archive", new ArchiveCampaignRequest(Guid.NewGuid().ToString(), current.Version, true))).StatusCode);
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync(path, create)).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path, Create())).StatusCode);
            using var duplicate = new StringContent("{\"requestId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"specification\":{}}", Encoding.UTF8, "application/json");
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync(path, duplicate)).StatusCode);
        }
        await using (var restarted = await Host.Start(root, images: images))
        {
            restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            Check.Equal("removed", (await restarted.Get(campaign))!.SceneAsset.Status);
            await Task.Delay(650); Check.Equal(0, images.Calls); Check.Equal(oldBytes, File.ReadAllText(oldPath));
            var repeated = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/maps", create);
            Check.Equal(HttpStatusCode.OK, repeated.StatusCode); Check.Equal(map.Id, (await repeated.Content.ReadFromJsonAsync<MapAssetView>())!.Id);
        }
    }
    internal static async Task Until(Func<Task<bool>> condition)
    { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15)); while (!await condition()) await Task.Delay(75, timeout.Token); }
}
internal sealed class TestImages(string identity = "test-model-v1", int failures = 0) : IMapImageGenerator
{
    private int calls; public int Calls => calls; public bool Enabled => true; public string CacheIdentity => identity;
    public Task<byte[]> Generate(MapGenerationJob map, CancellationToken cancellationToken)
    { if (Interlocked.Increment(ref calls) <= failures) throw new ImageGenerationException("image_rate_limited", true); return Task.FromResult(AssetTests.Png); }
}
internal sealed class RecordingHandler : HttpMessageHandler
{
    public int Calls; public string Path = "", Body = "", ContentType = ""; public HttpStatusCode Status = HttpStatusCode.OK;
    public string Response = JsonSerializer.Serialize(new { data = new[] { new { b64_json = Convert.ToBase64String(AssetTests.Png) } } });
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    { Calls++; Path = request.RequestUri!.AbsolutePath; ContentType = request.Content!.Headers.ContentType!.ToString(); Body = await request.Content.ReadAsStringAsync(ct); return new(Status) { Content = new StringContent(Response, Encoding.UTF8, "application/json") }; }
}
