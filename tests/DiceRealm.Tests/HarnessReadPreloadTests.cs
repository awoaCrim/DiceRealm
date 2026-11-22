using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessReadPreloadTests
{
    private const string Secret = "PRELOAD_HIDDEN_ENEMY";
    private static AdventureDocument Document(string? arrival = null) => TestContent.Document with
    {
        SourceText = "NEVER_FULL_PRIVATE_SOURCE",
        Scenes = TestContent.Document.Scenes.Select(s => s with
        {
            Encounter = null,
            Arrival = s.Id == "harbor" ? arrival ?? "灯塔入口停着一辆旧货车。" : "NEVER_OTHER_SCENE_ARRIVAL",
            ImagePrompt = "NEVER_PRIVATE_IMAGE_PROMPT"
        }).ToArray()
    };

    private static HarnessModelRequest Request(HarnessExecutionFrame frame, int contract) => new(Preset.SystemPrompt,
        [new("user", HarnessJson.Serialize(new { input = frame.Context.Intent.Text, ruleset = "dnd2024", memory = new { } }))],
        HarnessTools.ForVersion(contract), 4096);
    private static int Bytes(HarnessModelRequest request) => HarnessContextCompactor.PreserveCurrent(request).Plan!.EffectiveBytes;
    private static void Measure(string scenario, HarnessExecutionFrame old, HarnessExecutionFrame current)
    {
        if (old.WorkingContext!.Guidance.Length > HarnessSceneContexts.MaximumGuidance)
        {
            Console.WriteLine($"PRELOAD_SIZE {scenario} v55=invalid_guidance_{old.WorkingContext.Guidance.Length}_chars v56={Bytes(HarnessExecutionProtocol.Project(Request(current, 56), current, 56))} bytes; no valid v55 request delta");
            return;
        }
        int before = Bytes(HarnessExecutionProtocol.Project(Request(old, 55), old, 55));
        int after = Bytes(HarnessExecutionProtocol.Project(Request(current, 56), current, 56));
        Console.WriteLine($"PRELOAD_SIZE {scenario} v55={before} v56={after} delta={after - before} bytes");
    }

    private static async Task PrepareEncounter(Host h, CreatedCampaign owner, SequenceDice dice, int count = 1, bool large = false)
    {
        string id = owner.Snapshot.Id;
        var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512)) with { CurrentScene = true };
        await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
        {
            var placements = Enumerable.Range(0, count).Select(i => new EncounterPlacement("xmm:goblin-warrior",
                Secret + i, "ranged", new(.5 + i * .03, .5), "three-quarters-cover",
                large ? new string('密', 490) : "隔离夹具：掩护后脱离视线。")).ToArray();
            var setup = RuntimeEncounters.Prepare(c, map, null, "隔离预载测试", c.SceneId,
                large ? new string('源', 790) : "隔离来源", large ? new string('据', 490) : "隔离布置", placements, namingVersion: 56);
            RuntimeEncounters.Establish(c, map, setup, placements, new RulesEngine(dice));
            c.HarnessSceneNarration = new(c.SceneId, c.Version);
            c.Version++;
            c.Events.Add(new(Id(), c.Version, "observe", "隔离预载夹具", "", "system", DateTimeOffset.UtcNow, null));
            return Task.FromResult(true);
        }, default);
    }

    public static async Task PurePinnedPrivateAndFrozen()
    {
        var fixture = new HarnessRulesTests.Fixture();
        string pin = fixture.Publish(HarnessRulesTests.Package(HarnessRulesTests.Entry()));
        var dice = new SequenceDice(19);
        var model = new Model((_, _) => throw new Exception("No provider expected"));
        await using var h = await Host.Start(dice: dice, configure: fixture.Configure(model));
        var owner = await Create(h, Document()); var guest = await HarnessBoundaryTests.Guest(h, owner);
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(owner.Snapshot.Id, guest.AccessToken, default);
        string intentId = Id();
        async Task<HarnessExecutionFrame> Read(int contract) => await game.ReadHarnessExecution(owner.Snapshot.Id,
            guest.AccessToken, auth.ActorId, intentId, "看一下周围", auth.Version, default, contract, rulesCatalogVersion: pin);
        var empty = await Read(56);
        Check.Equal(JsonValueKind.Null, empty.ReadPreload!.Encounter!.Value.GetProperty("encounter").ValueKind);
        Check.Equal("included", empty.ScenePresentation!.ArrivalStatus);
        Check.True(!HarnessJson.Serialize(empty).Contains("NEVER_"));
        Measure("first-entry", await Read(55), empty);
        await h.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
        { c.HarnessSceneNarration = new(c.SceneId, c.Version); return Task.FromResult(true); }, default);
        Measure("visited-no-encounter", await Read(55), await Read(56));
        var publicMap = SharedBoardTests.Install(h, owner.Snapshot.Id);
        await h.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
        {
            SharedBoard.Execute(c, publicMap, new(Id(), c.Version, publicMap.Id, "spawn", Spawns:
                [new("", "creature", new("player", c.ActingActorId), new("Arden"), .2, .3, c.ActingActorId)], ExpectedMapVersion: publicMap.Version));
            c.Version++; c.Events.Add(new(Id(), c.Version, "observe", "公开棋子夹具", "", "system", DateTimeOffset.UtcNow, null));
            return Task.FromResult(true);
        }, default);
        auth = await game.AuthorizeHarness(owner.Snapshot.Id, guest.AccessToken, default);
        Check.Equal(0, (await Read(56)).ReadPreload!.Encounter!.Value.GetProperty("roster").GetArrayLength());
        // Moving the active pointer does not change a previously bound run's availability.
        fixture.Publish(HarnessRulesTests.Package(HarnessRulesTests.Entry(text: "另一版仅测试正文")));
        await PrepareEncounter(h, owner, dice);
        auth = await game.AuthorizeHarness(owner.Snapshot.Id, guest.AccessToken, default);
        string db = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite"); byte[] before = File.ReadAllBytes(db);
        var old = await Read(55); string oldBytes = HarnessJson.Serialize(old);
        Check.Equal("", old.ScenePresentation!.Arrival); Check.True(!oldBytes.Contains("readPreload") && !oldBytes.Contains("arrivalStatus"));
        var frame = await Read(56); HarnessExecutionProtocol.Validate(frame, auth.Version, 56);
        Check.Equal("dm_only", frame.ReadPreload!.Audience);
        Check.Equal(pin, frame.ReadPreload.RulesScope!.Value.GetProperty("localRules").GetProperty("catalogVersion").GetString());
        Check.True(frame.ReadPreload.Encounter!.Value.GetRawText().Contains(Secret));
        Check.True(!HarnessJson.Serialize(frame.Context).Contains(Secret) && !HarnessJson.Serialize(frame.Board).Contains(Secret));
        Check.Equal(Document().Scenes.Single(s => s.Id == "harbor").Arrival, frame.ScenePresentation!.Arrival);
        Check.True(oldBytes == HarnessJson.Serialize(await Read(55)), "Historical frame bytes changed");
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame with { ReadPreload = null }, auth.Version, 56));
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(old with { ReadPreload = frame.ReadPreload }, auth.Version, 55));
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame with { ReadPreload = frame.ReadPreload with { Audience = "public" } }, auth.Version, 56));
        foreach (string name in new[] { "encounter_read", "rules_scope" })
        {
            var reply = await game.HarnessTool(owner.Snapshot.Id, guest.AccessToken, auth.ActorId, Id(), "看一下周围",
                auth.Version, Id(), Id(), new(name, HarnessJson.Element(new { }), Id()), [], default, auth.Profile, 56, rulesCatalogVersion: pin);
            var value = JsonNode.Parse(reply.Reply.Content)!.AsObject(); value.Remove("protocol");
            var supplied = name == "encounter_read" ? frame.ReadPreload.Encounter!.Value : frame.ReadPreload.RulesScope!.Value;
            Check.True(JsonNode.DeepEquals(value, JsonNode.Parse(supplied.GetRawText())), "Preload must match existing read projection");
        }
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.True(!(await h.Http.GetStringAsync($"/api/v1/campaigns/{owner.Snapshot.Id}")).Contains(Secret));
        var publicRead = await game.HarnessTool(owner.Snapshot.Id, guest.AccessToken, auth.ActorId, Id(), "看一下周围", auth.Version,
            Id(), Id(), new("context_read", HarnessJson.Element(new { }), Id()), [], default, auth.Profile, 56);
        Check.True(!publicRead.Reply.Content.Contains(Secret));
        try { await game.ReadHarnessExecution(owner.Snapshot.Id, "bad-token", auth.ActorId, Id(), "读取", auth.Version, default, 56); throw new Exception("Unauthorized preload"); }
        catch (GameException) { }
        Check.True(before.SequenceEqual(File.ReadAllBytes(db)), "Reads must not change game data");
        Check.Equal(1, dice.Count); Check.Equal(0, model.Calls);
        Measure("visited-hidden-encounter", old, frame);

        // Opening generation intentionally cannot read host encounters or rules_scope.
        var entry = await Create(h, Document() with { Opening = new("harbor", ["harbor"]) });
        await PrepareEncounter(h, entry, new SequenceDice(19));
        var entryAuth = await game.AuthorizeHarness(entry.Snapshot.Id, entry.AccessToken, default);
        var opening = await game.ReadHarnessExecution(entry.Snapshot.Id, entry.AccessToken, entryAuth.ActorId,
            Id(), HarnessOpenings.Input, entryAuth.Version, default, 56, opening: true);
        HarnessExecutionProtocol.Validate(opening, entryAuth.Version, 56);
        Check.True(opening.ReadPreload is null && !HarnessJson.Serialize(opening).Contains(Secret));
    }

    public static async Task SizeOmissionAndTransportFallback()
    {
        var dice = new SequenceDice(19, 19, 19, 19, 19, 19);
        await using var h = await Host.Start(dice: dice, configure: Configure(new Model((_, _) => throw new Exception("No provider expected"))));
        var owner = await Create(h, Document(new string('景', 7900)));
        await PrepareEncounter(h, owner, dice, 6, large: true);
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
        var frame = await game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "继续观察", auth.Version, default, 56);
        HarnessExecutionProtocol.Validate(frame, auth.Version, 56);
        Check.Equal("omitted_size", frame.ScenePresentation!.ArrivalStatus); Check.Equal("", frame.ScenePresentation.Arrival);
        Check.True(frame.ReadPreload!.Encounter is null && frame.ReadPreload.Omitted.Contains("encounter:size"));
        HarnessExecutionProtocol.Validate(HarnessJson.Read<HarnessExecutionFrame>(HarnessJson.Element(frame)), auth.Version, 56);
        var detail = await game.HarnessTool(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "继续观察", auth.Version, Id(), Id(),
            new("context_read", HarnessJson.Element(new { scope = "scene" }), Id()), [], default, auth.Profile, 56);
        Check.Equal(7900, JsonDocument.Parse(detail.Reply.Content).RootElement.GetProperty("scenePresentation").GetProperty("arrival").GetString()!.Length);
        var old = await game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "继续观察", auth.Version, default, 55);
        Measure("oversized-preload-omitted", old, frame);

        // Exercise the actual new-slot transport planner: optional data yields before any
        // history summary or provider request. A large required payload still fails closed.
        var request = Request(frame, 56);
        int minimalBytes = Bytes(HarnessExecutionProtocol.Project(request, HarnessReadPreloads.OmitForTransport(frame), 56));
        int systemBytes = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(request.System,
            new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        request = request with { System = new string('x', HarnessContextCompactor.MaximumPreparedBytes - minimalBytes + systemBytes - 2 - 64) };
        var run = new HarnessRun { Id = Id(), IntentId = Id(), CampaignId = owner.Snapshot.Id, Fingerprint = "test",
            Profile = auth.Profile, Limits = new(), ActorId = auth.ActorId, ToolContractVersion = 56, Input = frame.Context.Intent.Text };
        var method = typeof(HarnessRunService).GetMethod("PrepareHistoryTransport", BindingFlags.NonPublic | BindingFlags.Static)!;
        var result = ((HarnessExecutionFrame Frame, HarnessPreparedContext Prepared))method.Invoke(null, [run, request, frame])!;
        Check.Equal("omitted_transport", result.Frame.ScenePresentation!.ArrivalStatus);
        Check.True(result.Frame.ReadPreload!.Encounter is null && result.Frame.ReadPreload.RulesScope is null);
        Check.True(result.Frame.ReadPreload.Omitted.Contains("rules_scope:transport"));
        Check.Equal(HarnessJson.Serialize(frame.History), HarnessJson.Serialize(result.Frame.History));
        Check.True(result.Prepared.Plan!.EffectiveBytes <= HarnessContextCompactor.MaximumPreparedBytes);
        try { method.Invoke(null, [run, request with { System = new string('x', HarnessContextCompactor.MaximumPreparedBytes) }, frame]); throw new Exception("Oversized required request accepted"); }
        catch (TargetInvocationException error) { Check.True(error.InnerException is GameException { Code: "harness_transport_limit" }); }
        Check.Equal(6, dice.Count);
    }

    public static async Task RealPiBatchFreezeRestartAndReplay()
    {
        var fixture = new HarnessRulesTests.Fixture(); string pin = fixture.Publish(HarnessRulesTests.Package(HarnessRulesTests.Entry()));
        var model = new Model((call, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            if (call >= 4)
            {
                Check.True(!frame.TryGetProperty("readPreload", out _));
                Check.Equal(HarnessDmChecklist.InstructionsFor(55), frame.GetProperty("dmChecklist").GetProperty("instructions").GetString());
                Check.True(call <= 5);
                return call == 4 ? Tool("ask_player", new { question = "旧运行继续吗？" })
                    : Tool("world_record", new NarrativeHarnessArgs("旧运行按原合同完成。", []));
            }
            Check.True(frame.TryGetProperty("readPreload", out var reads));
            Check.Equal(pin, reads.GetProperty("rulesScope").GetProperty("localRules").GetProperty("catalogVersion").GetString());
            Check.True(frame.GetProperty("dmChecklist").GetProperty("instructions").GetString()!.Contains("在同一条回复中一起发出多个tool call"));
            Check.Equal(Preset.SystemPrompt, request.System);
            if (call == 1) return new("", [new("one", "rules_search", HarnessJson.Element(new { query = "火球" })),
                new("two", "checks_result", HarnessJson.Element(new { scope = "scene" }))], 10, 10);
            if (call == 2)
            {
                Check.Equal(2, request.Messages.Count(m => m.Role == "tool"));
                fixture.Publish(HarnessRulesTests.Package(HarnessRulesTests.Entry(text: "稍后版本不应替换本Run的绑定")));
                return Tool("ask_player", new { question = "准备继续吗？" });
            }
            Check.Equal(3, call);
            return Tool("world_record", new NarrativeHarnessArgs("灯塔前的货车仍停在原处。", []));
        });
        var dice = new SequenceDice(); var h = await Host.Start(dice: dice, configure: fixture.Configure(model, pi: true));
        try
        {
            var owner = await Create(h, Document()); string id = owner.Snapshot.Id;
            var request = new AdventureActionRequest(Id(), owner.Snapshot.Version, "读取规则并核对已有检定，不执行新检定");
            var session = await Post<AdventureSessionView>(h, id, "adventure/actions", request);
            var run = await Settled(h, id, session.SessionId, 3000);
            Check.Equal("waiting", run.Status); Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion);
            string frozen = HarnessJson.Serialize(saved.Steps.First(s => s.Kind == "model").ExecutionFrame);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: fixture.Configure(model, pi: true));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var restored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(frozen, HarnessJson.Serialize(restored.Steps.First(s => s.Kind == "model").ExecutionFrame));
            _ = await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id}/harness/runs/{run.Id}");
            _ = await Post<AdventureSessionView>(h, id, "adventure/actions", request);
            Check.Equal(2, model.Calls); // GET and original input replay never issue another model request.
            var resume = new HarnessResumeRequest(Id(), run.Version, "继续");
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            var done = await Settled(h, id, run.Id, 3000); Check.Equal("completed", done.Status);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            Check.Equal(3, model.Calls); Check.Equal(0, dice.Count);
            var final = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(frozen, HarnessJson.Serialize(final.Steps.First(s => s.Kind == "model").ExecutionFrame));
            Check.True(final.Steps.Where(s => s.Kind == "model").All(s => s.ExecutionFrame?.ReadPreload is not null));

            var historical = await StartHistorical(h, id, new(Id(), done.Version, "继续旧的探索"), 55);
            historical = await Settled(h, id, historical.Id, 3000); Check.Equal("waiting", historical.Status);
            var old = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, historical.Id)!;
            string oldFrame = HarnessJson.Serialize(old.Steps.First(s => s.Kind == "model").ExecutionFrame);
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: fixture.Configure(model, pi: true));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(4, model.Calls);
            await Post<HarnessRunView>(h, id, $"harness/runs/{historical.Id}/resume", new HarnessResumeRequest(Id(), historical.Version, "继续"));
            historical = await Settled(h, id, historical.Id, 3000); Check.Equal("completed", historical.Status);
            old = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, historical.Id)!;
            Check.Equal(55, old.ToolContractVersion); Check.Equal(5, model.Calls);
            Check.Equal(oldFrame, HarnessJson.Serialize(old.Steps.First(s => s.Kind == "model").ExecutionFrame));
            Check.True(old.Steps.Where(s => s.Kind == "model").All(s => s.ExecutionFrame?.ReadPreload is null));
        }
        finally { await h.DisposeAsync(); }
    }
}
