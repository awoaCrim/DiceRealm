using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class StandardMissileTests
{
    private static void Begin(CombatEngine e, Campaign c)
    {
        var a = StandardSpellTests.Spell(c, "Magic Missile");
        Check.True(StandardCombatEngine.RollDescription(c, new(a.Kind, a.Target)) is null);
        e.Resolve(c, a.Kind, a.Target);
    }
    public static Task AllocationCancellationAndExactDarts()
    {
        var c = StandardSpellTests.Fixture(false); var dice = new SequenceDice(20, 1, 1, 2, 3); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", "");
        Check.True(!ActionUnderstanding.Candidates(c, includeStandardExpansion: false).Any(a => a.Label.StartsWith("Magic Missile", StringComparison.Ordinal)));
        Begin(engine, c);
        Check.Equal("missile-allocation", c.Combat!.Standard!.Wait!.Kind); Check.Equal(2, dice.Count);
        Check.Equal(2, CharacterEngine.Value(c.Character.Required(), "Spell Slots (1st)")); Check.True(StandardCombatTests.P(c).ActionAvailable);
        engine.Resolve(c, "combat.missile_allocate", "all/guardian"); engine.Resolve(c, "combat.missile_allocate", "undo");
        Check.True(!Adventure.Choices(c).Any(a => a.Kind == "combat.missile_cast"));
        engine.Resolve(c, "combat.missile_allocate", "cancel"); Check.Equal(2, dice.Count); Check.True(c.Combat.Standard.Wait is null);
        Begin(engine, c); engine.Resolve(c, "combat.missile_allocate", "all/guardian");
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!; StandardCombatEngine.ValidateState(c);
        Check.True(StandardCombatEngine.RollDescription(c, new("combat.missile_cast", "")) is not null);
        engine.Resolve(c, "combat.missile_cast", ""); Check.Equal(5, dice.Count); Check.Equal(41, StandardCombatTests.E(c).HitPoints);
        Check.Equal(1, CharacterEngine.Value(c.Character.Required(), "Spell Slots (1st)")); Check.True(!StandardCombatTests.P(c).ActionAvailable);
        Check.Equal(3, c.Combat!.Log.Count(e => e.Kind == "missile_damage")); Check.Equal(1, c.Combat.Log.Count(e => e.Kind == "combat.cast"));
        Check.True(c.Combat.Standard!.Wait is null); StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task AllShieldDecisionsPrecedeEveryDamage()
    {
        var c = StandardSpellTests.Fixture(false);
        c.PartyMembers.Add(new() { Id = "guest", TokenHash = "test-only", Character = StandardSpellTests.Wizard() });
        c.PartyMembers.Add(new() { Id = "third", TokenHash = "test-only", Character = StandardSpellTests.Wizard() with { Concentration = new("blade-ward", "class:wizard", 60) } });
        int hp = c.PartyMembers[0].Character.HitPoints;
        var dice = new SequenceDice(20, 19, 18, 1, 2, 3, 10); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", ""); Begin(engine, c);
        foreach (string id in new[] { "guest", "third", "guardian" }) engine.Resolve(c, "combat.missile_allocate", "one/" + id);
        engine.Resolve(c, "combat.missile_cast", ""); Check.Equal(4, dice.Count); Check.Equal("guest", c.Combat!.Standard!.Wait!.ActorId);
        Check.Equal(50, StandardCombatTests.E(c).HitPoints); Check.Equal(1, CharacterEngine.Value(c.Character.Required(), "Spell Slots (1st)"));
        Check.Throws<GameException>(() => engine.Resolve(c, "combat.react", "pass"));
        c.ActingActorId = "guest"; var shield = StandardSpellTests.Spell(c, "Shield", "combat.react"); engine.Resolve(c, shield.Kind, shield.Target);
        Check.Equal(4, dice.Count); Check.Equal("third", c.Combat.Standard.Wait!.ActorId); Check.Equal(hp, c.ActingCharacter.HitPoints);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!; StandardCombatEngine.ValidateState(c);
        c.ActingActorId = "third"; engine.Resolve(c, "combat.react", "pass");
        Check.Equal(6, dice.Count); Check.Equal(hp - 3, c.ActingCharacter.HitPoints); Check.Equal(46, StandardCombatTests.E(c).HitPoints);
        Check.Equal(hp, PartyEngine.CharacterFor(c, "guest").HitPoints); Check.Equal("concentration", c.Combat!.Standard!.Wait!.Kind);
        Check.Equal(1, c.Combat.Log.Count(e => e.Kind == "missile_blocked")); StandardCombatEngine.ValidateState(c);
        engine.Resolve(c, "combat.concentration_save", ""); Check.Equal(7, dice.Count); Check.True(c.Combat.Standard.Wait is null);
        Check.True(c.ActingCharacter.Concentration is not null); StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task SimultaneousDamageAndConcentrationTail()
    {
        foreach (bool lethal in new[] { false, true })
        {
            var c = StandardSpellTests.Fixture(false); var guest = StandardSpellTests.Wizard(false) with { Concentration = new("expeditious-retreat", "class:wizard", 60) };
            if (lethal) guest = guest with { HitPoints = 1 };
            c.PartyMembers.Add(new() { Id = "guest", TokenHash = "test-only", Character = guest });
            var dice = new SequenceDice(20, 19, 1, 1, 1, 1, 10, 1); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
            Begin(engine, c); engine.Resolve(c, "combat.missile_allocate", "all/guest"); engine.Resolve(c, "combat.missile_cast", "");
            Check.Equal(6, dice.Count); Check.Equal(Math.Max(0, guest.HitPoints - 6), PartyEngine.CharacterFor(c, "guest").HitPoints);
            if (lethal)
            {
                Check.True(c.Combat!.Standard!.Wait is null); Check.True(PartyEngine.CharacterFor(c, "guest").Concentration is null);
                Check.Equal(2, c.Combat.Units.Single(u => u.Id == "guest").Standard!.DeathFailures); Check.Equal(0, c.StandardCombatFlow!.Steps.Count);
            }
            else
            {
                Check.Equal("concentration", c.Combat!.Standard!.Wait!.Kind); Check.Equal(3, c.StandardCombatFlow!.Steps.Count);
                c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
                StandardCombatEngine.ValidateState(c); c.ActingActorId = "guest";
                engine.Resolve(c, "combat.concentration_save", ""); Check.Equal(7, dice.Count); Check.Equal("concentration", c.Combat!.Standard!.Wait!.Kind);
                engine.Resolve(c, "combat.concentration_save", ""); Check.Equal(8, dice.Count); Check.True(c.Combat.Standard.Wait is null && c.ActingCharacter.Concentration is null);
                Check.Equal(2, c.Combat.Log.Count(e => e.Kind == "concentration_save"));
            }
            StandardCombatEngine.ValidateState(c);
        }
        return Task.CompletedTask;
    }
}
