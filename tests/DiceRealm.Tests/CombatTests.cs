using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class CombatTests
{
    private sealed class MinimumDice : IDice
    {
        public int Count;
        public int Roll(int sides) { Count++; return 1; }
    }
    private sealed class CountingText : IIntentInterpreter, INarrator
    {
        public int InterpretCalls, NarrateCalls;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { InterpretCalls++; return Task.FromResult<Intent?>(null); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { NarrateCalls++; return Task.FromResult(new Narrative("", "test")); }
    }
    // The causeway patrol is authored encounter content, so a domain-level campaign under test has
    // to carry the imported document exactly like an activated campaign does.
    private static Campaign Campaign() => TestContent.Campaign("causeway", "Arena");
    private static CombatUnit P(Campaign c) => c.Combat!.Units.Single(u => u.Id == "player");
    private static CombatUnit E(Campaign c) => c.Combat!.Units.Single(u => u.Id == "guardian");
    private static bool Choice(Campaign c, string kind, string target = "") => Adventure.Choices(c).Any(a => a.Kind == kind && a.Target == target);
    private static void Near(Campaign c) { P(c).X = 2; P(c).Y = 2; E(c).X = 3; E(c).Y = 2; }

    public static Task WeaponRules()
    {
        var d = new SequenceDice(1); var e = new CombatEngine(d);
        var miss = e.WeaponAttack(1, true);
        Check.True(!miss.Hit && miss.Graze); Check.Equal(3, miss.Damage); Check.Equal(1, d.Count);
        d = new SequenceDice(20, 1, 2, 3, 4, 6, 5, 4, 3); e = new(d);
        var critical = e.WeaponAttack(99, true);
        Check.True(critical.Hit && critical.Critical); Check.Equal(4, critical.DamageRolls.Length);
        Check.Equal(4, critical.AlternateRolls.Length); Check.Equal(21, critical.Damage);
        Check.Equal(3, critical.DamageModifier); Check.Equal(9, d.Count);
        e = new(new SequenceDice(10, 1, 2, 2, 1)); var normal = e.WeaponAttack(12, true);
        Check.True(normal.EffectiveDice.SequenceEqual(new[] { 3, 3 })); Check.Equal(9, normal.Damage);
        d = new SequenceDice(10, 1, 2); e = new(d); var noRepeat = e.WeaponAttack(12, true, savageAttacker: false);
        Check.Equal(0, noRepeat.AlternateRolls.Length); Check.Equal(3, d.Count);
        d = new SequenceDice(20, 1); e = new(d); var dodge = e.WeaponAttack(16, false, disadvantage: true);
        Check.True(!dodge.Hit && !dodge.Critical); Check.Equal(1, dodge.Selected); Check.Equal(0, dodge.Damage);
        e = new(new SequenceDice(20, 4, 3)); var npcCrit = e.WeaponAttack(100, false);
        Check.Equal(8, npcCrit.Damage); Check.Equal(2, npcCrit.DamageRolls.Length);
        Check.Throws<InvalidOperationException>(() => new CombatEngine(new SequenceDice(21)).WeaponAttack(12, true));
        return Task.CompletedTask;
    }
    public static Task TurnAndGrid()
    {
        var c = Campaign(); var dice = new MinimumDice(); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", "");
        Check.True(c.Combat!.TurnOrder.SequenceEqual(new[] { "player", "guardian" }));
        Check.Equal(4, P(c).Initiative); Check.Equal(2, E(c).Initiative);
        Check.Equal(30, P(c).MovementRemaining); Check.Equal(12, P(c).HitPoints);
        Check.True(Adventure.Choices(c).All(a => a.Kind.StartsWith("combat.")));
        Check.True(!Choice(c, "combat.attack", "guardian"));
        var before = JsonSerializer.Serialize(c); var count = dice.Count;
        Check.Throws<GameException>(() => engine.Resolve(c, "combat.move", "6,2"));
        Check.Equal(before, JsonSerializer.Serialize(c)); Check.Equal(count, dice.Count);
        engine.Resolve(c, "combat.move", "2,2"); engine.Resolve(c, "combat.move", "3,2");
        Check.Equal(15, P(c).MovementRemaining); // 5 ordinary + 10 difficult, including diagonal alternatives.
        Check.True(!CombatEngine.Adjacent(c.Combat, 2, 0, 3, 1), "No corner cutting beside blocking cell");
        Check.True(!Choice(c, "combat.move", "3,0")); Check.True(!Choice(c, "combat.move", "5,2"));
        engine.Resolve(c, "combat.move", "4,2"); Check.True(Choice(c, "combat.attack", "guardian"));
        engine.Resolve(c, "combat.attack", "guardian"); Check.Equal(15, E(c).HitPoints); Check.True(!P(c).ActionAvailable);
        Check.Throws<GameException>(() => engine.Resolve(c, "combat.attack", "guardian"));
        engine.Resolve(c, "combat.end_turn", ""); Check.Equal(2, c.Combat.Round);
        Check.True(P(c).ActionAvailable && P(c).BonusActionAvailable && P(c).ReactionAvailable);
        Check.Equal(30, P(c).MovementRemaining); Check.Equal("player", c.Combat.ActiveActorId);
        engine.Resolve(c, "combat.dash", ""); Check.Equal(60, P(c).MovementRemaining);
        Check.True(!Choice(c, "combat.dash") && !Choice(c, "combat.attack", "guardian"));
        var tie = Campaign(); new CombatEngine(new SequenceDice(5, 7)).Resolve(tie, "combat.start", "");
        Check.Equal("player", tie.Combat!.TurnOrder[0]);
        var slow = Campaign(); new CombatEngine(new SequenceDice(1, 20, 1)).Resolve(slow, "combat.start", "");
        Check.Equal("guardian", slow.Combat!.TurnOrder[0]); Check.Equal("player", slow.Combat.ActiveActorId);
        Check.True(slow.Combat.Log.Any(l => l.Kind == "attack"));
        new CombatEngine(new MinimumDice()).Resolve(slow, "combat.end_turn", ""); Check.Equal(2, slow.Combat.Round);
        return Task.CompletedTask;
    }
    public static Task ReactionsAndRecovery()
    {
        var dice = new MinimumDice(); var engine = new CombatEngine(dice); var c = Campaign(); engine.Resolve(c, "combat.start", ""); Near(c);
        engine.Resolve(c, "combat.move", "1,2");
        Check.Equal(1, c.Combat!.Log.Count(l => l.Kind == "opportunity_attack")); Check.True(!E(c).ReactionAvailable);
        engine.Resolve(c, "combat.move", "2,2"); engine.Resolve(c, "combat.move", "1,2");
        Check.Equal(1, c.Combat.Log.Count(l => l.Kind == "opportunity_attack"));
        engine.Resolve(c, "combat.end_turn", ""); Check.True(E(c).ReactionAvailable);
        Near(c); engine.Resolve(c, "combat.disengage", ""); engine.Resolve(c, "combat.move", "1,2");
        Check.Equal(1, c.Combat.Log.Count(l => l.Kind == "opportunity_attack"));
        engine.Resolve(c, "combat.end_turn", ""); Near(c); engine.Resolve(c, "combat.dodge", "");
        engine.Resolve(c, "combat.end_turn", "");
        Check.Equal("disadvantage", c.Combat.Log.Last(l => l.Kind == "attack").Attack!.Mode);
        Check.True(!P(c).Dodging);
        P(c).HitPoints = 3; c.Character = c.Character.Required() with { HitPoints = 3 };
        var heal = new CombatEngine(new SequenceDice(10)); heal.Resolve(c, "combat.second_wind", "");
        Check.Equal(12, c.Character.HitPoints); Check.Equal(12, P(c).HitPoints);
        Check.Equal(1, c.Character.Resources.Single(r => r.Name == "Second Wind").Current);
        Check.True(!P(c).BonusActionAvailable && P(c).ActionAvailable);
        Check.Throws<GameException>(() => heal.Resolve(c, "combat.second_wind", ""));
        // Nonlethal KO interrupts the triggering move BEFORE the old square is left.
        P(c).HitPoints = 1; c.Character = c.Character with { HitPoints = 1 }; Near(c); E(c).ReactionAvailable = true;
        var knockout = new CombatEngine(new SequenceDice(20, 4, 4)); knockout.Resolve(c, "combat.move", "1,2");
        Check.Equal("defeated", c.Combat.Status); Check.Equal(2, P(c).X); Check.Equal(1, c.Character.HitPoints);
        Check.True(c.Character.Conditions.Contains("Unconscious") && c.Character.Conditions.Contains("Prone"));
        Check.True(!c.Character.Inventory.Single(i => i.Id == "greatsword").Equipped);
        Check.Equal(0, Adventure.Choices(c).Length);
        Check.True(PartyRest.View(c).Options.Single(o => o.Kind == "short").Available);
        engine.Resolve(c, "rest.short", ""); Check.Equal(60, c.ElapsedMinutes); Check.Equal(1, c.Character.HitPoints);
        Check.Equal(2, c.Character.Resources.Single(r => r.Name == "Second Wind").Current);
        Check.True(!c.Character.Conditions.Contains("Unconscious") && c.Character.Conditions.Contains("Prone"));
        Check.True(!c.Character.Inventory.Single(i => i.Id == "greatsword").Equipped);
        engine.Resolve(c, "rest.recover", ""); Check.Equal(0, c.Character.Conditions.Length);
        Check.True(c.Character.Inventory.Single(i => i.Id == "greatsword").Equipped);
        Check.True(Choice(c, "travel", "beacon") && !Choice(c, "combat.start"));
        c.SceneId = "harbor"; new CombatEngine(new SequenceDice(1)).Resolve(c, "rest.short", "hit_die");
        Check.Equal(4, c.Character.HitPoints); Check.Equal(120, c.ElapsedMinutes);
        Check.Equal(0, c.Character.Resources.Single(r => r.Name == "Hit Dice (d10)").Current);
        Check.Throws<GameException>(() => engine.Resolve(c, "rest.short", "hit_die"));
        // A short rest restores ONE use, not all uses, and never restores the Hit Die.
        c.Character = c.Character with { Resources = [new("Second Wind", 0, 2), new("Hit Dice (d10)", 0, 1)] };
        engine.Resolve(c, "rest.short", ""); Check.Equal(1, c.Character.Resources[0].Current); Check.Equal(0, c.Character.Resources[1].Current);
        var win = Campaign(); engine.Resolve(win, "combat.start", ""); Near(win); E(win).HitPoints = 3;
        engine.Resolve(win, "combat.attack", "guardian"); Check.Equal("victory", win.Combat!.Status);
        Check.True(win.Facts.Contains("guardian-disabled")); Check.Equal(12, win.Character.Required().HitPoints); Check.Equal(1, win.Chapter);
        var escape = Campaign(); engine.Resolve(escape, "combat.start", "");
        Check.True(!Choice(escape, "combat.retreat")); engine.Resolve(escape, "combat.move", "0,2"); engine.Resolve(escape, "combat.retreat", "");
        Check.Equal("retreated", escape.Combat!.Status); Check.Equal(20, P(escape).MovementRemaining); Check.Equal("causeway", escape.SceneId);
        var corner = Campaign(); engine.Resolve(corner, "combat.start", "");
        P(corner).X = 2; P(corner).Y = 0; E(corner).X = 1; E(corner).Y = 0;
        int rolledBeforeExit = dice.Count; engine.Resolve(corner, "combat.retreat", "");
        Check.Equal("retreated", corner.Combat!.Status); Check.Equal(rolledBeforeExit, dice.Count);
        Check.True(E(corner).ReactionAvailable, "Crossing map bounds while still in reach is not an opportunity trigger");
        var threatenedExit = Campaign(); engine.Resolve(threatenedExit, "combat.start", "");
        P(threatenedExit).X = 0; P(threatenedExit).Y = 2; E(threatenedExit).X = 1; E(threatenedExit).Y = 2;
        engine.Resolve(threatenedExit, "combat.retreat", "");
        Check.True(!E(threatenedExit).ReactionAvailable && threatenedExit.Combat!.Log.Any(l => l.Kind == "opportunity_attack"));
        return Task.CompletedTask;
    }
    public static async Task HttpDurability()
    {
        var dice = new MinimumDice(); var text = new CountingText();
        var host = await Host.Start(dice: dice, interpreter: text, narrator: text);
        var created = await host.Create(); var s = created.Snapshot;
        Check.True(s.Combat is null);
        s = (await host.Act(s, "talk")).Snapshot; s = (await host.Act(s, "travel", "causeway")).Snapshot;
        int narrated = text.NarrateCalls;
        var request = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "combat.start");
        var duplicate = await Task.WhenAll(host.Send(s.Id, request), host.Send(s.Id, request));
        var responses = await Task.WhenAll(duplicate.Select(async r => (await r.Content.ReadFromJsonAsync<ActionResponse>())!));
        Check.True(responses[0].Replayed != responses[1].Replayed); Check.Equal(2, dice.Count);
        s = responses[0].Snapshot; Check.Equal(narrated, text.NarrateCalls); Check.Equal("system", s.Events.Last().NarrativeSource);
        var art = s.SceneAsset.Id; var stats = JsonSerializer.Serialize(s.Character); var battle = JsonSerializer.Serialize(s.Combat);
        var deferred = await host.Act(s, "natural", text: "飞到敌人背后并施放火球术"); s = deferred.Snapshot;
        Check.Equal("needs_adjudication", deferred.Resolution.Status); Check.Equal(0, text.InterpretCalls);
        Check.Equal(narrated, text.NarrateCalls); Check.Equal(2, dice.Count);
        Check.Equal(stats, JsonSerializer.Serialize(s.Character)); Check.Equal(battle, JsonSerializer.Serialize(s.Combat));
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "travel", "beacon"))).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "combat.move", "5,2"))).StatusCode);
        Check.Equal(HttpStatusCode.BadRequest, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "combat.fireball"))).StatusCode);
        var forged = new StringContent(JsonSerializer.Serialize(new { requestId = Guid.NewGuid(), expectedVersion = s.Version,
            kind = "combat.attack", target = "guardian", damage = 999, rolls = new[] { 20 } }), Encoding.UTF8, "application/json");
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync($"/api/v1/campaigns/{s.Id}/actions", forged)).StatusCode);
        Check.Equal(s.Version, (await host.Get(s.Id))!.Version);
        var move = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "combat.move", "2,2");
        var concurrent = await Task.WhenAll(host.Send(s.Id, move), host.Send(s.Id, move with { RequestId = Guid.NewGuid().ToString(), Target = "0,2" }));
        Check.Equal(1, concurrent.Count(r => r.StatusCode == HttpStatusCode.OK));
        Check.Equal(1, concurrent.Count(r => r.StatusCode == HttpStatusCode.Conflict)); s = (await host.Get(s.Id))!;
        Check.Equal(art, s.SceneAsset.Id); Check.Equal(narrated, text.NarrateCalls);
        var snapshot = JsonSerializer.Serialize(s.Combat); var root = host.Root; await host.DisposeAsync();
        await using var restart = await Host.Start(root, dice, interpreter: text, narrator: text);
        restart.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", created.AccessToken);
        s = (await restart.Get(s.Id))!; Check.Equal(snapshot, JsonSerializer.Serialize(s.Combat));
        var replay = (await (await restart.Send(s.Id, request)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(s.Version, replay.Snapshot.Version); Check.Equal(2, dice.Count);
        Check.True(replay.Resolution.CombatLog!.Any(l => l.Kind == "initiative"));
        // Finish through HTTP, including NPC turns, attacks and durable resource-free victory.
        for (int i = 0; i < 100 && s.Combat!.Status == "active"; i++)
        {
            var actions = s.AvailableActions;
            var action = actions.FirstOrDefault(a => a.Kind == "combat.attack") ??
                actions.Where(a => a.Kind == "combat.move").OrderBy(a => Distance(a.Target, s.Combat.Units.Single(u => u.Id == "guardian"))).FirstOrDefault() ??
                actions.Single(a => a.Kind == "combat.end_turn");
            if (!s.Combat.Units.Single(u => u.Id == "player").ActionAvailable) action = actions.Single(a => a.Kind == "combat.end_turn");
            s = (await restart.Act(s, action.Kind, action.Target)).Snapshot;
        }
        Check.Equal("victory", s.Combat!.Status); Check.Equal(art, s.SceneAsset.Id); Check.Equal(narrated, text.NarrateCalls);
        var final = (await restart.Get(s.Id))!; Check.Equal(s.Version, final.Version); Check.Equal("victory", final.Combat!.Status);
        Check.True(final.AvailableActions.Any(a => a.Kind == "travel"));
        // Old additive save fields are optional; upgrading the preset preserves spent resources and HP.
        var old = StarterCharacter.Create("Old") with { HitPoints = 7, Resources = [new("Second Wind", 1, 2)] };
        var upgraded = StarterCharacter.Upgrade(old); Check.Equal(7, upgraded.HitPoints); Check.Equal(1, upgraded.Resources[0].Current);
        Check.Equal(1, upgraded.Resources.Single(r => r.Name == "Hit Dice (d10)").Current);
        Check.Equal(3, StarterCharacter.Upgrade(upgraded).Resources.Length);
        Check.Equal(0, upgraded.Resources.Single(r => r.Name == "Heroic Inspiration").Current);
    }
    private static int Distance(string target, CombatUnit unit)
    { var xy = target.Split(',').Select(int.Parse).ToArray(); return Math.Max(Math.Abs(xy[0] - unit.X), Math.Abs(xy[1] - unit.Y)); }
}
