using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.GameSaveTests;

namespace DiceRealm.Tests;

internal static class CampaignLifecycleTests
{
    private sealed class CountingText : IIntentInterpreter, INarrator
    {
        public int Calls;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; throw new Exception("Dead character reached legacy interpreter"); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; throw new Exception("Dead character reached legacy narrator"); }
    }
    private static void Lifecycle(JsonElement s, string status, bool canAct)
    {
        var value = s.GetProperty("lifecycle"); Check.Equal(status, value.GetProperty("status").GetString()); Check.Equal(canAct, value.GetProperty("canAct").GetBoolean());
        if (status == "game_over") Check.True(value.GetProperty("message").GetString()!.Length > 0);
    }
    private static Task Condition(Host h, CreatedCampaign owner, string actor, params string[] conditions) => Mutate(h, owner, c =>
    {
        var character = PartyEngine.CharacterFor(c, actor);
        PartyEngine.SetCharacter(c, actor, character with { HitPoints = conditions.Length > 0 ? 0 : character.MaxHitPoints, Conditions = conditions });
    });

    public static async Task DeathRejectsActionsButLivingPlayersContinue()
    {
        var text = new CountingText(); var dice = new SequenceDice(17);
        var model = new Model((_, _) => Tool("ask_player", new { question = "仍活着的队友可以继续。" }));
        await using var h = await Host.Start(dice: dice, interpreter: text, narrator: text, configure: Configure(model));
        var owner = await Create(h); var guest = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
        Auth(h, owner.AccessToken); var healthy = await Save(h, id, "还活着"); var entry = await Entry(h, id, healthy.GetProperty("saveId").GetString()!);
        await Condition(h, owner, PartyEngine.HostId, "Dead", "Unconscious", "Prone");
        var s = (await h.Get(id))!; Lifecycle(await Get(h, id), "active", false); Check.Equal(0, s.AvailableActions.Length);
        foreach (string route in new[] { "actions", "actions/input", "actions/interpret", "actions/propose" })
            await Error(await h.Http.PostAsJsonAsync(Url(id, route), new ActionRequest(Id(), s.Version, route == "actions/propose" ? "observe" : "natural", Text: route == "actions/propose" ? "" : "死人行动")), HttpStatusCode.Conflict);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "harness/runs"), new HarnessInputRequest(Id(), s.Version, "死者调用新AI")), HttpStatusCode.Conflict);
        var gear = s.Character.Required().Inventory.First();
        await Error(await h.Http.PostAsJsonAsync(Url(id, "character/commands"), new CharacterPlayRequest(Id(), s.Version, "equip", gear.Id, gear.Equipped ? 0 : 1)), HttpStatusCode.Conflict);
        Check.Equal(0, model.Calls); Check.Equal(0, text.Calls); Check.Equal(0, dice.Count);
        Auth(h, guest.AccessToken); Lifecycle(await Get(h, id), "active", true);
        var aliveRun = await Start(h, (await h.Get(id))!); aliveRun = await Settled(h, id, aliveRun.Id); Check.Equal("waiting", aliveRun.Status); Check.Equal(1, model.Calls);
        await h.Http.PostAsync(Url(id, $"harness/runs/{aliveRun.Id}/cancel"), null);
        await Condition(h, owner, guest.Snapshot.Party!.SelfActorId, "Dead", "Unconscious", "Prone");
        Lifecycle(await Get(h, id), "game_over", false);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "harness/runs"), new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "全灭后请求")), HttpStatusCode.Conflict);
        Check.Equal(1, model.Calls);
        Auth(h, owner.AccessToken); await Load(h, id, entry); Lifecycle(await Get(h, id), "active", true);
        // The old (non-Harness) natural-input endpoints must reject before either legacy AI adapter.
        Timeline(h, ""); var legacy = await h.Create(); await Condition(h, legacy, PartyEngine.HostId, "Dead");
        foreach (string route in new[] { "actions", "actions/input", "actions/interpret" })
            await Error(await h.Http.PostAsJsonAsync(Url(legacy.Snapshot.Id, route), new ActionRequest(Id(), (await h.Get(legacy.Snapshot.Id))!.Version, "natural", Text: "不能解释此行动")), HttpStatusCode.Conflict);
        Check.Equal(0, text.Calls); Check.Equal(0, dice.Count);
    }

    public static async Task EmptyDownedStableAndActualDeath()
    {
        await using var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("Projection must not call AI"))));
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new { name = "空房", adventure = TestContent.Document, preset = Preset });
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var dm = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Auth(h, dm.AccessToken);
        Check.Equal("active", (await Get(h, dm.Snapshot.Id)).GetProperty("lifecycle").GetProperty("status").GetString());
        var guest = await HarnessBoundaryTests.Guest(h, dm); Auth(h, dm.AccessToken);
        await Condition(h, dm, guest.Snapshot.Party!.SelfActorId, "Unconscious", "Prone");
        Check.Equal("active", (await Get(h, dm.Snapshot.Id)).GetProperty("lifecycle").GetProperty("status").GetString());
        await Condition(h, dm, guest.Snapshot.Party.SelfActorId, "Dead", "Unconscious", "Prone");
        Check.Equal("game_over", (await Get(h, dm.Snapshot.Id)).GetProperty("lifecycle").GetProperty("status").GetString());
        var current = (await h.Get(dm.Snapshot.Id))!;
        await Post<ActionResponse>(h, current.Id, "seats/revoke", new RevokeSeatRequest(Id(), current.Version, guest.Snapshot.Party.SelfActorId));
        // An ended game stays ended even when the DM revokes its last dead seat.
        Check.Equal("game_over", (await Get(h, dm.Snapshot.Id)).GetProperty("lifecycle").GetProperty("status").GetString());
        // Derive Dead and Stable from the existing standard combat rules, not from HP alone.
        foreach (bool dead in new[] { false, true })
        {
            var c = StandardCombatTests.Campaign(hp: 1);
            var engine = new CombatEngine(dead ? new SequenceDice(20, 1, 15, 4, 1, 1) : new SequenceDice(20, 1, 15, 4, 10, 10, 10, 2));
            engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.end_turn", "");
            engine.Resolve(c, "combat.death_save", ""); engine.Resolve(c, "combat.death_save", "");
            if (!dead) engine.Resolve(c, "combat.death_save", "");
            Check.Equal(dead, c.Character.Required().Conditions.Contains("Dead"));
            var seat = await h.Create(); await Mutate(h, seat, x => x.Character = x.Character.Required() with { HitPoints = c.Character.HitPoints, Conditions = c.Character.Conditions });
            Check.Equal(dead ? "game_over" : "active", (await Get(h, seat.Snapshot.Id)).GetProperty("lifecycle").GetProperty("status").GetString());
        }
    }

    public static async Task DeadWaitingPlayerCannotRollOrResumeButCanCancel()
    {
        var model = AdventureModel(); var dice = new SequenceDice(18);
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: ConfigurePi));
        var owner = await Create(h); var guest = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
        Auth(h, guest.AccessToken); var run = await Start(h, (await h.Get(id))!); run = await Settled(h, id, run.Id, maximumPolls: 3000);
        Check.Equal("waiting", run.Status); Check.Equal("roll", run.Wait!.Kind);
        await Condition(h, owner, guest.Snapshot.Party!.SelfActorId, "Dead");
        var s = (await h.Get(id))!; Lifecycle(await Get(h, id), "active", false);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "rolls/respond"), new RollResponseRequest(Id(), s.Version, run.Wait.Id, "roll")), HttpStatusCode.Conflict);
        await Error(await h.Http.PostAsJsonAsync(Url(id, $"harness/runs/{run.Id}/resume"), new HarnessResumeRequest(Id(), s.Version)), HttpStatusCode.Conflict);
        Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
        await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, run.Wait.Id, "cancel"));
        var cancelled = await h.Http.PostAsync(Url(id, $"harness/runs/{run.Id}/cancel"), null);
        Check.True(cancelled.IsSuccessStatusCode, await cancelled.Content.ReadAsStringAsync());
        run = await Settled(h, id, run.Id); Check.Equal("cancelled", run.Status); Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
    }

    public static async Task BusySaveAndDeathBeforeNextModelSlot()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (_, _, ct) => { entered.TrySetResult(); await release.Task.WaitAsync(ct); return Tool("context_read"); });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var saved = await Save(h, id, "模型前"); var entry = await Entry(h, id, saved.GetProperty("saveId").GetString()!);
        var run = await Start(h, owner.Snapshot);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var list = await Get(h, id, "adventure/saves"); Check.True(!list.GetProperty("canSave").GetBoolean()); Check.True(list.GetProperty("reason").GetString()!.Length > 0);
            int version = (await h.Get(id))!.Version;
            await Error(await h.Http.PostAsJsonAsync(Url(id, "adventure/saves"), new { requestId = Id(), expectedVersion = version, name = "不能捕获半个调用" }), HttpStatusCode.Conflict);
            await Error(await h.Http.PostAsJsonAsync(Url(id, $"adventure/saves/{entry.GetProperty("id").GetString()}/load"), new { requestId = Id(), expectedVersion = version, expectedSaveRevision = 1 }), HttpStatusCode.Conflict);
            await Condition(h, owner, PartyEngine.HostId, "Dead");
        }
        finally { release.TrySetResult(); }
        run = await Settled(h, id, run.Id); Check.True(run.Status is "failed" or "cancelled"); Check.Equal(1, model.Calls);
        await Error(await h.Http.PostAsJsonAsync(Url(id, $"harness/runs/{run.Id}/resume"), new HarnessResumeRequest(Id(), (await h.Get(id))!.Version)), HttpStatusCode.Conflict);
        Check.Equal(1, model.Calls); Lifecycle(await Get(h, id), "game_over", false);
    }
}
