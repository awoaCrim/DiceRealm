using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class StandardMasteryTests
{
    internal static CharacterBuild Build(string weapon)
    {
        var b = FullCreationTests.Complete("fighter", "dwarf", "sage");
        return b with { Selections = b.Selections.Where(s => s.Key is not ("class:fighter/masteries" or "class:fighter/style"))
            .Concat([new BuildSelection("class:fighter/masteries", new[] { weapon, "club", "rapier", "maul" }.Distinct().Take(3).ToArray()), new("class:fighter/style", ["defense"])]).ToArray() };
    }
    private static Campaign Fixture(string weapon, bool saves = true)
    {
        var c = StandardCombatTests.Campaign(); var ch = PlayResources.Ensure(BuildEvaluator.Create(Build(weapon)));
        // This fixture replaces the build's acquired equipment; configure the matching runtime hands too.
        c.Character = EquipmentLoadout.Commit(ch with { Inventory = [new(weapon, weapon, 1, true), new("chain-mail", "Chain Mail", 1, true)] },
            new CharacterLoadout(MeleeMainHandId: weapon));
        c.Adventure = StandardAreaTests.WithEnemies(new ContentEnemy("guardian", "精通目标", 2, 2, 100, 10, 20, SavingThrows: saves ? StandardAreaTests.Saves() : null));
        CharacterEngine.Sync(c); return c;
    }
    public static Task SapAndVexConsumptionAndExpiry()
    {
        var c = Fixture("flail"); var dice = new SequenceDice(20, 1, 10, 1, 19, 1); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.attack", "guardian");
        Check.Equal("sap", StandardCombatTests.E(c).Standard!.MasteryEffects.Single().Kind);
        engine.Resolve(c, "combat.end_turn", "");
        var incoming = c.Combat!.Log.Last(e => e.Kind == "attack").Attack!;
        Check.Equal("disadvantage", incoming.Mode); Check.True(!incoming.Hit); Check.Equal(6, dice.Count);
        Check.Equal(0, StandardCombatTests.E(c).Standard!.MasteryEffects.Length); StandardCombatEngine.ValidateState(c);
        c = Fixture("rapier"); dice = new(20, 1, 10, 2, 1, 2, 1, 10, 2, 1, 1); engine = new(dice);
        engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.attack", "guardian");
        Check.Equal(2, StandardCombatTests.E(c).Standard!.MasteryEffects.Single().TurnEndsRemaining);
        // A miss consumes Vex too; the second attack must not keep advantage indefinitely.
        StandardCombatTests.P(c).ActionAvailable = true; engine.Resolve(c, "combat.attack", "guardian");
        Check.Equal("advantage", c.Combat!.Log.Last(e => e.Kind == "attack").Attack!.Mode);
        Check.Equal(0, StandardCombatTests.E(c).Standard!.MasteryEffects.Length);
        engine.Resolve(c, "combat.end_turn", ""); engine.Resolve(c, "combat.attack", "guardian");
        engine.Resolve(c, "combat.end_turn", "");
        Check.Equal(1, StandardCombatTests.E(c).Standard!.MasteryEffects.Single().TurnEndsRemaining);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        StandardCombatEngine.ValidateState(c); engine.Resolve(c, "combat.end_turn", "");
        Check.Equal(0, StandardCombatTests.E(c).Standard!.MasteryEffects.Length); Check.Equal(11, dice.Count);
        StandardCombatEngine.ValidateState(c); return Task.CompletedTask;
    }
    public static Task OptionalSlowAndToppleHaveExactSources()
    {
        var c = Fixture("club"); var dice = new SequenceDice(20, 1, 10, 1, 10, 1, 10, 1, 1); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.attack", "guardian");
        Check.Equal(0, StandardCombatTests.E(c).Standard!.MasteryEffects.Length);
        StandardCombatTests.P(c).ActionAvailable = true; engine.Resolve(c, "combat.attack", "mastery/guardian");
        Check.Equal("slow", StandardCombatTests.E(c).Standard!.MasteryEffects.Single().Kind);
        StandardCombatTests.P(c).ActionAvailable = true; engine.Resolve(c, "combat.attack", "mastery/guardian");
        Check.Equal(1, StandardCombatTests.E(c).Standard!.MasteryEffects.Length);
        engine.Resolve(c, "combat.end_turn", ""); Check.Equal(10, StandardCombatTests.E(c).MovementRemaining);
        Check.Equal(0, StandardCombatTests.E(c).Standard!.MasteryEffects.Length); Check.Equal(9, dice.Count);
        StandardCombatEngine.ValidateState(c);
        c = Fixture("maul", false); engine = new(new SequenceDice(20, 1)); engine.Resolve(c, "combat.start", "");
        Check.True(!Adventure.Choices(c).Any(a => a.Target == "mastery/guardian"));
        string before = JsonSerializer.Serialize(c); Check.Throws<GameException>(() => engine.Resolve(c, "combat.attack", "mastery/guardian"));
        Check.Equal(before, JsonSerializer.Serialize(c));
        c = Fixture("maul"); dice = new(20, 1, 10, 1, 1, 1, 1); engine = new(dice);
        engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.attack", "mastery/guardian");
        Check.True(StandardCombatTests.E(c).Standard!.Conditions.Contains("Prone"));
        var save = c.Combat!.Log.Single(e => e.Kind == "mastery_topple").Check!;
        Check.Equal(8 + CharacterEngine.Ability(c.Character.Required(), "strength") + c.Character.Required().ProficiencyBonus, save.Dc); Check.Equal(6, dice.Count);
        engine.Resolve(c, "combat.end_turn", ""); Check.True(!StandardCombatTests.E(c).Standard!.Conditions.Contains("Prone"));
        Check.Equal(10, StandardCombatTests.E(c).MovementRemaining); Check.Equal(7, dice.Count); StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task SlowAdjustsAlreadyGrantedDash()
    {
        var c = Fixture("club"); c.Adventure = StandardAreaTests.WithEnemies(new ContentEnemy("guardian", "疾走撤离目标", 3, 2, 100, 10, 10, Tactic: "withdraw"));
        var dice = new SequenceDice(20, 1, 10, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        StandardCombatTests.P(c).X = 2; engine.Resolve(c, "combat.end_turn", "");
        Check.Equal("opportunity", c.Combat!.Standard!.Wait!.Kind); Check.Equal(1, StandardCombatTests.E(c).Standard!.DashesThisTurn);
        var position = (StandardCombatTests.E(c).X, StandardCombatTests.E(c).Y); Check.Equal(15, StandardCombatTests.E(c).MovementRemaining);
        engine.Resolve(c, "combat.react", "attack/mastery");
        Check.Equal(position, (StandardCombatTests.E(c).X, StandardCombatTests.E(c).Y)); Check.Equal(0, StandardCombatTests.E(c).MovementRemaining);
        Check.True(!StandardCombatTests.E(c).Withdrawn); Check.Equal(4, dice.Count); StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task OptionalOpportunityAndCorruptEffects()
    {
        var c = Fixture("club"); c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s.Encounter is null ? s : s with {
            Encounter = s.Encounter with { Enemies = s.Encounter.Enemies.Select(e => e with { Tactic = "withdraw" }).ToArray() } }).ToArray() };
        var dice = new SequenceDice(20, 1, 10, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        engine.Resolve(c, "combat.end_turn", ""); Check.True(Adventure.Choices(c).Any(a => a.Kind == "combat.react" && a.Target == "attack/mastery"));
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        StandardCombatEngine.ValidateState(c); engine.Resolve(c, "combat.react", "attack/mastery"); Check.Equal(4, dice.Count);
        Check.Equal(1, c.Combat!.Log.Count(e => e.Kind == "opportunity_attack")); Check.Equal(1, c.Combat.Log.Count(e => e.Kind == "mastery_slow"));
        StandardCombatEngine.ValidateState(c);
        StandardCombatTests.E(c).Standard!.MasteryEffects = [new("vex", "missing", 1)];
        Check.Throws<GameException>(() => StandardCombatEngine.ValidateState(c)); return Task.CompletedTask;
    }
}
