using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.GameSaveTests;

namespace DiceRealm.Tests;

internal static class GameSaveCombatTests
{
    private sealed class MissingChild : IHarnessRuntime
    {
        public bool Fault = true;
        private readonly Loop loop = new();
        public Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct) =>
            loop.Execute(execution, async (call, token) =>
            {
                var result = await callback(call, token);
                if (Fault && execution.Turns.Any(t => t.Contains("\"combatReturn\"")) && call.Turn == execution.Turns.Length - 1 && call.Kind == "tool" &&
                    HarnessJson.Read<HarnessToolRequest>(call.Payload).Name == "combat_delegate") throw new IOException("isolated durable delegation before child");
                return result;
            }, ct);
    }
    private static Task<CombatAgentSession> Current(Host h, CreatedCampaign owner) => h.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, false,
        c => Task.FromResult(CombatAgentSessions.Current(c)!));
    private static async Task<CreatedCampaign> CreateBattle(Host h, AdventureDocument document)
    {
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("读档战斗", "Arden", document,
            Preset with { CombatSystemPrompt = "独立战斗" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Auth(h, owner.AccessToken); return owner;
    }
    private static async Task EndBattle(Host h, string id)
    {
        var s = (await h.Get(id))!;
        s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
        s = (await h.Act(s, "combat.disengage")).Snapshot;
        s = (await h.Act(s, "combat.move", "0," + s.Combat!.Units.Single(u => u.Id == "player").Y)).Snapshot;
        s = (await h.Act(s, "combat.retreat")).Snapshot; Check.Equal("retreated", s.Combat!.Status);
    }
    private static HarnessModelReply Propose(HarnessModelRequest request, string label) => Tool("actions_propose", new { candidateId = HarnessExecutionProtocolTests.Frame(request)
        .GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray().Single(c => c.GetProperty("label").GetString() == label).GetProperty("id").GetString()! });

    public static async Task FutureParentCallStillConsumesRestoredCombatReturn()
    {
        var document = StandardCombatTests.Document(); string label = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        var model = new Model((n, request) => n == 1 ? Tool("combat_delegate", new CombatDelegateArgs(HarnessExecutionProtocolTests.Frame(request).GetProperty("agent").GetProperty("encounterId").GetString()!, "交锋", [])) :
            n == 2 ? Propose(request, label) : Tool("world_record", new NarrativeHarnessArgs("战斗结束，继续探索。", [])));
        var dice = new SequenceDice(20, 1, 20, 1);
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); var owner = await CreateBattle(h, document); string id = owner.Snapshot.Id;
        // Contract 47 parent, as in CombatAgentRecoveryTests: these cover save/restore of delegation and return,
        // not the v49+ paced narration that adds an automatic model call after every committed command.
        var parent = await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "调查现场"), 47); await Settled(h, id, parent.Id); var battle = await Current(h, owner);
        await Settled(h, id, battle.Inputs[0].RunId); Check.Equal(2, model.Calls);
        var save = await Save(h, id, "战斗待先攻"); var entry = await Entry(h, id, save.GetProperty("saveId").GetString()!);
        await EndBattle(h, id); Check.Equal("completed", (await Settled(h, id, parent.Id)).Status); Check.Equal(3, model.Calls);
        await Load(h, id, entry); var runs = h.App.Services.GetRequiredService<HarnessRunStore>();
        Check.Equal("unknown", runs.Read(id, PartyEngine.HostId, parent.Id)!.Status); Check.Equal(3, model.Calls);
        await EndBattle(h, id);
        var restored = runs.Read(id, PartyEngine.HostId, parent.Id)!; Check.Equal("unknown", restored.Status); Check.Equal("harness_model_unknown", restored.Error);
        Check.Equal(1, restored.CombatReturns!.Count); Check.Equal(1, restored.Turns.Count(t => t.Contains("\"combatReturn\""))); Check.Equal(3, model.Calls); Check.Equal(4, dice.Count);
        Check.True(await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
            c => Task.FromResult(c.CombatAgentSessions!.Single().ReturnConsumed && c.CombatAgentSessions!.Single().Phase == "returned")));
        // Interrupted after the parent receipt but before consume: explicit resume only reconciles.
        await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
        { var session = c.CombatAgentSessions!.Single(); session.ReturnConsumed = false; session.Phase = "return_pending"; return Task.FromResult(true); });
        var resume = new HarnessResumeRequest(Id(), (await h.Get(id))!.Version);
        var response = await h.Http.PostAsJsonAsync(Url(id, $"harness/runs/{parent.Id}/resume"), resume);
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{parent.Id}/resume", resume)).Replayed);
        Check.True((await h.Http.PostAsync(Url(id, $"harness/runs/{parent.Id}/cancel"), null)).IsSuccessStatusCode); Check.Equal(3, model.Calls);
        var next = await Start(h, (await h.Get(id))!, "在交锋结束后观察四周。"); Check.Equal("completed", (await Settled(h, id, next.Id)).Status);
        Check.Equal(4, model.Calls); Check.Equal("unknown", runs.Read(id, PartyEngine.HostId, parent.Id)!.Status);
    }

    public static async Task MissingIssuedChildRestoresTerminalPlaceholder()
    {
        foreach (bool recoverFirst in new[] { true, false })
        {
            var document = StandardCombatTests.Document(); document = document with { Scenes = document.Scenes.Select(s => s.Encounter is null ? s : s with { Encounter = s.Encounter with { Repeatable = true } }).ToArray() };
            string label = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
            var model = new Model((n, request) => n is 1 or 3 ? Tool("combat_delegate", new CombatDelegateArgs(HarnessExecutionProtocolTests.Frame(request).GetProperty("agent").GetProperty("encounterId").GetString()!, "交锋", [])) : Propose(request, label));
            var runtime = new MissingChild(); var dice = new SequenceDice(20, 1);
            await using var h = await Host.Start(dice: dice, configure: Configure(model, runtime)); var owner = await CreateBattle(h, document); string id = owner.Snapshot.Id;
            var parent = await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "调查现场"), 47); await Settled(h, id, parent.Id); var battle = await Current(h, owner);
            await Settled(h, id, battle.Inputs[0].RunId); await EndBattle(h, id); Check.Equal("interrupted", (await Settled(h, id, parent.Id)).Status);
            battle = await Current(h, owner); string first = battle.Inputs[0].RunId; var runs = h.App.Services.GetRequiredService<HarnessRunStore>();
            Check.True(runs.Read(id, PartyEngine.HostId, first) is null); Check.Equal(3, model.Calls);
            var save = await Save(h, id, "委派后尚无子运行"); var entry = await Entry(h, id, save.GetProperty("saveId").GetString()!);
            runtime.Fault = false;
            await Post<HarnessRunView>(h, id, $"harness/runs/{parent.Id}/resume", new HarnessResumeRequest(Id(), (await h.Get(id))!.Version));
            Check.Equal("waiting", (await Settled(h, id, first)).Status); Check.Equal(4, model.Calls);
            string ledgerPath = Directory.GetFiles(Path.Combine(h.Root, "harness-issued", id), first + ".json", SearchOption.AllDirectories).Single(); string ledger = File.ReadAllText(ledgerPath);
            await Load(h, id, entry); Check.True(runs.Read(id, PartyEngine.HostId, first) is null); Check.Equal(4, model.Calls);
            var view = (await h.Http.GetFromJsonAsync<HarnessRunView>(Url(id, $"harness/runs/{parent.Id}")))!;
            Check.True(!view.Notice.Contains("尚未开始")); Check.True(runs.Read(id, PartyEngine.HostId, first) is null);
            if (recoverFirst)
            {
                await Post<HarnessRunView>(h, id, $"harness/runs/{parent.Id}/resume", new HarnessResumeRequest(Id(), (await h.Get(id))!.Version));
                var placeholder = runs.Read(id, PartyEngine.HostId, first)!; Check.Equal("unknown", placeholder.Status); Check.Equal("harness_model_unknown", placeholder.Error);
                Check.Equal(0, placeholder.Steps.Count); Check.Equal(0, placeholder.ModelAttempts); Check.Equal(4, model.Calls);
            }
            Check.True((await h.Http.PostAsync(Url(id, $"harness/runs/{parent.Id}/cancel"), null)).IsSuccessStatusCode);
            var next = await Start(h, (await h.Get(id))!, "继续应对当前战斗。"); Check.Equal("waiting", (await Settled(h, id, next.Id)).Status);
            Check.Equal(5, model.Calls); Check.Equal(2, dice.Count); Check.Equal(battle.Id, (await Current(h, owner)).Id);
            var terminal = runs.Read(id, PartyEngine.HostId, first)!; Check.Equal(recoverFirst ? "unknown" : "cancelled", terminal.Status); Check.Equal(0, terminal.Steps.Count);
            Check.Equal(ledger, File.ReadAllText(ledgerPath));
        }
    }
}
