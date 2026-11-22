using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.HarnessExecutionProtocolTests;

namespace DiceRealm.Tests;

internal static class NarrativeCheckTests
{
    internal const string SceneBasis = "石阶被雨水浸湿，推门时门框上的碎石会松动落下。";
    private const string PrivateReason = "PRIVATE_AI_REASON：湿滑石阶仍可通行，但跨越缺口可能失足，按中等难度判断。";
    internal static AdventureDocument Document => TestContent.Document with
    {
        Scenes = TestContent.Document.Scenes.Select(s => s.Id == "harbor" ? s with { Summary = SceneBasis } : s).ToArray()
    };
    internal static object Proposed(string type = "ability", string ability = "strength", string skill = "Athletics", int dc = 15,
        string reason = PrivateReason, string quote = SceneBasis, string source = "harbor") =>
        new { ability, skill, mode = "normal", sourceId = source, quote, dc, checkType = type, reason };

    // A real Pi/MCP conversation starts with an ordinary action, observes a no-check
    // local result, and still requests the necessary situational check before its outcome.
    public static async Task AiDeterminesDifficultyAfterLocalActionAndResumesOnce()
    {
        var model = new Model((call, request) =>
        {
            var frame = Frame(request);
            Check.True(frame.GetProperty("dmChecklist").GetProperty("instructions").GetString()!.Contains("AI"));
            return call switch
            {
                1 => Tool("actions_propose", new { candidateId = Choice(request, "观察") }, "observe"),
                2 => Tool("check_request", new HarnessCheckV44Args("strength", "Athletics", "normal", "harbor", SceneBasis, Reason: PrivateReason), "missing-dc"),
                3 => Tool("check_request", Proposed(), "check"),
                4 => Tool("world_record", new NarrativeHarnessArgs("角色站稳脚步，越过湿滑石阶。", []), "outcome"),
                _ => throw new Exception("Unexpected new provider call after saved result")
            };
        });
        var dice = new SequenceDice(18);
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h, Document); string id = owner.Snapshot.Id;
            var run = await Start(h, owner.Snapshot, "我看看台阶，继续朝门口走。");
            run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            Check.Equal("roll", run.Wait!.Kind); Check.Equal(3, model.Calls); Check.Equal(0, dice.Count);
            var snapshot = (await h.Get(id))!;
            Check.Equal(0, snapshot.PendingRulings.Length);
            var preview = snapshot.PendingRoll!.Preview!;
            Check.Equal("ability", preview.TestKind); Check.Equal(15, preview.Dc); Check.True(preview.HasDc);
            Check.True(!snapshot.PendingRoll.Description.Contains("PRIVATE_AI_REASON"));
            Check.Equal("", run.Text);
            var premature = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume",
                new HarnessResumeRequest(Id(), snapshot.Version));
            Check.Equal(HttpStatusCode.Conflict, premature.StatusCode); Check.Equal(0, dice.Count);
            var stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(HarnessTools.CurrentVersion, stored.ToolContractVersion);
            var rollRequest = new RollResponseRequest(Id(), snapshot.Version, run.Wait.Id, "roll");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var rolled = await Post<ActionResponse>(h, id, "rolls/respond", rollRequest);
            Check.Equal(1, dice.Count); Check.Equal(preview.Modifier, rolled.Resolution.Check!.Modifier);
            Check.Equal(15, rolled.Resolution.Check.Dc); Check.True(rolled.Resolution.Check.Success);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", rollRequest)).Replayed);
            Check.Equal(1, dice.Count);
            var resume = new HarnessResumeRequest(Id(), rolled.Snapshot.Version);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            Check.Equal(4, model.Calls); Check.Equal(1, dice.Count);
            Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            var entry = activity.Entries.Single(e => e.ActionId == run.IntentId);
            Check.True(entry.Steps!.Any(s => s.Result.Kind == "observe" && s.Result.Check is null));
            Check.Equal(1, entry.Steps!.Count(s => s.Result.Kind == "check.resolve"));
            Check.True(!JsonSerializer.Serialize(snapshot).Contains("PRIVATE_AI_REASON"));
        }
        finally { await h.DisposeAsync(); }
    }

    // An answer narrated before a check is its own beat. It shows while the roll waits and stays
    // before the check and its outcome afterwards; the later narration never replaces it.
    public static async Task NarrationBeforeCheckStaysAsItsOwnBeat()
    {
        const string answer = "门卫答道：他昨天一个人出的门，背着信袋。", outcome = "泥地被雨冲过，只剩你自己的脚印。";
        var model = new Model((call, request) => call switch
        {
            1 => Tool("actions_propose", new { candidateId = Choice(request, "观察") }, "observe"),
            2 => Tool("world_record", new NarrativeHarnessArgs(answer, [], Complete: false), "answer"),
            3 => Tool("check_request", Proposed(), "check"),
            4 => Tool("world_record", new NarrativeHarnessArgs(outcome, []), "outcome"),
            _ => throw new Exception("Unexpected provider call")
        });
        var dice = new SequenceDice(18);
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await Create(h, Document); string id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot, "我问他信使带了什么，再去门口看看泥地上的脚印。");
        run = await Settled(h, id, run.Id, 3000);
        Check.True(run.Status == "waiting", run.Status + "/" + run.Error); Check.Equal("roll", run.Wait!.Kind);
        async Task<ActivityEntry[]> Beats() => (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!
            .Entries.Where(e => e.ActionId == run.IntentId).OrderBy(e => e.Sequence).ToArray();
        var waiting = await Beats();
        Check.Equal(2, waiting.Length);
        Check.Equal(answer, waiting[0].Narrative); Check.Equal(0, waiting[0].ContinuationOf); Check.Equal("completed", waiting[0].Status);
        Check.Equal("awaiting_roll", waiting[1].Status); Check.Equal(waiting[0].Sequence, waiting[1].ContinuationOf); Check.Equal("", waiting[1].Narrative);
        var snapshot = (await h.Get(id))!;
        var rolled = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, run.Wait.Id, "roll"));
        await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), rolled.Snapshot.Version));
        run = await Settled(h, id, run.Id, 3000);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error);
        var done = await Beats();
        Check.Equal(2, done.Length);
        Check.Equal(answer, done[0].Narrative);
        Check.True(done[0].Steps!.All(s => s.Result.Check is null), "the check belongs to the second beat");
        Check.Equal(outcome, done[1].Narrative); Check.Equal("completed", done[1].Status);
        Check.Equal(1, done[1].Steps!.Count(s => s.Result.Kind == "check.resolve"));
    }

    public static async Task PlotSaveUsesSavingThrowAndKeepsResultOnNarrativeFailure()
    {
        var model = new Model((call, _) => call == 1
            ? Tool("check_request", Proposed("save", "strength", "", 12, "门框碎石松脱，角色必须稳住姿势；本场采用DC12力量豁免。"))
            : throw new IOException("isolated narration failure after roll"));
        var dice = new SequenceDice(13);
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await Create(h, Document); string id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot, "我推开面前的门。");
        run = await Settled(h, id, run.Id); Check.Equal("waiting", run.Status);
        var snapshot = (await h.Get(id))!;
        var preview = snapshot.PendingRoll!.Preview!;
        Check.Equal("save", preview.TestKind); Check.Equal("", preview.Skill); Check.Equal("strength", preview.Ability);
        int expected = RulesEngine.TestModifier(snapshot.Character.Required(), "strength", "", true);
        Check.Equal(expected, preview.Modifier); Check.Equal(0, dice.Count); Check.Equal(0, snapshot.PendingRulings.Length);
        var roll = new RollResponseRequest(Id(), snapshot.Version, run.Wait!.Id, "roll");
        var result = await Post<ActionResponse>(h, id, "rolls/respond", roll);
        Check.Equal(expected, result.Resolution.Check!.Modifier); Check.Equal(1, dice.Count);
        var resume = new HarnessResumeRequest(Id(), result.Snapshot.Version);
        await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
        run = await Settled(h, id, run.Id);
        Check.Equal("unknown", run.Status); // A possibly sent model result cannot be silently resent.
        Check.Equal(2, model.Calls); Check.Equal(1, dice.Count);
        Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed);
        Check.Equal(1, dice.Count); Check.Equal(2, model.Calls);
        var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
        Check.True(activity.Entries.Single(e => e.ActionId == run.IntentId).Steps!.Any(s => s.Result.RollId == roll.RollId && s.Result.Check is not null));
    }

    public static async Task AiDifficultyBoundariesOldContractsAndAutomaticFailure()
    {
        var dice = new SequenceDice(17);
        await using var h = await Host.Start(dice: dice, configure: Configure(new Model((_, _) => throw new Exception("No model"))));
        var owner = await Create(h, Document); string id = owner.Snapshot.Id;
        var game = h.App.Services.GetRequiredService<GameService>();
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        async Task<HarnessToolOutcome> Call(object args, int contract = 44, string? intent = null)
        {
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            return await game.HarnessTool(id, owner.AccessToken, auth.ActorId, intent ?? Id(), "我沿台阶走向门口", auth.Version,
                Id(), "narrative-check-boundary", new("check_request", HarnessJson.Element(args), "boundary"), [], default,
                auth.Profile, contract, contextAlreadyRead: true);
        }
        int version = (await h.Get(id))!.Version;
        foreach (int contract in new[] { 43, 44 })
        {
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            const string input = "我沿台阶走向门口";
            var frame = await game.ReadHarnessExecution(id, owner.AccessToken, auth.ActorId, Id(), input, auth.Version, default, contract);
            var projected = HarnessExecutionProtocol.Project(new(Preset.SystemPrompt,
                [new("user", HarnessJson.Serialize(new { input, ruleset = "dnd2024", memory = new { } }))], HarnessTools.ForVersion(contract), 4096), frame, contract);
            string coverage = Frame(projected).GetProperty("self").GetProperty("coverage").GetString()!;
            Check.Equal(contract == 43, coverage.EndsWith("Only offered actions execute mechanics."));
            Check.Equal(contract == 44, coverage.Contains("check_request"));
            string correction = HarnessExecutionProtocol.ArgumentsRejected(version, "encounter_prepare", "encounter_source_unavailable", "bad citation", contract).Reply.Content;
            Check.Equal(contract == 44, correction.Contains("continuous verbatim"));
        }
        foreach (object invalid in new[] { Proposed(reason: ""), Proposed(source: "elsewhere"), Proposed(quote: "不存在于场景的危险"),
            Proposed(dc: 31), Proposed("save", "strength", "Athletics") })
        {
            try { await Call(invalid); throw new Exception("Invalid AI check was accepted"); }
            catch (GameException e) { Check.True(e.Code is "invalid_ruling_check" or "check_source_unavailable" or "harness_invalid_payload"); }
            Check.Equal(version, (await h.Get(id))!.Version); Check.Equal(0, dice.Count);
        }
        try { await Call(Proposed(), 43); throw new Exception("New fields changed frozen v43"); }
        catch (GameException e) { Check.Equal("harness_invalid_payload", e.Code); }
        try { await Call(new HarnessCheckArgs("strength", "Athletics", "normal", "harbor", SceneBasis, Dc: 15), 43); throw new Exception("Old v43 accepted AI DC"); }
        catch (GameException e) { Check.Equal("check_source_unavailable", e.Code); }
        foreach (string type in new[] { "ability", "save" })
        {
            try { await Call(new HarnessCheckV44Args("wisdom", type == "save" ? "" : "Perception", "normal", "harbor", SceneBasis, CheckType: type, Reason: PrivateReason), 50); throw new Exception("Active check accepted without DC"); }
            catch (GameException e) { Check.Equal("invalid_ruling_check", e.Code); }
            Check.Equal(version, (await h.Get(id))!.Version); Check.Equal(0, dice.Count);
        }
        string intent = Id();
        var waiting = await Call(Proposed(), intent: intent);
        Check.Equal("roll", waiting.Wait!.Kind); Check.Equal(0, dice.Count);
        var cancelled = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), waiting.Version, waiting.Wait.Id, "cancel"));
        Check.Equal("cancelled", cancelled.Resolution.Status); Check.Equal(0, dice.Count);
        try { await Call(Proposed(dc: 10, reason: "换了更容易的理由"), intent: intent); throw new Exception("Cancelled task rerolled with new DC/reason"); }
        catch (GameException e) { Check.Equal("check_already_requested", e.Code); }
        // The cancelled action retains its own continuation. Test incapacitated saves
        // in an independent scene, not through that unfinished intent's context gate.
        owner = await Create(h, Document); id = owner.Snapshot.Id;
        await store.Access(id, owner.AccessToken, true, c =>
        {
            c.ActingCharacter = c.ActingCharacter with { Conditions = ["Unconscious"] };
            return Task.FromResult(true);
        }, default);
        try { await Call(Proposed()); throw new Exception("Unconscious actor attempted active Athletics"); }
        catch (GameException e) { Check.Equal("check_context_unavailable", e.Code); }
        var automatic = await Call(Proposed("save", "strength", "", 5, "落石要求力量豁免；按规则昏迷自动失败。"));
        using var payload = JsonDocument.Parse(automatic.Reply.Content);
        Check.True(automatic.Wait is null); Check.Equal(0, dice.Count);
        var check = payload.RootElement.GetProperty("resolution").GetProperty("check");
        Check.Equal("automatic-failure", check.GetProperty("mode").GetString());
        Check.True(!check.GetProperty("success").GetBoolean());
        Check.Equal(0, (await h.Get(id))!.PendingRulings.Length);
        var mental = await Call(Proposed("save", "wisdom", "", 10, "环境触发感知豁免，昏迷不会使此属性自动失败。"));
        Check.Equal("roll", mental.Wait!.Kind); Check.Equal(0, dice.Count);
        var mentalResult = await Post<ActionResponse>(h, id, "rolls/respond",
            new RollResponseRequest(Id(), mental.Version, mental.Wait.Id, "roll"));
        Check.Equal(1, dice.Count); Check.Equal("wisdom", mentalResult.Resolution.Check!.Ability);
        Check.True(mentalResult.Resolution.Check.Mode != "automatic-failure");
    }

    public static async Task AuthoredDifficultyAndObviousInformationStayAuthoritative()
    {
        const string basis = "湿滑台阶要求DC 12 Strength (Athletics)。";
        var document = Document with { Scenes = Document.Scenes.Select(s => s.Id == "harbor" ? s with { Summary = basis } : s).ToArray() };
        var model = new Model((call, request) => call switch
        {
            1 => Tool("actions_propose", new { candidateId = Choice(request, "观察") }),
            2 => Tool("world_record", new NarrativeHarnessArgs("门前的石阶湿滑，通道仍然可见。", [])),
            _ => throw new Exception("Obvious information should finish without a roll")
        });
        var dice = new SequenceDice(16);
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await Create(h, document); string id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot, "看看眼前是什么地方。");
        run = await Settled(h, id, run.Id); Check.Equal("completed", run.Status); Check.Equal(0, dice.Count);
        var snapshot = (await h.Get(id))!; Check.True(snapshot.PendingRoll is null); Check.Equal(0, snapshot.PendingRulings.Length);
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        try
        {
            await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "走上台阶", auth.Version, Id(), "keep-authored-dc",
                new("check_request", HarnessJson.Element(Proposed(dc: 20, quote: basis)), "no-override"), [], default,
                auth.Profile, 44, contextAlreadyRead: true);
            throw new Exception("AI replaced authored DC12 with DC20");
        }
        catch (GameException e) { Check.Equal("check_source_unavailable", e.Code); }
        Check.Equal(snapshot.Version, (await h.Get(id))!.Version); Check.Equal(0, dice.Count);
    }
}
