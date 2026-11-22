using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class AutomaticMapTests
{
    private sealed class Images(bool hold = false) : IMapImageGenerator
    {
        public bool Enabled => true;
        public string CacheIdentity => "isolated-automatic-map";
        public int Calls;
        public MapGenerationJob? Job;
        public async Task<byte[]> Generate(MapGenerationJob job, CancellationToken ct)
        {
            Job = job; Interlocked.Increment(ref Calls);
            if (hold) await Task.Delay(Timeout.Infinite, ct);
            return AssetTests.Png; // A fixture pixel, never claimed as generated artwork.
        }
    }
    private static AutomaticMapResponse Read(HarnessToolOutcome outcome) => HarnessJson.Read<AutomaticMapResponse>(JsonDocument.Parse(outcome.Reply.Content).RootElement);
    private static Task<HarnessToolOutcome> Request(Host h, CreatedCampaign owner, HarnessAuthorization auth, string command, string fingerprint,
        int? version = null, int contract = 13, bool read = true, string kind = "region") =>
        h.App.Services.GetRequiredService<GameService>().HarnessTool(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "PRIVATE_ACTION_SENTINEL",
            version ?? auth.Version, command, fingerprint, new("map_request", HarnessJson.Element(new { kind }), "map-call"), [], default, auth.Profile,
            toolContractVersion: contract, contextAlreadyRead: read);
    private static async Task Reject(Func<Task> operation, string code)
    {
        try { await operation(); throw new Exception("Expected rejection " + code); }
        catch (GameException ex) { Check.Equal(code, ex.Code); }
    }
    public static Task PublicEvidenceIsFrozenAndModelProseExcluded()
    {
        var c = TestContent.Campaign(); c.Version = 500;
        for (int i = 0; i < 270; i++) c.WorldMemory.Add(new("model-" + i, "place", "模型地点" + i, "UNVERIFIED_GEOGRAPHY", "known", "harbor", 1, 1, 400, PartyEngine.HostId, "harness"));
        c.WorldMemory.Add(new("confirmed", "place", "公开地形", "PUBLIC_SPATIAL_CORRECTION", "known", "harbor", 3, 1, 2, PartyEngine.HostId, "dm"));
        c.WorldMemory.Add(new("hidden", "place", "秘密", "PRIVATE_HIDDEN_SENTINEL", "known", "harbor", 1, 1, 401, PartyEngine.HostId, "preparation", Hidden: true));
        c.WorldMemory.Add(new("future", "place", "未揭露", "PRIVATE_FUTURE_SENTINEL", "known", "harbor", 1, 1, 401, PartyEngine.HostId, "preparation", Visibility: "arrival", RevealSceneId: "beacon"));
        var type = typeof(GameService).Assembly.GetType("DiceRealm.Server.Application.HarnessMaps")!;
        var args = Activator.CreateInstance(typeof(GameService).Assembly.GetType("DiceRealm.Server.Application.HarnessMapArgs")!, "battle")!;
        var specificationMethod = type.GetMethod("PublicSpecification", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic,
            null, [typeof(Campaign), args.GetType()], null)!;
        var spec = (MapSpecification)specificationMethod.Invoke(null, [c, args])!;
        Check.True(spec.Prompt.Contains("PUBLIC_SPATIAL_CORRECTION"));
        Check.True(!spec.Prompt.Contains("PRIVATE_") && !spec.Prompt.Contains("UNVERIFIED_GEOGRAPHY"));
        Check.Equal(3, spec.GenerationBasis!.Places.Single().Revision);
        Check.Equal(500, spec.GenerationBasis.StateVersion);
        Check.True(spec.GenerationBasis.Exits.Select(e => e.SceneId).SequenceEqual(Adventure.Exits(c).Select(e => e.Target)));
        Check.True(spec.Grid.Uncalibrated && spec.Grid.Type == "none");
        var saved = HarnessJson.Serialize(spec); c.Version++; c.WorldMemory.Clear();
        Check.Equal(saved, HarnessJson.Serialize(spec));
        var dynamicId = "world-" + Guid.NewGuid().ToString("N");
        c.WorldMemory.Add(new("dynamic-root", "place", "公开谷地", "CONFIRMED_DYNAMIC_SPACE", "known", "", 2, 1, 2, PartyEngine.HostId, "dm"));
        c.WorldAtlas = new() { Places = [new(dynamicId, "dynamic-root")] }; c.SceneId = dynamicId;
        var dynamicSpec = (MapSpecification)specificationMethod.Invoke(null, [c, args])!;
        Check.True(dynamicSpec.Prompt.Contains("CONFIRMED_DYNAMIC_SPACE"));
        Check.Equal("dynamic-root", dynamicSpec.GenerationBasis!.Places.Single().Id);
        Check.Equal(2, dynamicSpec.GenerationBasis.Places.Single().Revision);
        c.WorldMemory[0] = c.WorldMemory[0] with { Source = "harness" };
        dynamicSpec = (MapSpecification)specificationMethod.Invoke(null, [c, args])!;
        Check.True(!dynamicSpec.Prompt.Contains("CONFIRMED_DYNAMIC_SPACE"));
        Check.True(!JsonSerializer.Serialize(AssetTests.Spec(), JsonFiles.Options).Contains("generationBasis"));
        return Task.CompletedTask;
    }
    public static async Task ScriptedPiMapPublishesWithoutHostCommands()
    {
        string? mapId = null;
        var model = new Model((call, request) =>
        {
            var state=HarnessExecutionProtocolTests.Frame(request).GetProperty("map");
            if (call <= 2)
            {
                Check.Equal("missing",state.GetProperty("status").GetString());Check.True(state.GetProperty("generationEnabled").GetBoolean());
                Check.True(request.Tools.Any(t => t.Name == "map_request"));
                return call==1?Tool("context_read"):Tool("map_request", new { kind = "settlement" });
            }
            Check.True(!request.Tools.Any(t=>t.Name=="map_request"));
            Check.True(state.GetProperty("status").GetString() is "pending" or "generating" or "ready");
            var map = JsonDocument.Parse(request.Messages.Last(m => m.Name == "map_request" && m.Role == "tool").Content).RootElement.GetProperty("map");
            Check.Equal(3,call);mapId = map.GetProperty("id").GetString();
            return Text("可在地图页查看当前地点示意图；像素不代表真实距离。");
        });
        var configure = Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var images = new Images(); var h = await Host.Start(images: images, configure: configure);
        try
        {
            var owner = await Create(h); var guest = await HarnessBoundaryTests.Guest(h, owner);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var request = new HarnessInputRequest(Id(), guest.Snapshot.Version, "我沿港口巡视，看看码头和街道如何相连。");
            // Preserve the scene-only request/availability contract frozen before purpose slots.
            var run = await StartHistorical(h, owner.Snapshot.Id, request, 41);
            run = await Settled(h, owner.Snapshot.Id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            string endpoint = $"/api/v1/campaigns/{owner.Snapshot.Id}/maps";
            await AssetTests.Until(async () => (await h.Http.GetFromJsonAsync<MapLibraryView>(endpoint))!.Maps.Length == 1);
            var map = (await h.Http.GetFromJsonAsync<MapLibraryView>(endpoint))!.Maps.Single();
            Check.Equal(mapId, map.Id); Check.True(map.Published && map.CurrentScene); Check.Equal("ready", map.Status); Check.Equal("none", map.Grid.Type); Check.True(map.Grid.Uncalibrated);
            Check.True(map.Specification is null && map.SceneIds is null); Check.Equal("generated_schematic", map.Provenance!.Kind);
            Check.True(!HarnessJson.Serialize(map).Contains("generationBasis")); Check.Equal(0, map.Markers.Length); Check.Equal(1, images.Calls);
            Check.Equal(HttpStatusCode.OK, (await h.Http.GetAsync(endpoint + "/" + map.Id + "/image")).StatusCode);
            Check.True((await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request)).Replayed); Check.Equal(3, model.Calls);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.True((await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request)).Replayed);
            Check.Equal(1, (await h.Http.GetFromJsonAsync<MapLibraryView>(endpoint))!.Maps.Length); Check.Equal(1, images.Calls); Check.Equal(3, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task RefreshContextAfterActionRecoversWithoutSideEffects()
    {
        var images = new Images();
        var model = new Model((call, request) =>
        {
            if (call == 1 || call == 4) return Tool("context_read");
            if (call == 2)
            {
                using var doc = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content);
                var candidate = doc.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .First(c => c.GetProperty("label").GetString()!.Contains("观察")).GetProperty("id").GetString();
                return Tool("actions_propose", new { candidateId = candidate });
            }
            if (call == 3) return Tool("map_request", new { kind = "settlement" }); // Deliberately miss the post-write read.
            if (call == 5) return Tool("map_request", new { kind = "settlement" });
            return Text("已观察当前地点，示意图已请求；无需重新执行观察。");
        });
        // Assert the recovery reply in a real Pi/MCP model callback, not only a fake loop.
        var checkedModel = new Model(async (call, request, ct) =>
        {
            if (call == 4)
            {
                var reply = request.Messages.Last(m => m.Role == "tool");
                Check.Equal("map_request", reply.Name); Check.True(reply.IsError != true);
                using var doc = JsonDocument.Parse(reply.Content);
                Check.Equal("context_required", doc.RootElement.GetProperty("status").GetString());
                Check.Equal("harness_context_required", doc.RootElement.GetProperty("code").GetString());
                Check.Equal("context_read", doc.RootElement.GetProperty("nextTool").GetString());
                Check.Equal(0, images.Calls);
            }
            return await model.Complete(request, "unused-test-scope", ct);
        });
        var configure = Configure(checkedModel, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        await using var h = await Host.Start(images: images, configure: configure);
        var owner = await Create(h);
        var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "观察当前地点，再给我示意图");
        var run = await StartV14(h, owner.Snapshot.Id, request);
        run = await Settled(h, owner.Snapshot.Id, run.Id, 3000);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error + "; last tool=" +
            HarnessJson.Serialize(checkedModel.Requests.Last().Messages.Last(m => m.Role == "tool")));
        Check.Equal(6, checkedModel.Calls);
        Check.Equal(1, (await h.Get(owner.Snapshot.Id))!.Events.Count(e => e.Kind == "observe"));
        await AssetTests.Until(() => Task.FromResult(images.Calls == 1));
        Check.True((await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request)).Replayed);
        Check.Equal(6, checkedModel.Calls); Check.Equal(1, images.Calls);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
        var rejected = saved.Steps.First(s => s.ToolName == "map_request");
        Check.Equal("done", rejected.Status); Check.True(!rejected.Outcome!.Reply.Stop && !rejected.Outcome.Reply.IsError);
        Check.True(rejected.Outcome.OfferedIds is null && rejected.Outcome.OfferedMemoryIds is null);
    }
    public static async Task PublicInputsAtomicMapReceiptAndManualWithholding()
    {
        var images = new Images(); var model = new Model((_, _) => throw new Exception("No model calls"));
        await using var h = await Host.Start(images: images, configure: Configure(model));
        var owner = await Create(h, TestContent.Document with { SourceText = "PRIVATE_SOURCE_SENTINEL", InitialKnowledge =
        [new("public-place", "place", "公开码头", "PUBLIC_PLACE_SENTINEL", "harbor", "public"),
            new("host-place", "place", "隐藏地点", "PRIVATE_HOST_SENTINEL", "harbor", "host"),
            new("future-place", "place", "未来地点", "PRIVATE_ARRIVAL_SENTINEL", "beacon", "arrival", "beacon")] });
        var game = h.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
        string command = Id(), fingerprint = Id();
        Check.Equal("a56f0a6f71128dc9a2ed29d977b21486d1593d52e64ea9fdb69c7a0707c6e6ac",
            HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(13))));
        Check.True(!HarnessTools.ForVersion(12).Any(t => t.Name == "map_request"));
        Check.Equal(HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(12))), HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(13).Where(t => t.Name != "map_request").ToArray())));
        await Reject(() => Request(h, owner, auth, command, fingerprint, contract: 12), "harness_tool_unavailable");
        await Reject(() => Request(h, owner, auth, command, fingerprint, read: false), "harness_context_required");
        await Reject(() => Request(h, owner, auth, command, fingerprint, kind: "private"), "harness_invalid_payload");
        var refresh = await Request(h, owner, auth, Id(), Id(), contract: 14, read: false);
        Check.True(!refresh.Reply.IsError && !refresh.Reply.Stop);
        Check.Equal("context_required", JsonDocument.Parse(refresh.Reply.Content).RootElement.GetProperty("status").GetString());
        Check.Equal(auth.Version, refresh.Version);
        Check.True(refresh.OfferedIds is null && refresh.OfferedMemoryIds is null);
        await Reject(() => Request(h, owner, auth, Id(), Id(), contract: 14, read: false, kind: "private"), "harness_invalid_payload");
        await Reject(() => Request(h, owner, auth, Id(), Id(), version: auth.Version + 1, contract: 14, read: false), "stale_version");
        Check.Equal(0, Directory.GetFiles(Path.Combine(h.Root, "maps"), "*.json", SearchOption.AllDirectories).Length);
        string before = JsonSerializer.Serialize((await h.Get(owner.Snapshot.Id))!);
        var first = await Request(h, owner, auth, command, fingerprint); var response = Read(first);
        Check.Equal("pending", response.Map.Status); Check.Equal(auth.Version, first.Version);
        await AssetTests.Until(() => Task.FromResult(images.Calls == 1));
        string prompt = images.Job!.Specification.Prompt;
        Check.True(prompt.Contains("PUBLIC_PLACE_SENTINEL")); Check.True(!prompt.Contains("PRIVATE"));
        Check.Equal(0, images.Job.Specification.ReferenceImages.Length); Check.Equal("player", images.Job.Specification.Edition);
        var basis = images.Job.Specification.GenerationBasis!;
        Check.Equal(owner.Snapshot.Content!.Adventure!.Hash, basis.Adventure.Hash);
        Check.Equal(auth.Version, basis.StateVersion); Check.Equal("harbor", basis.SceneId);
        Check.Equal("public-place", basis.Places.Single().Id); Check.Equal(1, basis.Places.Single().Revision);
        Check.True(basis.Exits.All(e => e.Source == "authored" && e.RouteId == ""));
        var catalog = h.App.Services.GetRequiredService<MapCatalog>();
        await AssetTests.Until(() => Task.FromResult(catalog.Get(owner.Snapshot.Id, response.Map.Id, true).Status == "ready"));
        // This is the crash gap: no campaign/tool receipt was ever written, yet map-owned replay is exact.
        Check.Equal(HarnessJson.Serialize(first), HarnessJson.Serialize(await Request(h, owner, auth, command, fingerprint, version: auth.Version - 1, read: false)));
        await Reject(() => Request(h, owner, auth, command, "different"), "idempotency_conflict");
        Check.Equal(before, JsonSerializer.Serialize((await h.Get(owner.Snapshot.Id))!));
        var current = Read(await Request(h, owner, auth, Id(), Id(), kind: "dungeon")); Check.Equal(response.Map.Id, current.Map.Id); Check.Equal("ready", current.Map.Status); Check.Equal(1, images.Calls);
        // v15 decorates the first result and map-owned crash-gap replay identically.
        string v15Command = Id(), v15Fingerprint = Id();
        var v15 = await Request(h, owner, auth, v15Command, v15Fingerprint, contract: 15);
        Check.Equal("ready", JsonDocument.Parse(v15.Reply.Content).RootElement.GetProperty("map").GetProperty("status").GetString());
        Check.Equal("ready", JsonDocument.Parse(v15.Reply.Content).RootElement.GetProperty("protocol").GetProperty("phase").GetString());
        Check.Equal(HarnessJson.Serialize(v15), HarnessJson.Serialize(await Request(h, owner, auth, v15Command, v15Fingerprint,
            version: auth.Version - 1, contract: 15, read: false)));
        Check.Equal(before, JsonSerializer.Serialize((await h.Get(owner.Snapshot.Id))!));
        var map = catalog.Get(owner.Snapshot.Id, current.Map.Id, true);
        catalog.Publish(owner.Snapshot.Id, map.Id, new(Id(), map.Version, false, false));
        var withheld = Read(await Request(h, owner, auth, Id(), Id())); Check.Equal("withheld", withheld.Map.Status); Check.Equal(0, catalog.List(owner.Snapshot.Id, false, false).Maps.Length);
        var archived = await Post<ActionResponse>(h, owner.Snapshot.Id, "archive", new ArchiveCampaignRequest(Id(), auth.Version, true));
        Check.Equal(HarnessJson.Serialize(first), HarnessJson.Serialize(await Request(h, owner, auth, command, fingerprint)));
        await Reject(() => Request(h, owner, auth, Id(), Id(), archived.Snapshot.Version), "campaign_archived");
        Check.Equal(1, images.Calls); Check.Equal(0, model.Calls);
    }
    internal static T CatalogCall<T>(MapCatalog maps, string method, params object[] args)
    {
        try
        {
            var target = typeof(MapCatalog).GetMethod(method, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
            return (T)target.Invoke(maps, args.Concat(Enumerable.Repeat(Type.Missing, target.GetParameters().Length - args.Length)).ToArray())!;
        }
        catch (System.Reflection.TargetInvocationException ex) when (ex.InnerException is not null)
        { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw(); throw; }
    }
    public static Task CorruptReceiptsRefuseReadsAndGeneration()
    {
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-auto-map-" + Id());
        var config = AssetTests.Config(new() { ["DataPath"] = root });
        using var directory = new DataDirectory(config);
        var images = new Images(); var refs = new SceneReferences(directory);
        var maps = new MapCatalog(directory, images, refs, config);
        string campaign = Id(), actor = Id(), command = Id(), fingerprint = Id();
        var spec = AssetTests.Spec() with { Grid = new() { Uncalibrated = true } };
        var original = CatalogCall<AutomaticMapResponse>(maps, "RequestAutomatic", campaign, "harbor", 3, actor, command, fingerprint, spec);
        string path = Directory.GetFiles(Path.Combine(root, "maps"), "*.json", SearchOption.AllDirectories).Single();
        string saved = File.ReadAllText(path);
        foreach (var corrupt in new Action<System.Text.Json.Nodes.JsonObject>[]
        {
            node => node["automaticReceipts"] = null,
            node => node["automaticSceneId"] = null,
            node => node["automaticReceipts"]!.AsObject().First().Value!["response"] = null,
            node => node["automaticReceipts"]!.AsObject().First().Value!["response"]!["map"]!["id"] = Id(),
            node => node["automaticReceipts"]!.AsObject().First().Value!["response"]!["map"]!["published"] = true,
            node => node["specification"]!["grid"]!["uncalibrated"] = false
        })
        {
            var node = System.Text.Json.Nodes.JsonNode.Parse(saved)!.AsObject(); corrupt(node);
            string bad = node.ToJsonString(); File.WriteAllText(path, bad);
            Check.Throws<InvalidDataException>(() => CatalogCall<AutomaticMapResponse>(maps, "AutomaticReceipt", campaign, actor, command, fingerprint));
            Check.Throws<InvalidDataException>(() => CatalogCall<AutomaticMapResponse>(maps, "RequestAutomatic", campaign, "harbor", 3, actor, Id(), Id(), spec));
            Check.Throws<InvalidDataException>(() => maps.List(campaign, true, true));
            Check.Throws<InvalidDataException>(() => maps.Get(campaign, original.Map.Id, true));
            Check.Throws<InvalidDataException>(() => maps.Claim());
            Check.Throws<InvalidDataException>(() => new MapCatalog(directory, images, refs, config));
            Check.Equal(bad, File.ReadAllText(path));
        }
        File.WriteAllText(path, saved);
        var job = maps.Claim()!; maps.Fail(job, "fixture-failure");
        var failed = maps.Get(campaign, original.Map.Id, true);
        maps.Generate(campaign, failed.Id, new(Id(), failed.Version, true));
        job = maps.Claim()!; maps.Complete(job, AssetTests.Png);
        Check.True(!maps.Get(campaign, failed.Id, true).Published, "Manual retry must not silently republish an automatic map");
        Check.Equal(original, CatalogCall<AutomaticMapResponse>(maps, "AutomaticReceipt", campaign, actor, command, fingerprint));
        Check.True(!JsonSerializer.Serialize(new MapGrid(), JsonFiles.Options).Contains("uncalibrated"), "Old fingerprints remain unchanged");
        return Task.CompletedTask;
    }
    public static async Task DisabledAndInterruptedNeverRebill()
    {
        var model = new Model((_, _) => throw new Exception("No model calls"));
        await using (var offline = await Host.Start(configure: Configure(model)))
        {
            var owner = await Create(offline); var auth = await offline.App.Services.GetRequiredService<GameService>().AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
            Check.Equal("unavailable", Read(await Request(offline, owner, auth, Id(), Id())).Map.Status);
            Check.Equal(0, Directory.GetFiles(Path.Combine(offline.Root, "maps"), "*.json", SearchOption.AllDirectories).Length);
        }
        var images = new Images(hold: true); var h = await Host.Start(images: images, configure: Configure(model));
        try
        {
            var owner = await Create(h); var auth = await h.App.Services.GetRequiredService<GameService>().AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
            string command = Id(), fingerprint = Id(); var original = await Request(h, owner, auth, command, fingerprint);
            await AssetTests.Until(() => Task.FromResult(images.Calls == 1));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, configure: Configure(model));
            var next = Read(await Request(h, owner, auth, Id(), Id())); Check.Equal("failed", next.Map.Status);
            Check.Equal(HarnessJson.Serialize(original), HarnessJson.Serialize(await Request(h, owner, auth, command, fingerprint)));
            Check.Equal(1, images.Calls); Check.Equal(0, h.App.Services.GetRequiredService<MapCatalog>().List(owner.Snapshot.Id, false, false).Maps.Length);
        }
        finally { await h.DisposeAsync(); }
    }
}
