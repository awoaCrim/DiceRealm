using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class StandardCombatTests
{
    internal static AdventureDocument Document(string tactic = "engage", int damageBonus = 1) => TestContent.Document with
    {
        StartSceneId = "causeway",
        Scenes = TestContent.Document.Scenes.Select(s => s.Id != "causeway" ? s : s with
        {
            Encounter = s.Encounter! with
            {
                Mode = StandardCombatEngine.Mode, Nonlethal = false, When = new(), Cells = [],
                Enemies = [new("guardian", "标准遭遇夹具", 2, 2, 50, 12, 20, AttackBonus: 3, DamageBonus: damageBonus, Tactic: tactic)]
            }
        }).ToArray()
    };
    internal static Campaign Campaign(string tactic = "engage", int hp = 12, int temp = 0, int damageBonus = 1)
    {
        var c = TestContent.Campaign("causeway"); c.Adventure = Document(tactic, damageBonus);
        c.Character = c.Character.Required() with { HitPoints = hp, TemporaryHitPoints = temp };
        ContentValidator.Validate(c.Adventure); return c;
    }
    internal static CombatUnit P(Campaign c) => c.Combat!.Units.Single(u => u.Id == "player");
    internal static CombatUnit E(Campaign c) => c.Combat!.Units.Single(u => u.Id == "guardian");
    private static bool Has(Campaign c, string kind, string target = "") => Adventure.Choices(c).Any(a => a.Kind == kind && a.Target == target);
    public static Task ExplicitModeAndGeometry()
    {
        var legacy = TestContent.Document;
        var standard = Document(); ContentValidator.Validate(standard);
        var encounter = standard.Scenes.Single(s => s.Id == "causeway").Encounter!;
        void Reject(ContentEncounter e) => Check.Throws<GameException>(() => ContentValidator.Validate(standard with
        { Scenes = standard.Scenes.Select(s => s.Id == "causeway" ? s with { Encounter = e } : s).ToArray() }));
        Reject(encounter with { Mode = null }); Reject(encounter with { Nonlethal = true }); Reject(encounter with { Mode = "guess-2024" });
        Reject(encounter with { Mode = null, Nonlethal = true }); // tactics cannot leak into the old mode
        var oldJson = JsonSerializer.Serialize(legacy, JsonFiles.Options);
        Check.True(!oldJson.Contains("\"mode\"") && !oldJson.Contains("\"tactic\""));
        Check.Equal(oldJson, JsonSerializer.Serialize(JsonSerializer.Deserialize<AdventureDocument>(oldJson, JsonFiles.Options), JsonFiles.Options));
        var b = new CombatState { Units = [], Cells = [new(2, 2, "half-cover"), new(3, 2, "three-quarters-cover")] };
        var a = new CombatUnit { Id = "a", X = 1, Y = 2 }; var z = new CombatUnit { Id = "z", X = 5, Y = 2 };
        Check.Equal(5, CombatGeometry.Cover(b, a, z)); Check.Equal(5, CombatGeometry.Cover(b, z, a));
        b.Cells = [new(2, 2, "half-cover")]; Check.Equal(2, CombatGeometry.Cover(b, a, z));
        b.Cells = [new(2, 2, "blocked")]; Check.Equal(99, CombatGeometry.Cover(b, a, z));
        Check.True(!CombatGeometry.Adjacent(b, 1, 2, 2, 3));
        b.Cells = []; b.Units = [new() { Id = "middle", X = 3, Y = 2 }]; Check.Equal(2, CombatGeometry.Cover(b, a, z));
        b.Units[0].Withdrawn = true; Check.Equal(0, CombatGeometry.Cover(b, a, z));
        var c = Campaign(); var dice = new SequenceDice(20, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        string before = JsonSerializer.Serialize(c); int count = dice.Count;
        Check.Throws<GameException>(() => engine.Resolve(c, "combat.react", "attack"));
        Check.Equal(before, JsonSerializer.Serialize(c)); Check.Equal(count, dice.Count);
        Check.Equal(0, ActionUnderstanding.Candidates(c, includeStandard: false).Length);
        StandardCombatEngine.ValidateState(c);
        Check.Equal("7f6eb0ac756062120c3562733add5c2b29c33ccead09b937d478a209abe45e48", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(10))));
        string frozen = HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(8)));
        Check.Equal("08cda1fd41df3bb3aa648a9fea35b933c90d1fd6b06851b68abd4a15b893d20e", frozen);
        Check.Equal("81934bf955282d68ef2bf3546cc7bd80447c02ca55d1b5377ed9d97293755eed", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(9))));
        return Task.CompletedTask;
    }
    public static Task ReactionPausesBeforeMovement()
    {
        var c = Campaign("withdraw"); var dice = new SequenceDice(20, 1, 1); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.end_turn", "");
        Check.Equal("opportunity", c.Combat!.Standard!.Wait!.Kind); Check.Equal("player", c.Combat.Standard.Wait.ActorId);
        Check.Equal(1, E(c).X); Check.Equal(1, E(c).Y); Check.Equal(2, dice.Count);
        Check.True(P(c).ReactionAvailable && Has(c, "combat.react", "attack"));
        StandardCombatEngine.ValidateState(c);
        string json = JsonSerializer.Serialize(c, JsonFiles.Options);
        var reopened = JsonSerializer.Deserialize<Campaign>(json, JsonFiles.Options)!;
        StandardCombatEngine.ValidateState(reopened);
        engine.Resolve(reopened, "combat.react", "attack");
        Check.Equal(3, dice.Count); Check.Equal(47, E(reopened).HitPoints); Check.True(!P(reopened).ReactionAvailable);
        Check.Equal("victory", reopened.Combat!.Status); Check.True(E(reopened).Withdrawn);
        Check.Equal(1, reopened.Combat.Log.Count(e => e.Kind == "opportunity_attack"));
        Check.Throws<GameException>(() => engine.Resolve(reopened, "combat.react", "attack"));
        Check.Equal(3, dice.Count); StandardCombatEngine.ValidateState(reopened);
        var pass = JsonSerializer.Deserialize<Campaign>(json, JsonFiles.Options)!;
        engine.Resolve(pass, "combat.react", "pass");
        Check.Equal(3, dice.Count); Check.True(P(pass).ReactionAvailable); Check.Equal(50, E(pass).HitPoints);
        var blinded = Campaign("withdraw"); blinded.Character = blinded.Character.Required() with { Conditions = ["Blinded"] };
        new CombatEngine(new SequenceDice(20, 1)).Resolve(blinded, "combat.start", "");
        new CombatEngine(new SequenceDice()).Resolve(blinded, "combat.end_turn", "");
        Check.True(blinded.Combat!.Standard!.Wait is null && !blinded.Combat.Log.Any(e => e.Kind == "reaction_wait"));
        // Corrupt private continuation cannot execute a second attack or move on read.
        var corrupt = JsonSerializer.Deserialize<Campaign>(json, JsonFiles.Options)!;
        corrupt.StandardCombatFlow!.Steps[0].ActorId = "missing";
        Check.Throws<GameException>(() => StandardCombatEngine.ValidateState(corrupt));
        return Task.CompletedTask;
    }
    public static Task PickUpHonorsHandsAndTraining()
    {
        var c = Campaign(); var engine = new CombatEngine(new SequenceDice(20, 1)); engine.Resolve(c, "combat.start", "");
        c.Character = c.Character.Required() with { Inventory = c.Character.Required().Inventory.Concat([new Item("shield", "Shield", 1, false), new Item("dagger", "Dagger", 1, false)]).ToArray() };
        P(c).Standard!.DroppedItems = [new("shield", 1, 2), new("dagger", 1, 2)];
        Check.True(!Has(c, "combat.pick_up", "shield") && !Has(c, "combat.pick_up", "dagger"));
        string before = JsonSerializer.Serialize(c);
        Check.Throws<GameException>(() => engine.Resolve(c, "combat.pick_up", "shield")); Check.Equal(before, JsonSerializer.Serialize(c));
        c.Character = c.Character with { Inventory = c.Character.Inventory.Select(i => i with { Equipped = false }).ToArray() };
        Check.True(Has(c, "combat.pick_up", "shield") && Has(c, "combat.pick_up", "dagger"));
        engine.Resolve(c, "combat.pick_up", "shield"); P(c).ActionAvailable = true;
        P(c).Standard!.DroppedItems = [new("greatsword", 1, 2), new("dagger", 1, 2)];
        Check.True(!Has(c, "combat.pick_up", "greatsword") && Has(c, "combat.pick_up", "dagger"));
        var wizard = Campaign(); wizard.Character = CharacterEngine.Create("Wizard", CharacterEngine.Wizard);
        wizard.Character = wizard.Character with { Inventory = [new("shield", "Shield", 1, false)] };
        new CombatEngine(new SequenceDice(20, 1)).Resolve(wizard, "combat.start", ""); P(wizard).Standard!.DroppedItems = [new("shield", 1, 2)];
        Check.True(!Has(wizard, "combat.pick_up", "shield"));
        return Task.CompletedTask;
    }
    public static Task LethalDamageDeathAndRecovery()
    {
        var c = Campaign(hp: 1); var dice = new SequenceDice(20, 1, 15, 4, 1, 1); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.end_turn", "");
        Check.Equal(0, c.Character.Required().HitPoints); Check.Equal("death", c.Combat!.Standard!.Wait!.Kind); Check.Equal(4, dice.Count);
        Check.True(c.Character.Conditions.Contains("Unconscious") && c.Character.Conditions.Contains("Prone"));
        Check.True(!c.Character.Inventory.Single(i => i.Id == "greatsword").Equipped);
        Check.Equal("active", c.Combat.Status); StandardCombatEngine.ValidateState(c);
        engine.Resolve(c, "combat.death_save", ""); Check.Equal(2, P(c).Standard!.DeathFailures);
        Check.Equal("death", c.Combat.Standard!.Wait!.Kind); Check.Equal(3, c.Combat.Round); Check.Equal(5, dice.Count);
        engine.Resolve(c, "combat.death_save", ""); Check.Equal("defeated", c.Combat.Status);
        Check.True(P(c).Standard!.Dead && c.Character.Conditions.Contains("Dead"));
        Check.True(!Has(c, "rest.long") && !Has(c, "combat.recover_stable")); StandardCombatEngine.ValidateState(c);
        var massive = Campaign(hp: 1, damageBonus: 20); var killer = new CombatEngine(new SequenceDice(20, 1, 15, 4));
        killer.Resolve(massive, "combat.start", ""); killer.Resolve(massive, "combat.end_turn", "");
        Check.True(P(massive).Standard!.Dead); Check.True(massive.Combat!.Standard!.Wait is null);
        var temp = Campaign(hp: 1, temp: 10); var tempEngine = new CombatEngine(new SequenceDice(20, 1, 15, 4));
        tempEngine.Resolve(temp, "combat.start", ""); tempEngine.Resolve(temp, "combat.end_turn", "");
        Check.Equal(1, temp.Character.Required().HitPoints); Check.Equal(5, temp.Character.Required().TemporaryHitPoints);
        Check.True(temp.Combat!.Standard!.Wait is null); StandardCombatEngine.ValidateState(temp);
        var stable = Campaign(hp: 1); var stableDice = new SequenceDice(20, 1, 15, 4, 10, 10, 10, 2); var stableEngine = new CombatEngine(stableDice);
        stableEngine.Resolve(stable, "combat.start", ""); stableEngine.Resolve(stable, "combat.end_turn", "");
        for (int i = 0; i < 3; i++)
        {
            stableEngine.Resolve(stable, "combat.death_save", "");
            if (i != 2) Check.Equal("death", stable.Combat!.Standard!.Wait!.Kind);
        }
        Check.True(P(stable).Standard!.Stable); Check.Equal(0, P(stable).Standard!.DeathSuccesses); Check.Equal("defeated", stable.Combat!.Status);
        long time = stable.ElapsedSeconds;
        stableEngine.Resolve(stable, "combat.recover_stable", "");
        Check.Equal(time + 7200, stable.ElapsedSeconds); Check.Equal(1, stable.Character.Required().HitPoints);
        Check.True(!stable.Character.Conditions.Contains("Unconscious") && stable.Character.Conditions.Contains("Prone"));
        stableEngine.Resolve(stable, "rest.recover", "");
        Check.True(!stable.Character.Conditions.Contains("Prone") && !stable.Character.Inventory.Single(i => i.Id == "greatsword").Equipped);
        Check.True(!Has(stable, "combat.recover_stable")); StandardCombatEngine.ValidateState(stable);
        var wake = Campaign(hp: 1); var wakeEngine = new CombatEngine(new SequenceDice(20, 1, 15, 4, 20));
        wakeEngine.Resolve(wake, "combat.start", ""); wakeEngine.Resolve(wake, "combat.end_turn", ""); wakeEngine.Resolve(wake, "combat.death_save", "");
        Check.Equal(1, wake.Character.Required().HitPoints); Check.Equal(30, P(wake).MovementRemaining);
        Check.True(Has(wake, "combat.stand") && Has(wake, "combat.pick_up", "greatsword"));
        wakeEngine.Resolve(wake, "combat.stand", ""); wakeEngine.Resolve(wake, "combat.pick_up", "greatsword");
        Check.Equal(15, P(wake).MovementRemaining); Check.True(wake.Character.Inventory.Single(i => i.Id == "greatsword").Equipped);
        Check.True(!P(wake).ActionAvailable); StandardCombatEngine.ValidateState(wake);
        return Task.CompletedTask;
    }
}
