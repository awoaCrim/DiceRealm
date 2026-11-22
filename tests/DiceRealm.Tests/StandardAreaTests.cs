using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class StandardAreaTests
{
    internal static Dictionary<string, int> Saves(int value = 0) => new[] { "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma" }.ToDictionary(x => x, _ => value);
    internal static AdventureDocument WithEnemies(params ContentEnemy[] enemies) => StandardCombatTests.Document() with
    { Scenes = StandardCombatTests.Document().Scenes.Select(s => s.Id == "causeway" ? s with { Encounter = s.Encounter! with { Enemies = enemies } } : s).ToArray() };
    internal static Character ThunderCaster()
    {
        var build = StandardSpellTests.Wizard(false).Build! with { Cantrips = ["thunderclap", "blade-ward", "mage-hand"] };
        return PlayResources.Ensure(BuildEvaluator.Create(build));
    }
    public static Task FriendlyAreaWaitsThroughConcentration()
    {
        var c = StandardCombatTests.Campaign(); c.Character = ThunderCaster();
        var friend = StandardSpellTests.Wizard(false) with { Concentration = new("blade-ward", "class:wizard", 60) };
        c.PartyMembers.Add(new() { Id = "guest", TokenHash = "test-only", Character = friend });
        c.Adventure = WithEnemies(new ContentEnemy("guardian", "可明确豁免的夹具", 2, 2, 50, 12, 20, SavingThrows: Saves(-5)));
        ContentValidator.Validate(c.Adventure);
        var dice = new SequenceDice(20, 19, 1, 6, 1, 10, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        var cast = StandardSpellTests.Spell(c, "Thunderclap"); Check.True(cast.Details!.Note.Contains("（同伴）") && cast.Details.Note.Contains("声响100尺"));
        var me = StandardCombatTests.P(c);
        Check.True(cast.Area is { Radius: 1 } reach && reach.X == me.X && reach.Y == me.Y && reach.Targets.Order().SequenceEqual(["guardian", "guest"]), JsonSerializer.Serialize(cast.Area));
        int ownHp = c.Character.HitPoints; engine.Resolve(c, cast.Kind, cast.Target);
        Check.Equal(4, dice.Count); Check.Equal("area-save", c.Combat!.Standard!.Wait!.Kind); Check.Equal("guest", c.Combat.Standard.Wait.ActorId);
        Check.True(c.Combat.Standard.Wait.Description.StartsWith("Thunderclap影响此角色；等待本人确认DC", StringComparison.Ordinal) &&
            c.Combat.Standard.Wait.Description.Contains(" Constitution豁免"), c.Combat.Standard.Wait.Description);
        Check.Equal(50, StandardCombatTests.E(c).HitPoints); Check.Equal(ownHp, c.Character.HitPoints); StandardCombatEngine.ValidateState(c);
        Check.Throws<GameException>(() => engine.Resolve(c, "combat.area_save", "")); Check.Equal(4, dice.Count);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!; c.ActingActorId = "guest";
        engine.Resolve(c, "combat.area_save", ""); Check.Equal("concentration", c.Combat!.Standard!.Wait!.Kind); Check.Equal(5, dice.Count);
        Check.Equal(friend.HitPoints - 6, c.ActingCharacter.HitPoints); Check.Equal(50, StandardCombatTests.E(c).HitPoints); StandardCombatEngine.ValidateState(c);
        engine.Resolve(c, "combat.concentration_save", ""); Check.Equal(7, dice.Count);
        Check.Equal(44, StandardCombatTests.E(c).HitPoints); Check.True(c.Combat.Standard.Wait is null && c.ActingCharacter.Concentration is not null);
        Check.Equal("player", c.Combat.ActiveActorId); Check.Equal(2, c.Combat.Log.Count(e => e.Kind == "area_save"));
        Check.Equal(1, c.Combat.Log.Count(e => e.Kind == "combat.cast")); StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task HadarTargetsHalfDamageAndReactionSuppression()
    {
        var c = StandardCombatTests.Campaign(); var build = FullCreationTests.Complete("warlock", "dwarf", "sage");
        build = build with { PreparedSpells = new[] { "arms-of-hadar" }.Concat(build.PreparedSpells).Distinct().Take(build.PreparedSpells.Length).ToArray() };
        c.Character = PlayResources.Ensure(BuildEvaluator.Create(build));
        c.Adventure = WithEnemies(new ContentEnemy("guardian", "失败目标", 2, 2, 50, 12, 20, SavingThrows: Saves()), new("other", "成功目标", 3, 2, 50, 12, 20, SavingThrows: Saves()));
        var dice = new SequenceDice(20, 1, 2, 3, 4, 1, 20, 1, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        var cast = StandardSpellTests.Spell(c, "Arms of Hadar"); engine.Resolve(c, cast.Kind, cast.Target);
        Check.Equal(7, dice.Count); Check.Equal(43, StandardCombatTests.E(c).HitPoints);
        Check.Equal(47, c.Combat!.Units.Single(u => u.Id == "other").HitPoints);
        Check.True(StandardCombatTests.E(c).Standard!.ReactionsSuppressed); Check.True(!c.Combat.Units.Single(u => u.Id == "other").Standard!.ReactionsSuppressed);
        engine.Resolve(c, "combat.move", "0,2"); Check.Equal(7, dice.Count); // suppressed guardian cannot make its opportunity attack
        engine.Resolve(c, "combat.end_turn", ""); Check.True(!StandardCombatTests.E(c).Standard!.ReactionsSuppressed); StandardCombatEngine.ValidateState(c);
        // An authored opponent without explicit save data is not assigned a fabricated +0.
        c = StandardCombatTests.Campaign(); c.Character = ThunderCaster(); new CombatEngine(new SequenceDice(20, 1)).Resolve(c, "combat.start", "");
        Check.True(!Adventure.Choices(c).Any(a => a.Label.StartsWith("Thunderclap", StringComparison.Ordinal)));
        var invalid = WithEnemies(new ContentEnemy("guardian", "残缺豁免", 2, 2, 50, 12, 20, SavingThrows: new() { ["constitution"] = 1 }));
        Check.Throws<GameException>(() => ContentValidator.Validate(invalid));
        return Task.CompletedTask;
    }
    public static Task ExactXmmFortitudeCriticalAndVulnerability()
    {
        ContentEnemy Monster(string rules) => rules == "xmm:zombie" ? new("guardian", "Zombie", 2, 2, 15, 8, 20, -2, 3, 1, 8, 1, RulesId: rules)
            : new("guardian", "Skeleton", 2, 2, 13, 14, 30, 3, 5, 1, 6, 3, RulesId: rules);
        var c = StandardCombatTests.Campaign(); c.Adventure = WithEnemies(Monster("xmm:zombie")); ContentValidator.Validate(c.Adventure);
        Check.Throws<GameException>(() => ContentValidator.Validate(WithEnemies(Monster("xmm:zombie") with { HitPoints = 16 })));
        Check.Throws<GameException>(() => ContentValidator.Validate(WithEnemies(Monster("xmm:zombie") with { RulesId = "xmm:guess" })));
        var dice = new SequenceDice(20, 1, 10, 3, 3, 3, 3, 11, 20, 3, 3, 3, 3); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        StandardCombatTests.E(c).HitPoints = 5; engine.Resolve(c, "combat.attack", "guardian");
        Check.Equal(8, dice.Count); Check.Equal(1, StandardCombatTests.E(c).HitPoints); Check.True(!StandardCombatTests.E(c).Standard!.Dead);
        var save = c.Combat!.Log.Single(e => e.Kind == "undead_fortitude").Check!; Check.Equal(14, save.Dc); Check.True(save.Success && save.Source == "XMM");
        StandardCombatTests.P(c).ActionAvailable = true; engine.Resolve(c, "combat.attack", "guardian");
        Check.Equal(13, dice.Count); Check.True(StandardCombatTests.E(c).Standard!.Dead); Check.Equal(1, c.Combat.Log.Count(e => e.Kind == "undead_fortitude"));
        StandardCombatEngine.ValidateState(c);
        c = StandardCombatTests.Campaign(); c.Adventure = WithEnemies(Monster("xmm:skeleton"));
        c.Character = c.Character.Required() with { Inventory = [new("maul", "Maul", 1, true)] };
        dice = new(20, 1, 10, 3, 3, 3, 3); engine = new(dice); engine.Resolve(c, "combat.start", ""); engine.Resolve(c, "combat.attack", "guardian");
        Check.True(StandardCombatTests.E(c).Standard!.Dead); Check.Equal(9, c.Combat!.Log.Single(e => e.Kind == "attack").Attack!.Damage);
        Check.True(c.Combat.Log.Single(e => e.Kind == "damage").Text.Contains("18点Bludgeoning")); Check.Equal(7, dice.Count);
        StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
}
