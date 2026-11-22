using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessFlowRepairTests
{
    public static async Task SceneCheckConsentRestartAndReplay()
    {
        var scene = TestContent.Document.Scenes.Single(s => s.Id == "harbor");
        var model = new Model((call, request) => call switch
        {
            1 => Tool("context_read", new { scope = "context", query = "伏击" }),
            // Contract 50+: an active check fixes its DC (with reason) before the player's consent.
            2 => Tool("check_request", new { ability = "wisdom", skill = "Perception", mode = "normal", dc = 12, reason = "码头嘈杂，辨别附近动静难度中等。", sourceId = scene.Id, quote = scene.Summary }),
            3 => Tool("world_record", new NarrativeHarnessArgs("", [], Paragraphs: ["承接真实检定；没有自动改变剧情事实。", @"字面引用 C:\new\notes 和 \n 保留。"])), 
            _ => throw new Exception("Repeated check/model call")
        });
        var dice = new SequenceDice(16);
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var run = await Start(h, owner.Snapshot, "我留在原地，仔细搜寻附近的动静。");
            run = await Settled(h, id, run.Id, 3000); Check.Equal("waiting", run.Status); Check.Equal("roll", run.Wait!.Kind);
            var snapshot = (await h.Get(id))!; Check.Equal(0, dice.Count); Check.Equal(0, snapshot.PendingRulings.Length);
            Check.True(snapshot.PendingRoll!.Available); Check.True(!snapshot.PendingRoll.Description.Contains(scene.Summary));
            var preview = snapshot.PendingRoll.Preview!;
            Check.Equal("wisdom", preview.Ability); Check.Equal("Perception", preview.Skill);
            Check.True(preview.HasDc && !preview.Opposed); Check.Equal(12, preview.Dc);
            var response = new RollResponseRequest(Id(), snapshot.Version, run.Wait.Id, "roll");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var rolled = await Post<ActionResponse>(h, id, "rolls/respond", response);
            Check.Equal(1, dice.Count); Check.Equal("check.resolve", rolled.Resolution.Kind); Check.True(rolled.Resolution.Check!.HasDc); Check.True(rolled.Resolution.Check.Success);
            Check.Equal(run.IntentId, rolled.Resolution.IntentId);
            Check.Equal(preview.Modifier, rolled.Resolution.Check.Modifier); Check.Equal(preview.Mode, rolled.Resolution.Check.Mode);
            var replay = await Post<ActionResponse>(h, id, "rolls/respond", response);
            Check.True(replay.Replayed); Check.Equal(1, dice.Count); Check.Equal(rolled.Snapshot.Version, replay.Snapshot.Version);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), rolled.Snapshot.Version));
            run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "completed", "Run failed: " + run.Error + " calls=" + model.Calls); Check.Equal(3, model.Calls); Check.Equal(1, dice.Count);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            var entry = activity.Entries.Single(e => e.ActionId == run.IntentId);
            Check.True(entry.Steps!.Any(s => s.Result.Kind == "check.resolve"));
            Check.Equal("承接真实检定；没有自动改变剧情事实。\n\n" + @"字面引用 C:\new\notes 和 \n 保留。", run.Text);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            var original = saved.Steps.Last(s => s.ToolName == "world_record").ToolRequest!.Arguments;
            Check.Equal("", original.GetProperty("narrative").GetString()!);
            Check.Equal(@"字面引用 C:\new\notes 和 \n 保留。", original.GetProperty("paragraphs")[1].GetString()!);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task CheckBoundariesAndPassiveScore()
    {
        var dice = new SequenceDice(10); var model = new Model((_, _) => throw new Exception("No model calls"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(h);
        string id = owner.Snapshot.Id; var game = h.App.Services.GetRequiredService<GameService>();
        var scene = TestContent.Document.Scenes.Single(s => s.Id == "harbor");
        async Task<HarnessToolOutcome> Call(HarnessCheckArgs args, string? run = null, string? command = null, int contract = 31)
        {
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            return await game.HarnessTool(id, owner.AccessToken, auth.ActorId, run ?? Id(), "判断周围动静", auth.Version,
                command ?? Id(), "fixed-fixture", new("check_request", HarnessJson.Element(args), "check"), [], default, auth.Profile, contract, contextAlreadyRead: true);
        }
        var spec = new HarnessCheckArgs("wisdom", "Perception", "normal", scene.Id, scene.Summary, Dc: 12);
        int version = (await h.Get(id))!.Version;
        try { await Call(spec, contract: 34); throw new Exception("Scene prose incorrectly authorized a numeric DC"); }
        catch (GameException e) { Check.Equal("check_source_unavailable", e.Code); }
        Check.Equal(version, (await h.Get(id))!.Version); Check.Equal(0, dice.Count);
        var unopposed = await Call(spec with { Dc = null, Passive = true }, contract: 34);
        using (var unopposedJson = System.Text.Json.JsonDocument.Parse(unopposed.Reply.Content))
        {
            var check = unopposedJson.RootElement.GetProperty("resolution").GetProperty("check");
            Check.True(!check.GetProperty("hasDc").GetBoolean()); Check.True(!check.GetProperty("success").GetBoolean());
        }
        version = (await h.Get(id))!.Version;
        foreach (var bad in new[] { spec with { Dc = 0 }, spec with { Skill = "Athletics" }, spec with { Quote = "not supplied" },
            spec with { SourceId = "causeway" }, spec with { Ability = "strength", Skill = "Athletics", Passive = true } })
        {
            try { await Call(bad); throw new Exception("Accepted invalid scene check"); }
            catch (GameException e) { Check.True(e.Code is "invalid_ruling_check" or "check_source_unavailable"); }
            Check.Equal(version, (await h.Get(id))!.Version); Check.Equal(0, dice.Count);
        }
        try { await Call(spec, contract: 30); throw new Exception("Changed v30 execution"); }
        catch (GameException e) { Check.Equal("harness_tool_unavailable", e.Code); }
        var store = h.App.Services.GetRequiredService<CampaignStore>(); int passive = 0;
        await store.Access(id, owner.AccessToken, true, c =>
        {
            PartyEngine.SetCharacter(c, c.ActingActorId, c.ActingCharacter with { Exhaustion = 1, Conditions = ["Poisoned"] });
            passive = RulesEngine.PassivePerception(c.ActingCharacter);
            Check.Equal(10 + RulesEngine.TestModifier(c.ActingCharacter, "wisdom", "Perception", false) - 5, passive);
            Check.Equal(passive + 5, RulesEngine.PassivePerception(c.ActingCharacter, "advantage"));
            return Task.FromResult(true);
        }, default);
        string runId = Id(), commandId = Id();
        var result = await Call(spec with { Passive = true }, runId, commandId);
        Check.True(result.Wait is null); Check.Equal(0, dice.Count);
        var replay = await Call(spec with { Passive = true }, runId, commandId); Check.Equal(result.Version, replay.Version);
        using var json = System.Text.Json.JsonDocument.Parse(result.Reply.Content); var payload = json.RootElement;
        Check.Equal(passive, payload.GetProperty("resolution").GetProperty("check").GetProperty("total").GetInt32());
        Check.Equal(0, payload.GetProperty("resolution").GetProperty("check").GetProperty("rolls").GetArrayLength());
        Check.True((await h.Get(id))!.PendingRoll is null);
        foreach (bool passiveAgain in new[] { true, false })
        {
            try { await Call(spec with { Passive = passiveAgain, Dc = 5 }, runId); throw new Exception("Replaced settled passive task"); }
            catch (GameException e) { Check.Equal("check_already_requested", e.Code); }
        }
        string activeRun = Id();
        var active = await Call(spec, activeRun); Check.Equal("roll", active.Wait!.Kind); Check.Equal(0, dice.Count);
        var cancelled = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), active.Version, active.Wait.Id, "cancel"));
        Check.Equal("cancelled", cancelled.Resolution.Status); Check.Equal(0, dice.Count);
        try { await Call(spec with { Passive = true, Dc = 5 }, activeRun); throw new Exception("Converted cancelled task to passive success"); }
        catch (GameException e) { Check.Equal("check_already_requested", e.Code); }
        await store.Access(id, owner.AccessToken, true, c =>
        {
            PartyEngine.SetCharacter(c, c.ActingActorId, c.ActingCharacter with { Exhaustion = 6, Conditions = [] });
            return Task.FromResult(true);
        }, default);
        try { await Call(spec); throw new Exception("Exhausted actor rolled"); }
        catch (GameException e) { Check.Equal("check_context_unavailable", e.Code); }
        Check.Equal(0, dice.Count);
    }

    public static async Task GroundedThresholdAndParagraphBoundaries()
    {
        const string basis = "洞口的机关需DC 12 Wisdom (Perception)才能察觉。";
        var document = TestContent.Document with { Scenes = TestContent.Document.Scenes.Select(s => s.Id == "harbor"
            ? s with { Summary = basis } : s).ToArray() };
        var dice = new SequenceDice(17);
        var model = new Model((_, _) => throw new Exception("No model expected"));
        var h = await Host.Start(dice: dice, configure: Configure(model));
        try
        {
            var owner = await Create(h, document); string id = owner.Snapshot.Id;
            var game = h.App.Services.GetRequiredService<GameService>();
            async Task<HarnessToolOutcome> ToolCall(string name, object args, int contract = 34)
            {
                var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
                return await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "观察洞口", auth.Version,
                    Id(), "explicit-grounding", new(name, HarnessJson.Element(args), "grounding"), [], default, auth.Profile, contract, contextAlreadyRead: true);
            }
            int before = (await h.Get(id))!.Version;
            foreach (var bad in new[]
            {
                new NarrativeHarnessArgs("", [], Paragraphs: []),
                new NarrativeHarnessArgs("", [], Paragraphs: [""]),
                new NarrativeHarnessArgs("", [], Paragraphs: [" "]),
                new NarrativeHarnessArgs("", [], Paragraphs: [null!]),
                new NarrativeHarnessArgs("both", [], Paragraphs: ["paragraph"]),
                new NarrativeHarnessArgs("", [], Paragraphs: [new string('a', 4096), "b"])
            })
            {
                try { await ToolCall("world_record", bad); throw new Exception("Accepted invalid paragraph representation"); }
                catch (GameException e) { Check.True(e.Code is "harness_invalid_payload" or "invalid_world_memory"); }
                Check.Equal(before, (await h.Get(id))!.Version); Check.Equal(0, dice.Count);
            }
            try { await ToolCall("world_record", new NarrativeHarnessArgs("", [], Paragraphs: ["new field"]), 33); throw new Exception("Changed v33 narrative contract"); }
            catch (GameException e) { Check.Equal("harness_invalid_payload", e.Code); }
            var spec = new HarnessCheckArgs("wisdom", "Perception", "normal", "harbor", basis, Dc: 16);
            try { await ToolCall("check_request", spec); throw new Exception("Quoted DC12 accepted as DC16"); }
            catch (GameException e) { Check.Equal("check_source_unavailable", e.Code); }
            Check.Equal(before, (await h.Get(id))!.Version);
            var check = await ToolCall("check_request", spec with { Dc = 12 });
            Check.Equal("roll", check.Wait!.Kind); Check.Equal(0, dice.Count);
            var roll = new RollResponseRequest(Id(), check.Version, check.Wait.Id, "roll");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: Configure(model));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var resolved = await Post<ActionResponse>(h, id, "rolls/respond", roll);
            Check.Equal(1, dice.Count); Check.True(resolved.Resolution.Check!.HasDc); Check.Equal(12, resolved.Resolution.Check.Dc);
            Check.True(resolved.Resolution.Check.Success);
            var replay = await Post<ActionResponse>(h, id, "rolls/respond", roll); Check.True(replay.Replayed); Check.Equal(1, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task NaturalApproachPlacesWithoutSecondConfirmation()
    {
        string mapId = "";
        var model = new Model((call, _) => call switch
        {
            1 or 2 => Tool("token_spawn", new { mapId, spawns = new[] { new { existingId = call == 1 ? Id() : "", kind = "creature", source = new { kind = "player", id = "player" }, actorId = "player", appearance = new { name = "本人" }, x = .36, y = .52 } } }),
            3 => Tool("world_record", new NarrativeHarnessArgs("已靠近目标，继续观察。", [])),
            _ => throw new Exception("Unexpected extra action")
        });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        string id = owner.Snapshot.Id; mapId = SharedBoardTests.Install(h, id).Id;
        var run = await Start(h, owner.Snapshot, "我上前仔细观察目标。"); run = await Settled(h, id, run.Id);
        Check.Equal("completed", run.Status); Check.Equal(3, model.Calls); Check.True((await h.Get(id))!.PendingIntent is null);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
        var rejected = saved.Steps.First(s => s.Kind == "tool").Outcome!;
        Check.True(rejected.Reply.IsError); Check.Equal(owner.Snapshot.Version, rejected.Version);
        Check.True(rejected.Reply.Content.Contains("Nothing was saved"));
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
        Check.Equal(.36, board.Tokens.Single().X); Check.Equal(.52, board.Tokens.Single().Y);
        Check.Equal(0, board.RecentOperations.Length);
    }

    public static async Task RulingQuestionNeverPublicIncludingLegacy()
    {
        const string secret = "SECRET_FOUR_HIDDEN_GOBLINS";
        var model = new Model((_, _) => Tool("ruling_request", new { question = secret }));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h); var actor = await HarnessBoundaryTests.Guest(h, owner);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var other = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", actor.AccessToken);
            var run = await Start(h, (await h.Get(id))!, "我观察道路两侧。"); run = await Settled(h, id, run.Id); Check.Equal("waiting", run.Status);
            var store = h.App.Services.GetRequiredService<CampaignStore>(); int sequence = 0;
            await store.Access(id, owner.AccessToken, false, c =>
            {
                var intent = c.PendingIntents.Single(i => i.Id == run.IntentId); sequence = intent.RootSequence;
                Check.Equal(ActionUnderstanding.RulingRequestSummary, intent.Result!.Summary);
                Check.Equal(secret, c.PendingRulings.Single(r => r.Id == run.Wait!.Id).Reason);
                Check.True(c.Events.All(e => !e.Text.Contains(secret) && !(e.Resolution?.Summary.Contains(secret) ?? false)));
                return Task.FromResult(true);
            }, default);
            async Task Verify()
            {
                string db = Path.Combine(h.Root, "campaigns", id + ".sqlite"); var before = File.ReadAllBytes(db);
                foreach (var viewer in new[] { actor, other, owner })
                {
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", viewer.AccessToken);
                    foreach (string suffix in new[] { "", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100", "/activity/" + sequence })
                    {
                        string body = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}" + suffix);
                        if (viewer != owner) Check.True(!body.Contains(secret), "Secret escaped via " + suffix);
                    }
                }
                Check.True(before.SequenceEqual(File.ReadAllBytes(db)), "Projection rewrote historical storage");
            }
            await Verify();
            var replayRequests = new (string Route, string Prefix, string Id, object Body)[]
            {
                MakeReplay("actions/input", "actions.input:"), MakeReplay("actions/interpret", "actions.interpret:"),
                MakeReplay("actions/propose", "actions.propose:")
            }.ToList();
            var respond = new IntentResponseRequest(Id(), run.Version, run.IntentId, "ruling");
            replayRequests.Add(("intents/respond", "intents.respond:", respond.RequestId, respond));
            (string, string, string, object) MakeReplay(string route, string prefix)
            {
                var request = new ActionRequest(Id(), run.Version, "natural", Text: "我观察道路两侧。");
                return (route, prefix, request.RequestId, request);
            }
            // Simulate a pre-fix persisted public event, result and step. Reading must redact,
            // never migrate/delete the host's original evidence.
            await store.Access(id, owner.AccessToken, true, c =>
            {
                var intent = c.PendingIntents.Single(i => i.Id == run.IntentId);
                intent.Result = intent.Result! with { Summary = secret };
                foreach (var old in replayRequests)
                    c.Receipts.Add(new(old.Id, JsonFiles.Hash(old.Prefix + System.Text.Json.JsonSerializer.Serialize(old.Body, JsonFiles.Options)), intent.Result, intent.ActorId));
                intent.HarnessSteps = intent.HarnessSteps!.Select(s => s with { Result = s.Result with { Summary = secret } }).ToList();
                for (int i = 0; i < c.Events.Count; i++) if (c.Events[i].Resolution?.IntentId == run.IntentId)
                    c.Events[i] = c.Events[i] with { Text = secret, Resolution = c.Events[i].Resolution! with { Summary = secret } };
                return Task.FromResult(true);
            }, default);
            await Verify();
            async Task VerifyReplays()
            {
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", actor.AccessToken);
                foreach (var old in replayRequests)
                {
                    var replayed = await Post<ActionResponse>(h, id, old.Route, old.Body);
                    Check.True(replayed.Replayed); Check.Equal(run.Version, replayed.Snapshot.Version);
                    Check.Equal(ActionUnderstanding.RulingRequestSummary, replayed.Resolution.Summary);
                }
                var receipts = h.App.Services.GetRequiredService<CampaignStore>();
                await receipts.Access(id, actor.AccessToken, false, c =>
                {
                    foreach (var old in replayRequests)
                        Check.Equal(secret, receipts.FindReceipt(c, old.Id)!.Resolution.Summary);
                    return Task.FromResult(true);
                }, default);
            }
            await VerifyReplays();
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model)); await Verify(); await VerifyReplays();
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/activity/{sequence}")).Contains(secret));
        }
        finally { await h.DisposeAsync(); }
    }
}
