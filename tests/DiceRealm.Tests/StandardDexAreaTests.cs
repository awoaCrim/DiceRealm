using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class StandardDexAreaTests
{
    internal static Character Caster()
    {
        var build = StandardSpellTests.Wizard(false).Build! with { Cantrips = ["acid-splash", "blade-ward", "mage-hand"] };
        return PlayResources.Ensure(BuildEvaluator.Create(build));
    }
    internal static ActionChoice CastAt(Campaign c, int x, int y) => Adventure.Choices(c).First(a => a.Kind == "combat.cast" && a.Label.StartsWith($"Acid Splash / 中心({x},{y})", StringComparison.Ordinal));
    public static Task CoverFromCenterAndBlockedPoint()
    {
        foreach (var (terrain, cover) in new[] { ("half-cover", 2), ("three-quarters-cover", 5) })
        {
            var c = StandardCombatTests.Campaign(); c.Character = Caster();
            c.Adventure = StandardAreaTests.WithEnemies(new ContentEnemy("guardian", "掩护目标", 4, 2, 50, 12, 20, SavingThrows: StandardAreaTests.Saves()));
            c.Adventure = c.Adventure with { Scenes = c.Adventure.Scenes.Select(s => s.Encounter is null ? s : s with { Encounter = s.Encounter with { Cells = [new(4, 1, terrain)] } }).ToArray() };
            int dc = CharacterPlayEngine.SpellSources(c.Character).First(s => s.SpellId == "acid-splash").SaveDc;
            var dice = new SequenceDice(20, 1, 6, dc - cover); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
            var choice = CastAt(c, 3, 1);
            // The page places the sphere from the choice itself: its centre, reach and who it catches.
            Check.True(choice.Area is { X: 3, Y: 1, Radius: 1 } area && area.Targets.SequenceEqual(["guardian"]), JsonSerializer.Serialize(choice.Area));
            engine.Resolve(c, choice.Kind, choice.Target);
            var check = c.Combat!.Log.Single(e => e.Kind == "area_save").Check!;
            Check.Equal(cover, check.Modifier); Check.Equal(dc, check.Total); Check.True(check.Success);
            Check.Equal(50, StandardCombatTests.E(c).HitPoints); Check.Equal(4, dice.Count); StandardCombatEngine.ValidateState(c);
            // Full cover prevents selecting a point behind it, rather than fabricating a save bonus.
            c.Combat.Cells = [new(2, 2, "blocked")]; StandardCombatTests.P(c).ActionAvailable = true;
            Check.True(!Adventure.Choices(c).Any(a => a.Label.StartsWith("Acid Splash / 中心(3,2)", StringComparison.Ordinal)));
            Check.True(!Adventure.Choices(c).Any(a => a.Label.StartsWith("Acid Splash / 中心(2,2)", StringComparison.Ordinal)));
        }
        return Task.CompletedTask;
    }
    public static Task SphereIncludesCasterAndDodgePersistsThroughWait()
    {
        var c = StandardCombatTests.Campaign(); c.Character = Caster();
        c.PartyMembers.Add(new() { Id = "guest", TokenHash = "test-only", Character = Caster() });
        c.Adventure = StandardAreaTests.WithEnemies(new ContentEnemy("guardian", "范围目标", 2, 2, 50, 12, 20, SavingThrows: StandardAreaTests.Saves()));
        var dice = new SequenceDice(20, 19, 1, 6, 1, 20, 1, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        engine.Resolve(c, "combat.dodge", ""); engine.Resolve(c, "combat.end_turn", ""); c.ActingActorId = "guest";
        var cast = CastAt(c, 1, 2); Check.True(cast.Details!.Note.Contains("含中心与施法者"));
        int hp = c.Character.HitPoints; engine.Resolve(c, cast.Kind, cast.Target); Check.Equal(4, dice.Count);
        Check.Equal("player", c.Combat!.Standard!.Wait!.ActorId); Check.Equal(50, StandardCombatTests.E(c).HitPoints);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        StandardCombatEngine.ValidateState(c); c.ActingActorId = "player"; engine.Resolve(c, "combat.area_save", "");
        var check = c.Combat!.Log.Single(e => e.Kind == "area_save").Check!;
        Check.True(check.Success); Check.Equal("advantage", check.Mode); Check.Equal(6, dice.Count); Check.Equal(hp, c.Character.Required().HitPoints);
        Check.Equal("guest", c.Combat.Standard!.Wait!.ActorId); c.ActingActorId = "guest";
        engine.Resolve(c, "combat.area_save", ""); Check.Equal(8, dice.Count); Check.Equal(hp - 6, c.ActingCharacter.HitPoints);
        Check.Equal(44, StandardCombatTests.E(c).HitPoints); Check.Equal(3, c.Combat.Log.Count(e => e.Kind == "area_save"));
        Check.True(c.Combat.Standard.Wait is null); StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task IncapacitatedDexSaveNeverRolls()
    {
        var c = StandardCombatTests.Campaign(); c.Character = Caster();
        c.Adventure = StandardAreaTests.WithEnemies(new ContentEnemy("guardian", "范围目标", 2, 2, 50, 12, 20, SavingThrows: StandardAreaTests.Saves()));
        var dice = new SequenceDice(20, 1, 6, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        var cast = CastAt(c, 1, 2); engine.Resolve(c, cast.Kind, cast.Target);
        // Authoritative recorded condition before the required own save: no automatic-success by cover or Dodge.
        c.Character = c.Character with { Conditions = ["Stunned"] }; StandardCombatTests.P(c).Standard!.Conditions = ["Stunned"];
        StandardCombatTests.P(c).Dodging = true; engine.Resolve(c, "combat.area_save", "");
        var own = c.Combat!.Log.First(e => e.Kind == "area_save").Check!;
        Check.Equal("automatic-failure", own.Mode); Check.Equal(0, own.Rolls.Length); Check.True(!own.Success); Check.Equal(4, dice.Count);
        StandardCombatEngine.ValidateState(c); return Task.CompletedTask;
    }
}
