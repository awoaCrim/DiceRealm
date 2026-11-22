using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CombatNarrationHttpTests
{
    public static async Task RealPiSequentialBeatsReceiptsAndHistory()
    {
        await Scenario(false);
        await Scenario(true);
        await Scenario(false, legacy: true);
    }

    private sealed class PauseContinuation(PiHarnessRuntime inner, Func<bool> paused) : IHarnessRuntime, IDisposable
    {
        public Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct)
        {
            if (paused() && execution.Turns.Any(t => t.Contains("\"combatContinuation\"", StringComparison.Ordinal)))
                throw new IOException("Isolated fault after the saved narrative receipt.");
            return inner.Execute(execution, callback, ct);
        }
        public void Dispose() => inner.Dispose();
    }

    public static async Task FinalReceiptRestartAndColdHistory() => await Scenario(true, restartFinal: true);

    public static async Task StandaloneActionKeepsFreshInput()
    {
        await Scenario(false, standalone: true);
        await Scenario(true, standalone: true);
    }

    public static async Task LegacyWaitingInputKeepsContract()
    {
        var document = StandardCombatTests.Document();
        document = document with { Scenes = document.Scenes.Select(s => s.Id == "causeway" ? s with { SafeRest = true } : s).ToArray() };
        string start = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        var model = new Model((call, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var agent = frame.GetProperty("agent");
            if (call == 1) return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "接战。", []));
            if (call == 2)
            {
                string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("label").GetString() == start).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate });
            }
            Check.Equal(call >= 5, agent.TryGetProperty("narration", out _));
            return Tool("world_record", new NarrativeHarnessArgs("保存当前回应" + call, []));
        });
        var dice = new SequenceDice(20, 19, 1);
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("旧等待兼容", "Arden", document,
            Preset with { CombatSystemPrompt = "战斗提示" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        var guest = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var parent = await StartHistorical(h, id, new(Id(), (await h.Get(id))!.Version, "应对进攻"), 48);
        parent = await Settled(h, id, parent.Id); Check.Equal("delegated", parent.Status);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        var runs = h.App.Services.GetRequiredService<HarnessRunStore>();
        var session = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
        var child = await Settled(h, id, session.Inputs[0].RunId); Check.Equal("waiting", child.Status);
        foreach (string token in new[] { guest.AccessToken, owner.AccessToken })
        {
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var snapshot = (await h.Get(id))!;
            await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll"));
        }
        Check.Equal(3, dice.Count);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var peer = await Start(h, (await h.Get(id))!, "提醒同伴"); peer = await Settled(h, id, peer.Id); Check.Equal("completed", peer.Status);
        Check.Equal(48, runs.Read(id, guest.Snapshot.Party!.SelfActorId, peer.Id)!.ToolContractVersion);
        Check.True(await store.Access(id, owner.AccessToken, false, c => Task.FromResult(c.StandardCombatFlow!.NarratedThrough is null)));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), (await h.Get(id))!.Version));
        child = await Settled(h, id, child.Id); Check.Equal("completed", child.Status);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        peer = await Start(h, (await h.Get(id))!, "继续观察"); peer = await Settled(h, id, peer.Id); Check.Equal("completed", peer.Status);
        Check.Equal(HarnessTools.CurrentVersion, runs.Read(id, guest.Snapshot.Party!.SelfActorId, peer.Id)!.ToolContractVersion);
        Check.True(await store.Access(id, owner.AccessToken, false, c => Task.FromResult(c.StandardCombatFlow!.NarratedThrough == c.Combat!.LogSequence)));
        Check.Equal(5, model.Calls); Check.Equal(3, dice.Count);
    }

    public static async Task TerminalBeatBeforeReturn()
    {
        var document = StandardCombatTests.Document(damageBonus: 20);
        string start = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        int stories = 0;
        var model = new Model((_, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request); var agent = frame.GetProperty("agent");
            if (agent.GetProperty("role").GetString() == "exploration")
                return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "进攻已经发生。", []));
            if (agent.TryGetProperty("narration", out var narration))
            {
                if (narration.GetProperty("pending").GetBoolean()) return Tool("world_record", new NarrativeHarnessArgs("结局剧情" + ++stories, []));
                if (narration.GetProperty("canContinue").GetBoolean()) return Tool("combat_continue");
            }
            string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                .Single(c => c.GetProperty("label").GetString() == start).GetProperty("id").GetString()!;
            return Tool("actions_propose", new { candidateId = candidate });
        });
        var dice = new SequenceDice(1, 20, 20, 4, 4);
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); }));
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("终局叙述隔离", "Arden", document,
            Preset with { CombatSystemPrompt = "战斗终局提示" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; string id = owner.Snapshot.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var parent = await Start(h, owner.Snapshot); parent = await Settled(h, id, parent.Id, 3000);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        var session = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
        var child = await Settled(h, id, session.Inputs[0].RunId, 3000); Check.Equal("waiting", child.Status);
        var snapshot = (await h.Get(id))!;
        var confirmed = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll"));
        Check.Equal(5, dice.Count);
        await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), confirmed.Snapshot.Version));
        child = await Settled(h, id, child.Id, 3000); Check.True(child.Status == "completed", child.Status + ":" + child.Error);
        Check.Equal(2, stories);
        var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
        Check.True(page.Entries.Any(e => e.Narrative == "结局剧情1") && page.Entries.Any(e => e.Narrative == "结局剧情2"));
        for (int i = 0; i < 100; i++)
        {
            session = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(c.CombatAgentSessions!.Single()));
            if (session.ReturnConsumed) break;
            await Task.Delay(25);
        }
        Check.True(session.ReturnConsumed && session.Return!.Status == "defeated");
        Check.True(session.Return!.Story!.Any(s => s.Text == "结局剧情2"));
        int calls = model.Calls; snapshot = (await h.Get(id))!;
        var denied = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs", new HarnessInputRequest(Id(), snapshot.Version, "再次攻击"));
        Check.Equal(System.Net.HttpStatusCode.Conflict, denied.StatusCode); Check.Equal(calls, model.Calls); Check.Equal(5, dice.Count);
    }

    public static async Task MovementNarrationRefreshesOriginalInput()
    {
        foreach (var (plainText, singleMove, legacy) in new[] { (false, false, false), (true, false, false), (false, true, false), (false, false, true) })
        {
            var document = StandardCombatTests.Document();
            document = document with { Scenes = document.Scenes.Select(s => s.Id != "causeway" ? s : s with
            { Encounter = s.Encounter! with { Enemies = s.Encounter.Enemies.Select(e => e with { X = 5 }).ToArray() } }).ToArray() };
            string start = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
            string input = singleMove ? "只往前走一格，然后停住。" : "靠近对面的敌人，进入巨剑范围后挥剑攻击，不结束回合。";
            bool moving = false;
            int stories = 0;
            var model = new Model((_, request) =>
            {
                var frame = HarnessExecutionProtocolTests.Frame(request); var agent = frame.GetProperty("agent");
                if (agent.GetProperty("role").GetString() == "exploration")
                    return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "迎战。", []));
                if (agent.TryGetProperty("narration", out var narration) && narration.GetProperty("pending").GetBoolean())
                {
                    string text = "本段实际动作已交付。" + ++stories;
                    if (legacy && !moving)
                    { moving = true; return Tool("world_record", new NarrativeHarnessArgs(text, [], Complete: false)); }
                    return plainText ? Text(text) : Tool("world_record", new NarrativeHarnessArgs(text, [], Complete: true));
                }
                var candidates = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray().ToArray();
                string label = start;
                if (moving)
                {
                    if (!legacy) Check.True(request.Tools.Single(t => t.Name == "world_record").Description.Contains("inputContinues=true"));
                    Check.True(request.Messages.Any(m => m.Content.Contains(input, StringComparison.Ordinal)), "The original compound input stays in the same Run");
                    var self = frame.GetProperty("combat").GetProperty("units").EnumerateArray().Single(u => u.GetProperty("id").GetString() == "player");
                    int x = self.GetProperty("x").GetInt32();
                    if (singleMove && x == 2) return Tool("world_record", new NarrativeHarnessArgs("已按要求停住。", []));
                    label = x < 4 ? $"移动至 {x + 1},2" : "Greatsword";
                }
                string candidate = candidates.Single(c => c.GetProperty("label").GetString()!.Contains(label, StringComparison.Ordinal)).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate });
            });
            var dice = new SequenceDice(20, 1, 15, 3, 4, 3, 4);
            var configure = Configure(model, extra: b =>
            { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
            var h = await Host.Start(dice: dice, configure: configure);
            try
            {
                var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("移动续接隔离", "Arden", document,
                    Preset with { CombatSystemPrompt = "独立战斗提示" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
                Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
                var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; string id = owner.Snapshot.Id;
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                var parent = legacy ? await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, input), 52) : await Start(h, owner.Snapshot);
                await Settled(h, id, parent.Id, 3000);
                var session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                    c => Task.FromResult(CombatAgentSessions.Current(c)!));
                var run = await Settled(h, id, session.Inputs[0].RunId, 3000);
                var s = (await h.Get(id))!;
                var initiative = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"));
                await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), initiative.Snapshot.Version));
                run = await Settled(h, id, run.Id, 3000);
                if (!legacy)
                {
                    Check.Equal("completed", run.Status); moving = true; s = (await h.Get(id))!;
                    run = await Settled(h, id, (await Start(h, s, input)).Id, 3000);
                }
                for (int x = 2; x <= (singleMove || legacy ? 2 : 4); x++)
                {
                    Check.True(run.Status == "waiting", $"Movement {x} lost the remaining input: {run.Status}/{run.Error}");
                    s = (await h.Get(id))!;
                    Check.True(s.PendingIntent is not null && s.PendingRoll is null);
                    var choose = new IntentResponseRequest(Id(), s.Version, s.PendingIntent!.Id, "choose", s.PendingIntent.Options.Single().Id);
                    var moved = await Post<ActionResponse>(h, id, "intents/respond", choose);
                    Check.Equal(x, moved.Snapshot.Combat!.Units.Single(u => u.Id == "player").X); Check.Equal(2, dice.Count);
                    await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), moved.Snapshot.Version));
                    run = await Settled(h, id, run.Id, 3000);
                }
                s = (await h.Get(id))!;
                if (singleMove || legacy)
                {
                    Check.Equal("completed", run.Status); Check.True(s.PendingRoll is null && s.PendingIntent is null);
                    Check.Equal(2, s.Combat!.Units.Single(u => u.Id == "player").X); Check.Equal(2, dice.Count);
                }
                else
                {
                    Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
                    Check.True(s.PendingRoll is { Available: true } && s.PendingIntent is null, "The attack must still wait for its owner's dice consent");
                    Check.Equal(2, dice.Count);
                    int calls = model.Calls; string root = h.Root, snapshot = HarnessJson.Serialize(s);
                    await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                    Check.Equal(snapshot, HarnessJson.Serialize((await h.Get(id))!)); Check.Equal(calls, model.Calls); Check.Equal(2, dice.Count);
                    var roll = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
                    var attack = await Post<ActionResponse>(h, id, "rolls/respond", roll);
                    await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), attack.Snapshot.Version));
                    run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status);
                    s = (await h.Get(id))!; Check.Equal(7, dice.Count);
                    Check.Equal(3, s.Combat!.Log.Count(e => e.Kind == "combat.move" && e.ActorId == "player"));
                    Check.Equal(1, s.Combat.Log.Count(e => e.Kind == "attack" && e.ActorId == "player"));
                    Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed); Check.Equal(7, dice.Count);
                }
                Check.Equal("player", s.Combat!.ActiveActorId); Check.Equal(1, s.Combat.Round);
                Check.True(!s.Combat.Log.Any(e => e.Kind == "combat.end_turn"));
            }
            finally { await h.DisposeAsync(); }
        }
    }

    public static async Task AutomaticDeathSaveContinuesNarratedBattle()
    {
        foreach (bool direct in new[] { false, true })
        {
            var document = StandardCombatTests.Document(damageBonus: 8);
            document = document with { Scenes = document.Scenes.Select(s => s.Id != "causeway" ? s : s with
            { Encounter = s.Encounter! with { Enemies = Enumerable.Range(0, 3).Select(i =>
                new ContentEnemy("foe" + i, "敌人" + i, 2, 1 + i, 50, 12, 20, AttackBonus: 3, DamageBonus: 8, Tactic: "engage")).ToArray() } }).ToArray() };
            string start = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
            bool ending = false, endChosen = false;
            int beats = 0;
            var model = new Model((_, request) =>
            {
                var frame = HarnessExecutionProtocolTests.Frame(request); var agent = frame.GetProperty("agent");
                if (agent.GetProperty("role").GetString() == "exploration")
                    return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "迎战。", []));
                if (agent.TryGetProperty("narration", out var narration))
                {
                    if (narration.GetProperty("pending").GetBoolean()) return Tool("world_record", new NarrativeHarnessArgs("死亡豁免流程剧情" + ++beats, []));
                    if (narration.GetProperty("canContinue").GetBoolean()) return Tool("combat_continue");
                }
                string label = ending ? "结束回合" : start;
                Check.True(!ending || !endChosen, "No second end-turn or manual death-save choice");
                if (ending) endChosen = true;
                string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("label").GetString()!.Contains(label, StringComparison.Ordinal)).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate });
            });
            var dice = new SequenceDice(20, 1, 1, 1, 15, 4, 10, 20);
            var configure = Configure(model, extra: b =>
            { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
            var h = await Host.Start(dice: dice, configure: configure);
            try
            {
                var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("自动死亡豁免隔离", "Arden", document,
                    Preset with { CombatSystemPrompt = "独立战斗提示" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
                Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
                var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; string id = owner.Snapshot.Id;
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                async Task<CombatAgentSession> Session() => await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                    c => Task.FromResult(CombatAgentSessions.Current(c)!));
                var parent = await Settled(h, id, (await Start(h, owner.Snapshot)).Id, 3000);
                Check.Equal("delegated", parent.Status);
                var run = await Settled(h, id, (await Session()).Inputs[0].RunId, 3000);
                var s = (await h.Get(id))!;
                var initiative = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"));
                await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), initiative.Snapshot.Version));
                run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(4, dice.Count);
                ending = true; s = (await h.Get(id))!;
                if (direct)
                {
                    var command = new ActionRequest(Id(), s.Version, "combat.end_turn");
                    await Post<ActionResponse>(h, id, "actions/propose", command);
                    run = await Settled(h, id, (await Session()).Inputs.Single(i => i.Command?.RequestId == command.RequestId).RunId, 3000);
                }
                else
                {
                    run = await Settled(h, id, (await Start(h, s, "结束我的回合")).Id, 3000);
                    s = (await h.Get(id))!;
                    var accepted = await Post<ActionResponse>(h, id, "intents/respond", new IntentResponseRequest(Id(), s.Version,
                        s.PendingIntent!.Id, "choose", s.PendingIntent.Options.Single().Id));
                    await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), accepted.Snapshot.Version));
                    run = await Settled(h, id, run.Id, 3000);
                }
                Check.True(run.Status == (direct ? "completed" : "waiting"), run.Status + "/" + run.Error);
                s = (await h.Get(id))!;
                Check.Equal(6, dice.Count); Check.Equal(0, s.Character!.HitPoints); Check.True(s.PendingRoll is { Available: true });
                string first = s.PendingRoll!.Id;
                async Task ContinueAfterRoll(RollResponseRequest roll)
                {
                    var result = await Post<ActionResponse>(h, id, "rolls/respond", roll);
                    if (direct) run = await Settled(h, id, (await Session()).Inputs.Single(i => i.Command?.RequestId == roll.RequestId).RunId, 3000);
                    else
                    {
                        await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), result.Snapshot.Version));
                        run = await Settled(h, id, run.Id, 3000);
                    }
                }
                int callsBeforeSave = model.Calls;
                await ContinueAfterRoll(new(Id(), s.Version, first, "roll"));
                Check.True(run.Status == (direct ? "completed" : "waiting"), run.Status + "/" + run.Error);
                Check.Equal(3, model.Calls - callsBeforeSave);
                s = (await h.Get(id))!;
                Check.Equal(7, dice.Count); Check.Equal(3, s.Combat!.Round);
                Check.Equal(1, s.Combat.Units.Single(u => u.Id == "player").Standard!.DeathSuccesses);
                Check.True(s.PendingRoll is { Available: true } && s.PendingRoll.Id != first, "The next round automatically asks for the next death save");
                Check.Equal(1, s.Combat.Log.Count(e => e.Kind == "combat.end_turn"));
                int calls = model.Calls; string snapshot = HarnessJson.Serialize(s), root = h.Root;
                await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                Check.Equal(snapshot, HarnessJson.Serialize((await h.Get(id))!)); Check.Equal(calls, model.Calls); Check.Equal(7, dice.Count);
                var wake = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
                await ContinueAfterRoll(wake); Check.Equal("completed", run.Status);
                s = (await h.Get(id))!; Check.Equal(8, dice.Count); Check.Equal(1, s.Character!.HitPoints);
                Check.Equal(3, s.Combat!.Round); Check.Equal("player", s.Combat.ActiveActorId);
                Check.True(s.PendingRoll is null && s.Combat.Standard!.Wait is null);
                Check.True(s.Combat.Units.Single(u => u.Id == "player").ActionAvailable);
                calls = model.Calls;
                Check.True((await Post<ActionResponse>(h, id, "rolls/respond", wake)).Replayed);
                Check.Equal(calls, model.Calls); Check.Equal(8, dice.Count);
                Console.WriteLine("Death-save continuation: three idle NPCs, 3 fake-model calls, one confirmed save, all turn logs retained; restart and receipt replay add zero calls/dice.");
            }
            finally { await h.DisposeAsync(); }
        }
    }

    public static async Task DirectCommandContinuesWithoutNewInput()
    {
        await Scenario(false, direct: true);
        await Scenario(true, direct: true, restartFinal: true);
    }

    // Opening, editing and cancelling a Magic Missile plan spends nothing: no story beat, no model
    // call, and the next edit is offered at once. The paid cast narrates the volley it fires.
    public static async Task MissilePlanEditsAreNotNarrated()
    {
        var document = StandardCombatTests.Document();
        string start = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        var narrated = new List<string>();
        var model = new Model((_, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var agent = frame.GetProperty("agent");
            if (agent.GetProperty("role").GetString() == "exploration")
                return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "法师迎战。", []));
            if (agent.TryGetProperty("narration", out var narration))
            {
                if (narration.GetProperty("pending").GetBoolean())
                {
                    narrated.AddRange(narration.GetProperty("records").EnumerateArray().Select(r => r.GetProperty("kind").GetString()!));
                    return Tool("world_record", new NarrativeHarnessArgs("战斗剧情段" + narrated.Count, []));
                }
                if (narration.GetProperty("canContinue").GetBoolean()) return Tool("combat_continue");
            }
            string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                .Single(c => c.GetProperty("label").GetString() == start).GetProperty("id").GetString()!;
            return Tool("actions_propose", new { candidateId = candidate });
        });
        var dice = new SequenceDice(20, 1, 2, 2, 2);
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        var owner = await Create(h, document, CharacterEngine.Wizard); string id = owner.Snapshot.Id;
        var parent = await Settled(h, id, (await Start(h, owner.Snapshot)).Id, 3000);
        Check.Equal("delegated", parent.Status);
        async Task<CombatAgentSession> Session() => await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
            c => Task.FromResult(CombatAgentSessions.Current(c)!));
        var child = await Settled(h, id, (await Session()).Inputs[0].RunId, 3000);
        Check.Equal("waiting", child.Status);
        var s = (await h.Get(id))!;
        s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
        await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), s.Version));
        child = await Settled(h, id, child.Id, 3000); Check.Equal("completed", child.Status);

        int calls = model.Calls, inputs = (await Session()).Inputs.Count;
        s = (await h.Get(id))!; string guardian = s.Combat!.Units.Single(u => u.Team == "enemy").Id;
        async Task<CampaignSnapshot> Button(string kind, string target = "")
        {
            var current = (await h.Get(id))!;
            return (await Post<ActionResponse>(h, id, "actions/propose", new ActionRequest(Id(), current.Version, kind, target))).Snapshot;
        }
        s = await Button("combat.cast", s.AvailableActions.Single(a => a.Kind == "combat.cast").Target);
        Check.Equal("missile-allocation", s.Combat!.Standard!.Wait!.Kind);
        foreach (string target in new[] { "one/" + guardian, "undo", "one/" + guardian })
        {
            Check.True(s.AvailableActions.Any(a => a.Kind == "combat.missile_allocate" && a.Target == target), "Each edit is offered at once: " + target);
            s = await Button("combat.missile_allocate", target);
        }
        s = await Button("combat.missile_allocate", "all/" + guardian);
        Check.True(s.AvailableActions.Any(a => a.Kind == "combat.missile_cast"));
        Check.Equal(inputs, (await Session()).Inputs.Count); Check.Equal(calls, model.Calls); Check.Equal(2, dice.Count);
        Check.True(s.Combat!.Log.Count(l => l.Kind == "missile_allocation") == 5, "The plan stays in the battle log.");

        s = await Button("combat.missile_cast");
        var cast = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
        s = (await Post<ActionResponse>(h, id, "rolls/respond", cast)).Snapshot;
        Check.Equal(5, dice.Count); Check.Equal(41, s.Combat!.Units.Single(u => u.Id == guardian).HitPoints);
        var beat = (await Session()).Inputs.Single(i => i.Command?.RequestId == cast.RequestId);
        Check.Equal("completed", (await Settled(h, id, beat.RunId, 3000)).Status);
        Check.True(narrated.Contains("combat.cast") && narrated.Contains("missile_damage"), string.Join(",", narrated));
        Check.True(!narrated.Contains("missile_allocation"), "Plan edits never reach the story: " + string.Join(",", narrated));
    }

    private static async Task Scenario(bool plainText, bool legacy = false, bool restartFinal = false, bool standalone = false, bool direct = false)
    {
        var document = StandardCombatTests.Document();
        document = document with { Scenes = document.Scenes.Select(s => s.Id != "causeway" ? s : s with
        {
            Encounter = s.Encounter! with { Enemies = Enumerable.Range(0, 3).Select(i =>
                new ContentEnemy("foe" + i, "敌人" + i, 2, 1 + i, 50, 12, 20, AttackBonus: 3, DamageBonus: 1, Tactic: "engage")).ToArray() }
        }).ToArray() };
        string start = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        var dice = new SequenceDice(20, 1, 1, 1, 15, 1, 15, 1, 15, 1);
        var beatActors = new List<string>();
        bool endTurn = false, duplicateSent = false, pauseContinuation = restartFinal;
        int beat = 0;
        var model = new Model((_, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var agent = frame.GetProperty("agent");
            if (direct && endTurn)
            {
                Check.True(agent.TryGetProperty("command", out var commandSource), "Direct command has a persisted source, not a new player input.");
                Check.Equal(0, frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").GetArrayLength());
                Check.True(!request.Tools.Any(t => t.Name is "actions_propose" or "ask_player" or "ruling_request"));
            }
            if (agent.GetProperty("role").GetString() == "exploration")
                return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "对方开始进攻。", []));
            if (agent.TryGetProperty("narration", out var narration))
            {
                if (narration.GetProperty("pending").GetBoolean())
                {
                    Check.True(!request.Tools.Any(t => t.Name is "combat_continue" or "actions_propose" or "ask_player"));
                    var actors = narration.GetProperty("records").EnumerateArray().Where(r => r.GetProperty("kind").GetString() != "initiative")
                        .Select(r => r.GetProperty("actorId").GetString()!).Where(a => a.StartsWith("foe")).Distinct().ToArray();
                    Check.True(actors.Length <= 1, "Only the currently settled enemy is in the next narrative beat.");
                    if (endTurn && !duplicateSent)
                    {
                        duplicateSent = true;
                        return Tool("world_record", new NarrativeHarnessArgs("相同公开正文", [],
                            PrivateMessages: [new(["player"], "相同公开正文")]));
                    }
                    if (actors.Length == 1)
                    {
                        Check.Equal("foe" + beatActors.Count, actors[0]); beatActors.Add(actors[0]);
                        Check.Equal(4 + beatActors.Count * 2, dice.Count);
                    }
                    string story = "逐行动剧情段" + ++beat;
                    return plainText ? Text(story) : Tool("world_record", new NarrativeHarnessArgs(story, []));
                }
                if (narration.GetProperty("canContinue").GetBoolean())
                {
                    Check.True(request.Tools.Any(t => t.Name == "combat_continue"));
                    return Tool("combat_continue");
                }
            }
            if (legacy && !endTurn && dice.Count > 0)
                return Tool("world_record", new NarrativeHarnessArgs("逐行动剧情段" + ++beat, []));
            var candidates = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray();
            string candidate = candidates.Single(c => c.GetProperty("label").GetString() == (endTurn ? "结束回合" : start)).GetProperty("id").GetString()!;
            return Tool("actions_propose", new { candidateId = candidate });
        });
        var configure = Configure(model, extra: b =>
        {
            if (direct) b.Logging.AddConsole().SetMinimumLevel(LogLevel.Warning);
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            if (restartFinal) b.Services.AddSingleton<IHarnessRuntime>(sp =>
                new PauseContinuation(new PiHarnessRuntime(sp.GetRequiredService<IConfiguration>()), () => pauseContinuation));
            else b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("逐行动叙述隔离", "Arden", document,
                Preset with { CombatSystemPrompt = "独立战斗提示" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
            Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            string id = owner.Snapshot.Id; h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var parent = legacy ? await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "应对进攻。"), 48) : await Start(h, owner.Snapshot);
            parent = await Settled(h, id, parent.Id, 3000);
            Check.Equal("delegated", parent.Status);
            var session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                c => Task.FromResult(CombatAgentSessions.Current(c)!));
            var child = await Settled(h, id, session.Inputs[0].RunId, 3000);
            Check.True(child.Status == "waiting", child.Status + ":" + child.Error); Check.Equal(0, dice.Count);
            var snapshot = (await h.Get(id))!;
            var consent = new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var confirmed = await Post<ActionResponse>(h, id, "rolls/respond", consent);
            await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), confirmed.Snapshot.Version));
            child = await Settled(h, id, child.Id, 3000); Check.True(child.Status == "completed", child.Status + ":" + child.Error);
            Check.Equal(4, dice.Count); Check.Equal(1, beat);
            session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                c => Task.FromResult(CombatAgentSessions.Current(c)!));
            Check.Equal(1, session.Inputs.Count); // the original roll owner resumes; no competing automatic run
            snapshot = (await h.Get(id))!;
            if (standalone)
            {
                var button = new ActionRequest(Id(), snapshot.Version, "combat.dash");
                var action = await Post<ActionResponse>(h, id, "actions/propose", button);
                Check.Equal("resolved", action.Resolution.Status); Check.Equal(4, dice.Count);
                var buttonSession = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                    c => Task.FromResult(CombatAgentSessions.Current(c)!));
                var buttonInput = buttonSession.Inputs.Single(i => i.Command?.RequestId == button.RequestId);
                var buttonRun = await Settled(h, id, buttonInput.RunId, 3000);
                Check.Equal("completed", buttonRun.Status); Check.Equal(2, beat);
                await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                var buttonReplay = await Post<ActionResponse>(h, id, "actions/propose", button);
                Check.True(buttonReplay.Replayed); Check.Equal(4, dice.Count);
                snapshot = (await h.Get(id))!;
            }
            endTurn = true;
            var input = new HarnessInputRequest(Id(), snapshot.Version, "结束我的回合。");
            HarnessRunView run;
            var directCommand = new ActionRequest(Id(), snapshot.Version, "combat.end_turn");
            if (direct)
            {
                var accepted = await Post<ActionResponse>(h, id, "actions/propose", directCommand);
                Check.Equal("resolved", accepted.Resolution.Status);
                session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                    c => Task.FromResult(CombatAgentSessions.Current(c)!));
                var commandInput = session.Inputs.SingleOrDefault(i => i.Command?.RequestId == directCommand.RequestId);
                Check.True(commandInput is not null, "The committed button command must schedule its narration automatically.");
                run = (await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id}/harness/runs/{commandInput!.RunId}"))!;
                Check.Equal("", run.Input);
                var replayCommand = await Post<ActionResponse>(h, id, "actions/propose", directCommand);
                Check.True(replayCommand.Replayed);
            }
            else
            {
                run = await Post<HarnessRunView>(h, id, "harness/runs", input);
                run = await Settled(h, id, run.Id, 3000); Check.Equal("waiting", run.Status);
                snapshot = (await h.Get(id))!;
                var choice = snapshot.PendingIntent!;
                var accepted = await Post<ActionResponse>(h, id, "intents/respond", new IntentResponseRequest(Id(), snapshot.Version, choice.Id, "choose", choice.Options.Single().Id));
                Check.Equal(4, dice.Count); // end-turn is saved; no enemy has moved yet
                await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), accepted.Snapshot.Version));
            }
            if (restartFinal)
            {
                for (int i = 0; i < 3000; i++)
                {
                    run = (await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id}/harness/runs/{run.Id}"))!;
                    if (run.Error == "harness_runtime_failed") break;
                    await Task.Delay(25);
                }
                Check.Equal("harness_runtime_failed", run.Error);
                var paused = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, "player", run.Id)!;
                Check.True(paused.Steps.Last().Outcome?.ContinueCombat == true);
                Check.Equal(4, dice.Count); Check.Equal(2, beat);
                if (direct)
                {
                    int beforeReplay = model.Calls;
                    Check.True((await Post<ActionResponse>(h, id, "actions/propose", directCommand)).Replayed);
                    var interrupted = await Settled(h, id, run.Id, 3000);
                    Check.Equal("harness_runtime_failed", interrupted.Error);
                    Check.Equal(beforeReplay, model.Calls); Check.Equal(4, dice.Count);
                }
                await h.DisposeAsync();
                // Simulate the earlier crash window: the final receipt is durable, but
                // the internal continuation turn has not yet been saved.
                paused.Turns.RemoveAt(paused.Turns.Count - 1);
                paused.TurnVersions?.RemoveAt(paused.TurnVersions.Count - 1);
                pauseContinuation = false;
                h = await Host.Start(root, dice: dice, configure: configure);
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                h.App.Services.GetRequiredService<HarnessRunStore>().Save(paused);
                await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), paused.Version));
            }
            run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + ":" + run.Error);
            int expectedBeats = standalone ? 7 : 6;
            Check.Equal(3, beatActors.Count); Check.Equal(10, dice.Count); Check.Equal(expectedBeats, beat);
            var stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, "player", run.Id)!;
            Check.Equal(HarnessTools.CurrentVersion, stored.ToolContractVersion);
            Check.Equal(legacy ? 48 : HarnessTools.CurrentVersion, session.ToolContractVersion);
            Check.True(stored.Steps.Any(s => s.ToolRequest?.Name == "world_record" && s.Result!.Value.GetRawText().Contains("harness_invalid_payload")));
            var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after=0&limit=100"))!;
            var entries = page.Entries.Where(e => e.Narrative.StartsWith("逐行动剧情段")).ToArray();
            Check.Equal(expectedBeats, entries.Length);
            Check.True(entries.Select(e => e.Narrative).SequenceEqual(Enumerable.Range(1, expectedBeats).Select(i => "逐行动剧情段" + i)));
            Check.True(!HarnessJson.Serialize(page).Contains("相同公开正文"));
            Check.True(entries.Skip(standalone ? 3 : 2).All(e => e.ContinuationOf > 0));
            if (standalone)
            {
                Check.True(entries[1].ContinuationOf > 0); // the button's automatic reply
                Check.Equal(0, entries[2].ContinuationOf); // the later fresh input owns a new root
            }
            foreach (var entry in entries)
            {
                var detail = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{id}/activity/{entry.Sequence}"))!;
                Check.Equal(entry.Narrative, detail.Narrative);
            }
            int calls = model.Calls;
            async Task Replay()
            {
                if (direct) Check.True((await Post<ActionResponse>(h, id, "actions/propose", directCommand)).Replayed);
                else Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            }
            await Replay();
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await Replay();
            if (direct)
            {
                var restored = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                    c => Task.FromResult(CombatAgentSessions.Current(c)!));
                Check.Equal(1, restored.Inputs.Count(i => i.Command is not null));
                Check.Equal(2, restored.Inputs.Count);
                Check.True(!page.Entries.Any(e => e.Origin?.Input == "结束我的回合。"));
                Check.True(entries.Skip(1).All(e => e.ContinuationOf == directCommand.ExpectedVersion + 1));
            }
            var reopened = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after=0&limit=100"))!;
            Check.Equal(HarnessJson.Serialize(page), HarnessJson.Serialize(reopened));
            if (restartFinal)
            {
                await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
                {
                    for (int i = 0; i < 105; i++) c.Events.Add(new(Id(), ++c.Version, "fixture", "public", "", "fixture", DateTimeOffset.UtcNow, null));
                    return Task.FromResult(0);
                });
                foreach (var entry in entries)
                {
                    var cold = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{id}/activity/{entry.Sequence}"))!;
                    Check.Equal(entry.Narrative, cold.Narrative); Check.Equal(entry.ContinuationOf, cold.ContinuationOf);
                }
                var coldPage = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after=0&limit=100"))!;
                Check.Equal(6, coldPage.Entries.Count(e => e.Narrative.StartsWith("逐行动剧情段")));
            }
            Check.Equal(calls, model.Calls); Check.Equal(10, dice.Count);
            Console.WriteLine("Narration actual Node/Pi/MCP: three enemies, persisted beat before each continuation, duplicate rejection, own consent restart, ordered activity/detail and receipt replay; zero real-provider calls.");
        }
        finally { await h.DisposeAsync(); }
    }
}
