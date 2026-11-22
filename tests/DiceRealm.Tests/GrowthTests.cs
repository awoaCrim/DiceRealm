using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class GrowthTests
{
    // The level-2 milestone is the fixture's authored condition (beacon-lit) claimed at the harbor.
    private static Campaign Campaign(bool wizard = false)
    {
        var campaign = TestContent.Campaign("harbor", "Growth");
        campaign.Character = CharacterEngine.Create("Arden", wizard ? CharacterEngine.Wizard : CharacterEngine.Fighter);
        campaign.Facts.Add("beacon-lit");
        return campaign;
    }
    public static Task Milestones()
    {
        var engine = new GrowthEngine(new SequenceDice(1)); var c = Campaign();
        c.Character = c.Character.Required() with { HitPoints = 4 };
        CharacterEngine.Change(c, "Second Wind", -1); CharacterEngine.Change(c, "Hit Dice (d10)", -1);
        engine.Resolve(c, "growth.level2", "fixed");
        Check.Equal(2, c.Character.Level); Check.Equal(20, c.Character.MaxHitPoints); Check.Equal(12, c.Character.HitPoints);
        Check.Equal(1, CharacterEngine.Value(c.Character, "Second Wind")); Check.Equal(1, CharacterEngine.Value(c.Character, "Hit Dice (d10)"));
        Check.Equal(1, CharacterEngine.Value(c.Character, "Action Surge"));
        Check.Throws<GameException>(() => engine.Resolve(c, "growth.level2", "fixed"));
        var unchanged = StarterCharacter.Upgrade(c.Character); Check.Equal(2, unchanged.Level); Check.True(unchanged.Features.Any(f => f.StartsWith("Action Surge")));
        var wizard = Campaign(true); CharacterEngine.Change(wizard, "Spell Slots (1st)", -1);
        Check.True(GrowthEngine.Choices(wizard).Select(a => a.Target).Order().SequenceEqual(new[] { "Arcana", "History", "Investigation" }));
        Check.Throws<GameException>(() => engine.Resolve(wizard, "growth.level2", "Religion"));
        engine.Resolve(wizard, "growth.level2", "Investigation");
        Check.Equal(16, wizard.Character.Required().MaxHitPoints); Check.Equal(16, wizard.Character.Required().HitPoints);
        Check.Equal(2, CharacterEngine.Value(wizard.Character, "Spell Slots (1st)"));
        Check.Equal(3, wizard.Character.Resources.Single(r => r.Name == "Spell Slots (1st)").Maximum);
        Check.Equal(8, wizard.Character.Spellcasting!.Spells.Count(s => s.Level > 0));
        Check.Equal(5, wizard.Character.Spellcasting.Spells.Count(s => s.Level > 0 && s.Prepared));
        Check.Equal("Investigation", wizard.Character.Expertise!.Single());
        var check = new RulesEngine(new SequenceDice(5)).AbilityCheck(wizard.Character, "intelligence", "Investigation", 12);
        Check.Equal(6, check.Modifier); Check.Equal(11, check.Total);
        var notEarned = Campaign(); notEarned.Facts.Clear(); Check.Equal(0, GrowthEngine.Choices(notEarned).Length);
        var away = Campaign(); away.SceneId = "causeway"; Check.Equal(0, GrowthEngine.Choices(away).Length);
        return Task.CompletedTask;
    }
    public static Task ActionSurgeAndHitDice()
    {
        var c = Campaign(); new GrowthEngine(new SequenceDice(1)).Resolve(c, "growth.level2", "fixed"); c.SceneId = "causeway";
        var dice = new SequenceDice(20, 1, 10, 1, 1, 2, 2, 10, 1, 1); var combat = new CombatEngine(dice);
        combat.Resolve(c, "combat.start", ""); var p = c.Combat!.Units.Single(u => u.Id == "player"); var enemy = c.Combat.Units.Single(u => u.Id == "guardian");
        enemy.X = 2; enemy.Y = 2; enemy.HitPoints = 100;
        combat.Resolve(c, "combat.attack", "guardian"); Check.True(p.SavageAttackerUsed); Check.True(!p.ActionAvailable);
        combat.Resolve(c, "combat.action_surge", ""); Check.True(p.ActionAvailable && p.SurgeAction && p.SavageAttackerUsed);
        Check.True(p.BonusActionAvailable); Check.Equal(0, CharacterEngine.Value(c.Character.Required(), "Action Surge"));
        var second = combat.Resolve(c, "combat.attack", "guardian").CombatLog!.Single(e => e.Attack != null).Attack!;
        Check.Equal(0, second.AlternateRolls.Length); Check.Equal(10, dice.Count);
        Check.Throws<GameException>(() => combat.Resolve(c, "combat.action_surge", ""));
        // Even a future caster feature must never turn Action Surge into a Magic action.
        p.ActionAvailable = true; c.Character = c.Character with { Spellcasting = CharacterEngine.Create("Mage", CharacterEngine.Wizard).Spellcasting };
        Check.True(!CombatEngine.Choices(c).Any(a => a.Kind == "combat.cast"));
        c.Combat.Status = "retreated"; c.SceneId = "harbor"; c.Character = c.Character with { HitPoints = 1 };
        var chars = new CharacterEngine(new SequenceDice(1, 1)); chars.Resolve(c, "rest.short", "hit_die");
        Check.Equal(4, c.Character.HitPoints); Check.Equal(1, CharacterEngine.Value(c.Character, "Action Surge"));
        chars.Resolve(c, "rest.hit_die", ""); Check.Equal(7, c.Character.HitPoints); Check.Equal(60, c.ElapsedMinutes);
        Check.Equal(0, CharacterEngine.Value(c.Character, "Hit Dice (d10)"));
        Check.Throws<GameException>(() => chars.Resolve(c, "rest.hit_die", ""));
        return Task.CompletedTask;
    }
    private static async Task<CampaignSnapshot> Unlock(Host host, CampaignSnapshot s)
    {
        s = (await host.Act(s, "talk")).Snapshot; s = (await host.Act(s, "travel", "causeway")).Snapshot;
        s = (await host.Act(s, "travel", "beacon")).Snapshot; s = (await host.Act(s, "talk")).Snapshot;
        s = (await host.Act(s, "travel", "causeway")).Snapshot; return (await host.Act(s, "travel", "harbor")).Snapshot;
    }
    public static async Task HttpProgressionAndTacticalMind()
    {
        var dice = new SequenceDice(1, 10, 1, 1); var host = await Host.Start(dice: dice);
        var created = await host.LoadLegacyCampaign(); var s = created.Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "growth.level2", "fixed"))).StatusCode);
        s = await Unlock(host, s);
        var upgrade = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "growth.level2", "fixed");
        var doubled = await Task.WhenAll(host.Send(s.Id, upgrade), host.Send(s.Id, upgrade));
        Check.True(doubled.All(r => r.StatusCode == HttpStatusCode.OK));
        s = (await doubled[0].Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot; Check.Equal(2, s.Character.Required().Level);
        var fail = await host.Act(s, "investigate"); s = fail.Snapshot; Check.True(!fail.Resolution.Check!.Success);
        Check.True(s.AvailableActions.Any(a => a.Kind == "character.tactical_mind")); Check.Equal(1, dice.Count);
        var path = host.Root; await host.DisposeAsync();
        await using var restart = await Host.Start(path, dice);
        restart.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", created.AccessToken);
        s = (await restart.Get(s.Id))!; Check.True(s.AvailableActions.Any(a => a.Kind == "character.tactical_mind"));
        var request = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "character.tactical_mind");
        var results = await Task.WhenAll(restart.Send(s.Id, request), restart.Send(s.Id, request));
        var corrected = (await results[0].Content.ReadFromJsonAsync<ActionResponse>())!; s = corrected.Snapshot;
        Check.True(corrected.Resolution.Check!.Success); Check.Equal(14, corrected.Resolution.Check.Total);
        Check.Equal(10, corrected.Resolution.Check.BonusRolls!.Single()); Check.Equal(2, dice.Count);
        Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Second Wind")); Check.True(!s.AvailableActions.Any(a => a.Kind == "character.tactical_mind"));
        s = (await restart.Act(s, "story.talk", "mara")).Snapshot; s = (await restart.Act(s, "story.accept", "tide-ledger")).Snapshot;
        s = (await restart.Act(s, "travel", "causeway")).Snapshot; s = (await restart.Act(s, "travel", "watchpost")).Snapshot;
        s = (await restart.Act(s, "story.search", "cargo-case")).Snapshot;
        var stillFailed = await restart.Act(s, "character.tactical_mind"); s = stillFailed.Snapshot;
        Check.True(!stillFailed.Resolution.Check!.Success); Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Second Wind"));
        Check.Equal(4, dice.Count); Check.True(!s.Facts.Contains("ledger-found"));
        Check.True(!s.AvailableActions.Any(a => a.Kind == "character.tactical_mind"));
        // Another resolved action closes an offered correction rather than allowing late rerolls.
        s = (await restart.Act(s, "travel", "causeway")).Snapshot;
        s = (await restart.Act(s, "investigate")).Snapshot; // default roll 10 succeeds, no correction
        Check.True(!s.AvailableActions.Any(a => a.Kind == "character.tactical_mind"));
        var wizardHost = await Host.Start(); await using var disposeWizard = wizardHost;
        var wiz = await wizardHost.LoadLegacyCampaign("CasterGrowth", "Mira", CharacterEngine.Wizard);
        var ws = await Unlock(wizardHost, wiz.Snapshot); ws = (await wizardHost.Act(ws, "growth.level2", "Arcana")).Snapshot;
        Check.Equal(16, ws.Character.Required().MaxHitPoints); Check.Equal("Arcana", ws.Character.Required().Expertise!.Single());
    }
}
