using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class WorldRouteTests
{
    private const string Place = "old-mill", Secret = "secret-place";
    private static AdventureDocument Document() => TestContent.Document with { InitialKnowledge =
    [
        new(Place, "place", "旧磨坊", "村民指明了一条往返各需三分钟的小路，未说明地图坐标。", "", "public"),
        new(Secret, "place", "SECRET-HOME", "SECRET-BODY", "", "host"),
        new("arrival-place", "place", "ARRIVAL-HOME", "ARRIVAL-BODY", "", "arrival", "beacon")
    ] };
    private static Campaign Campaign()
    {
        var c = TestContent.Campaign(); c.Adventure = Document(); WorldMemories.Seed(c, 1); return c;
    }
    private static WorldRouteProposal Proposal() => new("", "", Place, 180, true, true, "村民已说明往返小路及各三分钟的步行时间。");
    private static string Serialize(object c) => HarnessJson.Serialize(c);
    private static void Reject(string code, Action call)
    {
        try { call(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static async Task Reject(string code, Func<Task> call)
    {
        try { await call(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static WorldRoutePlan Plan(Campaign c, WorldRouteProposal? p = null) => WorldRoutes.Plan(c, p ?? Proposal(),
        c.WorldMemory.Select(m => m.Id).ToHashSet(), WorldRoutes.KnownScenes(c), c.Version + 1);
    private static void Apply(Campaign c, WorldRoutePlan p)
    {
        WorldRoutes.Apply(c, p, Id()); c.Version++; WorldRoutes.ValidateState(c);
    }
    public static Task PurePlansTopologyAndVisibility()
    {
        var c = Campaign(); string before = Serialize(c), authored = Serialize(c.Adventure!);
        var plan = Plan(c);
        var knownRoutes = WorldRoutes.KnownRoutes(c);
        Check.Equal(Adventure.Exits(c).Length, knownRoutes.Length);
        Check.True(knownRoutes.All(r => r.Source == "authored" && r.Id == "" && r.CanTravel && !r.Editable));
        Check.True(!knownRoutes.Any(r => r.To == "beacon"), "Locked authored destinations must not leak");
        Check.Equal(before, Serialize(c)); Check.True(c.WorldAtlas is null);
        Apply(c, plan); string target = plan.Route.To;
        Check.Equal(authored, Serialize(c.Adventure!)); Check.Equal(1, c.WorldAtlas!.Routes.Count);
        Check.Equal(0L, c.ElapsedSeconds); Check.Equal("harbor", c.SceneId);
        var routeRead = WorldRoutes.KnownRoutes(c).Single(r => r.Source == "dynamic");
        Check.Equal(plan.Route.Id, routeRead.Id); Check.True(routeRead.CanTravel && routeRead.Editable && routeRead.Bidirectional);
        var map = Adventure.Map(c, Adventure.Choices(c));
        Check.True(map.Nodes.Single(n => n.Id == target).Unlocated);
        Check.True(map.Nodes.Single(n => n.Id == target).CanTravel);
        Check.Equal(180, Adventure.Exits(c).Single(e => e.Target == target).Seconds);
        Check.Equal("旧磨坊", Adventure.ForScene(c, target).Title);
        Check.True(!Serialize(map).Contains("SECRET"));
        c.SceneId = target; c.VisitedScenes.Add(target);
        Check.True(!ContentRuntime.SafeRest(c)); Check.Equal(0, ContentRuntime.Choices(c).Length);
        Check.Equal("harbor", Adventure.Exits(c).Single().Target);
        Check.True(Adventure.Map(c, Adventure.Choices(c)).Edges.Any(e => e.From == "harbor" && e.To == target));
        Check.Equal("旧磨坊", ActionInformation.Build(c, Adventure.Choices(c)).Single(a => a.Kind == "observe").Details!.TargetLabel);
        var change = Plan(c, new(plan.Route.Id, "", "", 240, false, true, "改为单向离港路线；反方向不可通行。"));
        Apply(c, change); Check.Equal(0, Adventure.Exits(c).Length);
        Check.True(!WorldRoutes.KnownRoutes(c).Single().CanTravel, "Incoming-only routes are not outbound travel");
        Check.True(!WorldRoutes.KnownRoutes(c).Single().Bidirectional);
        c.SceneId = "harbor";
        Check.Equal(240, Adventure.Exits(c).Single(e => e.Target == target).Seconds);
        Apply(c, Plan(c, new(plan.Route.Id, "", "", 240, false, false, "小路被落石关闭。")));
        Check.True(!Adventure.Choices(c).Any(a => a.Kind == "travel" && a.Target == target));
        Check.True(!WorldRoutes.View(c).Single().Open);
        Check.True(!WorldRoutes.KnownRoutes(c).Single(r => r.Source == "dynamic").CanTravel);
        Apply(c, Plan(c, new(plan.Route.Id, "", "", 180, true, true, "清理落石后按原路线通行。")));
        // A same-source correction updates the real scene; it never changes geometry or time.
        WorldMemories.Correct(c, new(Id(), c.Version, Place, 1, "老磨坊", "门口现有公开告示。", "active", false, "核对名称")); c.Version++;
        Check.Equal("老磨坊", Adventure.ForScene(c, target).Title);
        WorldMemories.Correct(c, new(Id(), c.Version, Place, 2, "HIDDEN-MILL", "HIDDEN-MILL-BODY", "active", true, "隐去错误信息")); c.Version++;
        Check.True(!Adventure.Map(c, Adventure.Choices(c)).Nodes.Any(n => n.Id == target));
        Check.True(!Adventure.Choices(c).Any(a => a.Kind == "travel" && a.Target == target));
        Check.Equal(0, WorldRoutes.View(c).Length);
        c.SceneId = target;
        Check.Equal("未公开地点", Adventure.Current(c).Title);
        Check.Equal("harbor", Adventure.Exits(c).Single().Target); // can safely return, no soft lock
        Check.True(!Serialize(Adventure.Map(c, Adventure.Choices(c))).Contains("HIDDEN-MILL"));
        Check.Equal(authored, Serialize(c.Adventure!));
        Check.Equal("df73540bca035d30aa9bfce33f88544407190d0c3d8ee971783cd5cf2101165e",
            HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(5))));
        Check.True(!HarnessTools.ForVersion(5).Any(t => t.Name == "world_route_propose"));
        Check.True(HarnessTools.ForVersion(6).Any(t => t.Name == "world_route_propose"));
        return Task.CompletedTask;
    }
    public static Task RejectedReferencesAndAuthoredLocks()
    {
        var c = Campaign(); var known = WorldRoutes.KnownScenes(c); string before = Serialize(c);
        Reject("invalid_world_route", () => WorldRoutes.Plan(c, Proposal(), new HashSet<string>(), known, 2));
        foreach (var p in new[] { Proposal() with { MemoryId = Secret }, Proposal() with { MemoryId = "arrival-place" },
            Proposal() with { MemoryId = "foreign" }, Proposal() with { Seconds = 0 }, Proposal() with { Seconds = 604801 },
            Proposal() with { SceneId = "harbor" }, Proposal() with { MemoryId = "", SceneId = "beacon" },
            Proposal() with { MemoryId = "", SceneId = "harbor" }, Proposal() with { RouteId = Id() } })
            Reject("invalid_world_route", () => Plan(c, p));
        Check.Equal(before, Serialize(c));
        // An authored edge stays protected even when its destination has been visited before.
        c.VisitedScenes.Add("causeway");
        Reject("invalid_world_route", () => Plan(c, Proposal() with { MemoryId = "", SceneId = "causeway" }));
        var old = c.WorldMemory[0]; c.WorldMemory[0] = old with { Name = c.Adventure!.Scenes.Single(s => s.Id == "beacon").Title };
        Reject("invalid_world_route", () => Plan(c)); c.WorldMemory[0] = old;
        c.WorldMemory[0] = old with { SceneId = "harbor" }; Reject("invalid_world_route", () => Plan(c)); c.WorldMemory[0] = old;
        var plan = Plan(c); c.WorldMemory[0] = old with { Revision = 2 };
        Reject("invalid_world_route", () => WorldRoutes.Apply(c, plan, Id())); Check.True(c.WorldAtlas is null);
        c.WorldMemory[0] = old; Apply(c, plan);
        Reject("invalid_world_route", () => Plan(c)); // same place/pair must use existing route ID
        Reject("world_route_unchanged", () => Plan(c, new(plan.Route.Id, "", "", 180, true, true, "相同内容")));
        Reject("invalid_world_memory", () => WorldMemories.Plan(c,
            [new(Place, "place", old.Name, old.Summary, "known", "harbor")], new HashSet<string> { Place }, known, 1, "fixture"));
        before = Serialize(c); WorldRoutes.ValidateState(c); Check.Equal(before, Serialize(c));
        c.WorldAtlas!.Routes[0] = c.WorldAtlas.Routes[0] with { Seconds = 0 };
        Reject("invalid_world_atlas", () => WorldRoutes.ValidateState(c));
        return Task.CompletedTask;
    }
    public static async Task AuthorityWaitingAndAtomicReceipts()
    {
        var dice = new SequenceDice(); var model = new Model((_, _) => throw new Exception("No provider expected"));
        var host = await Host.Start(dice: dice, configure: Configure(model));
        try
        {
            var owner = await Create(host, Document()); string id = owner.Snapshot.Id;
            var guest = await HarnessBoundaryTests.Guest(host, owner);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var game = host.App.Services.GetRequiredService<GameService>();
            var auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
            var state = (await host.Get(id))!; int version = state.Version; string runId = Id(), command = Id(), fingerprint = Id();
            Task<HarnessToolOutcome> Call(string name, object args, bool read = true, string[]? refs = null, int contract = 6) => game.HarnessTool(id,
                guest.AccessToken, auth.ActorId, runId, "从这里通往旧磨坊的小路，各需三分钟", version, command, fingerprint,
                new(name, HarnessJson.Element(args), "route"), [], default, auth.Profile, contract, read, refs);
            string path = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] before = File.ReadAllBytes(path);
            await Reject("harness_context_required", () => Call("world_route_propose", Proposal(), read: false, refs: [Place]));
            await Reject("invalid_world_route", () => Call("world_route_propose", Proposal()));
            await Reject("harness_tool_unavailable", () => Call("world_route_propose", Proposal(), refs: [Place], contract: 5));
            await Reject("harness_invalid_payload", () => Call("world_route_propose", new { routeId = "", sceneId = "", memoryId = Place,
                seconds = 180, bidirectional = true, open = true, reason = "test", hp = 100 }, refs: [Place]));
            Check.True(before.SequenceEqual(File.ReadAllBytes(path)));
            var outcome = await Call("world_route_propose", Proposal(), refs: [Place]);
            Check.Equal("intent", outcome.Wait!.Kind); Check.Equal(version + 1, outcome.Version);
            Check.Equal(Serialize(outcome), Serialize(await Call("world_route_propose", Proposal(), refs: [Place])));
            state = (await host.Get(id))!;
            Check.Equal(Serialize(owner.Snapshot.Map), Serialize(state.Map)); Check.Equal(0L, state.ElapsedSeconds);
            Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
            Check.True(state.PendingIntent!.Options[0].Details.TargetLabel.Contains("180 秒"));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var privateView = (await host.Get(id))!;
            Check.True(privateView.PendingIntent is null && !privateView.Events.Any(e => e.Resolution?.IntentId == runId));
            var confirm = new IntentResponseRequest(Id(), state.Version, runId, "choose", "world-route");
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/intents/respond", confirm)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var responses = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Post<ActionResponse>(host, id, "intents/respond", confirm)));
            Check.Equal(1, responses.Count(r => !r.Replayed)); Check.True(responses.All(r => r.Resolution.Kind == "world.route"));
            state = responses[0].Snapshot; string target = state.Map.Nodes.Single(n => n.Title == "旧磨坊").Id;
            Check.True(state.AvailableActions.Any(a => a.Kind == "travel" && a.Target == target));
            Check.Equal(0L, state.ElapsedSeconds); Check.Equal(1, state.Events.Count(e => e.Kind == "world.route"));
            var root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, dice: dice, configure: Configure(model));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.True((await Post<ActionResponse>(host, id, "intents/respond", confirm)).Replayed);
            state = (await host.Get(id))!;
            var travel = new ActionRequest(Id(), state.Version, "travel", target);
            var moved = await Post<ActionResponse>(host, id, "actions/propose", travel);
            Check.Equal(180L, moved.Snapshot.ElapsedSeconds); Check.Equal(target, moved.Snapshot.Scene.Id);
            Check.Equal("旧磨坊", moved.Snapshot.Scene.Title); Check.True(moved.Snapshot.Map.Nodes.Single(n => n.Id == target).Unlocated);
            Check.True((await Post<ActionResponse>(host, id, "actions/propose", travel)).Replayed);
            state = (await host.Act(moved.Snapshot, "travel", "harbor")).Snapshot; Check.Equal(360L, state.ElapsedSeconds);
            Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/intents/respond", confirm with { Decision = "cancel", OptionId = "" })).StatusCode);
        }
        finally { await host.DisposeAsync(); }
    }
    public static async Task RealPiProposalConfirmTravelAndRestart()
    {
        string target = "";
        var model = new Model((n, request) =>
        {
            if (n == 1) return Tool("context_read");
            if (n == 2) return Tool("world_route_propose", Proposal());
            if (n == 3) return Tool("context_read");
            if (n == 4) return Tool("actions_propose", new { candidateId = Candidate(request, "前往旧磨坊") });
            if (n == 5) return Tool("world_routes");
            Check.Equal(6, n);
            using var result = JsonDocument.Parse(request.Messages.Last(m => m.Name == "world_routes").Content);
            var route = result.RootElement.GetProperty("routes")[0]; target = route.GetProperty("to").GetString()!;
            Check.Equal(180, route.GetProperty("seconds").GetInt32());
            return Text("已确认小路并抵达旧磨坊，往返路线可用，地图坐标仍未知。");
        });
        var configure = Configure(model, extra: b => { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(host, Document()); string id = owner.Snapshot.Id;
            var req = new AdventureActionRequest(Id(), owner.Snapshot.Version, "确认村民说的三分钟往返小路，之后去旧磨坊。");
            var started = await Post<AdventureSessionView>(host, id, "adventure/actions", req);
            var run = await Settled(host, id, started.SessionId, 3000);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error); Check.Equal(2, model.Calls);
            var state = (await host.Get(id))!; Check.Equal(0L, state.ElapsedSeconds);
            Check.True(!state.Map.Nodes.Any(n => n.Title == "旧磨坊"));
            var prefix = Serialize(host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!.Steps);
            var root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, dice: dice, configure: configure);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<AdventureSessionView>(host, id, "adventure/actions", req)).Replayed); Check.Equal(2, model.Calls);
            state = (await Post<ActionResponse>(host, id, "intents/respond", new IntentResponseRequest(Id(), state.Version, run.Wait!.Id, "choose", "world-route"))).Snapshot;
            Check.Equal(0L, state.ElapsedSeconds);
            var resume = new AdventureActionRequest(Id(), state.Version, "");
            await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume);
            run = await Settled(host, id, run.Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error); Check.Equal(6, model.Calls);
            state = (await host.Get(id))!; Check.Equal(target, state.Scene.Id); Check.Equal(180L, state.ElapsedSeconds); Check.Equal(0, dice.Count);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(prefix, Serialize(saved.Steps.Take(4).ToList()));
            Check.True((await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume)).Replayed);
            Check.Equal(6, model.Calls); Check.True(model.Requests.All(r => !Serialize(r).Contains("SECRET") && !Serialize(r).Contains("ARRIVAL-HOME")));
            Console.WriteLine("WORLD ROUTE real Pi/MCP: own confirmation -> dynamic scene -> travel, 6 fake calls, restart and exact replay; 0 dice/images");
        }
        finally { await host.DisposeAsync(); }
    }
}
