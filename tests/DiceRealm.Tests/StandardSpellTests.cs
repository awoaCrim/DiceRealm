using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class StandardSpellTests
{
    internal static Character Wizard(bool shield = true)
    {
        var build = FullCreationTests.Complete("wizard", "dwarf", "sage");
        var prepared = new[] { "expeditious-retreat", shield ? "shield" : "magic-missile", "mage-armor", "sleep" };
        build = build with { Cantrips = ["blade-ward", "fire-bolt", "mage-hand"], PreparedSpells = prepared,
            Spellbook = prepared.Concat(["shield", "magic-missile", "detect-magic", "find-familiar"]).Distinct().Take(6).ToArray() };
        return PlayResources.Ensure(BuildEvaluator.Create(build));
    }
    internal static Campaign Fixture(bool shield = true)
    {
        var c = StandardCombatTests.Campaign(); c.Character = Wizard(shield); CharacterEngine.Sync(c); return c;
    }
    internal static ActionChoice Spell(Campaign c, string name, string kind = "combat.cast") =>
        Adventure.Choices(c).First(a => a.Kind == kind && a.Label.StartsWith(name + " /", StringComparison.Ordinal));
    private static void Cast(CombatEngine e, Campaign c, string name) { var choice = Spell(c, name); e.Resolve(c, choice.Kind, choice.Target); }
    public static Task ShieldPausesDamageAndExpires()
    {
        var c = Fixture(); var dice = new SequenceDice(20, 1, 11, 1); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); int hp = c.Character.Required().HitPoints, armor = c.Character.Required().ArmorClass;
        engine.Resolve(c, "combat.move", "0,2");
        Check.Equal("shield", c.Combat!.Standard!.Wait!.Kind); Check.Equal(3, dice.Count);
        Check.Equal(1, StandardCombatTests.P(c).X); Check.Equal(hp, c.Character.HitPoints); Check.Equal(2, CharacterEngine.Value(c.Character, "Spell Slots (1st)"));
        StandardCombatEngine.ValidateState(c);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        StandardCombatEngine.ValidateState(c); var reaction = Spell(c, "Shield", "combat.react"); engine.Resolve(c, reaction.Kind, reaction.Target);
        Check.Equal(0, StandardCombatTests.P(c).X); Check.Equal(hp, c.Character.Required().HitPoints); Check.Equal(3, dice.Count);
        Check.True(StandardCombatTests.P(c).Standard!.ShieldActive && !StandardCombatTests.P(c).ReactionAvailable);
        Check.Equal(1, CharacterEngine.Value(c.Character, "Spell Slots (1st)"));
        Check.True(!Adventure.Choices(c).Any(a => a.Kind == "combat.cast" && a.Label.StartsWith("Expeditious Retreat", StringComparison.Ordinal)));
        Check.True(Adventure.Choices(c).Any(a => a.Kind == "combat.cast" && a.Label.StartsWith("Blade Ward", StringComparison.Ordinal)));
        var attack = c.Combat!.Log.Single(e => e.Kind == "opportunity_attack").Attack!;
        Check.True(!attack.Hit); Check.Equal(armor + 5, attack.ArmorClass); Check.Equal(0, attack.DamageRolls.Length);
        engine.Resolve(c, "combat.end_turn", ""); Check.True(!StandardCombatTests.P(c).Standard!.ShieldActive);
        Check.Equal(4, dice.Count); StandardCombatEngine.ValidateState(c);
        // Natural 20 cannot be prevented by +5 AC; Shield is still an explicitly legal reaction.
        c = Fixture(); dice = new(20, 1, 20, 1, 1); engine = new(dice); engine.Resolve(c, "combat.start", "");
        engine.Resolve(c, "combat.move", "0,2"); Check.Equal(3, dice.Count);
        reaction = Spell(c, "Shield", "combat.react"); engine.Resolve(c, reaction.Kind, reaction.Target);
        Check.Equal(5, dice.Count); Check.True(c.Combat!.Log.Single(e => e.Kind == "opportunity_attack").Attack!.Critical);
        return Task.CompletedTask;
    }
    public static Task ConcentrationWaitOwnSaveReplacementAndDuration()
    {
        var c = Fixture(); var dice = new SequenceDice(20, 1, 11, 2, 10); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); Cast(engine, c, "Expeditious Retreat");
        Check.Equal(60, StandardCombatTests.P(c).MovementRemaining); Check.Equal(2, dice.Count);
        Check.Equal("expeditious-retreat", c.Character.Required().Concentration!.SpellId);
        engine.Resolve(c, "combat.move", "0,2");
        // Already spent a slot this own turn: no second-slot Shield, but damage requires a save.
        Check.Equal("concentration", c.Combat!.Standard!.Wait!.Kind); Check.Equal(4, dice.Count);
        Check.Equal(1, StandardCombatTests.P(c).X); Check.Equal(1, CharacterEngine.Value(c.Character, "Spell Slots (1st)"));
        StandardCombatEngine.ValidateState(c);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        StandardCombatEngine.ValidateState(c);
        engine.Resolve(c, "combat.concentration_save", ""); Check.Equal(5, dice.Count); Check.Equal(0, StandardCombatTests.P(c).X);
        Check.Equal("expeditious-retreat", c.Character.Required().Concentration!.SpellId);
        Cast(engine, c, "Blade Ward"); Check.Equal("blade-ward", c.Character.Concentration!.SpellId);
        Check.Equal(5, dice.Count); Check.Equal(1, CharacterEngine.Value(c.Character, "Spell Slots (1st)"));
        CharacterEngine.Advance(c, 59); Check.True(c.Character.Concentration is not null);
        CharacterEngine.Advance(c, 1); Check.True(c.Character.Concentration is null); StandardCombatEngine.ValidateState(c);
        // Explicit ending instead of a saving throw continues the exact movement without rolling.
        c = Fixture(); dice = new(20, 1, 11, 2); engine = new(dice); engine.Resolve(c, "combat.start", ""); Cast(engine, c, "Expeditious Retreat");
        engine.Resolve(c, "combat.move", "0,2"); engine.Resolve(c, "combat.concentration_end", "");
        Check.Equal(4, dice.Count); Check.True(c.Character.Required().Concentration is null); Check.Equal(0, StandardCombatTests.P(c).X);
        StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task WardFailureIncapacitationAndClosedEncounter()
    {
        var c = Fixture(false); var dice = new SequenceDice(20, 1, 15, 4, 1, 1); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); Cast(engine, c, "Blade Ward"); engine.Resolve(c, "combat.move", "0,2");
        Check.Equal("concentration", c.Combat!.Standard!.Wait!.Kind); Check.Equal(5, dice.Count);
        Check.Equal(14, c.Combat.Log.Single(e => e.Kind == "opportunity_attack").Attack!.Total);
        Check.True(c.Combat.Log.Any(e => e.Kind == "blade_ward"));
        engine.Resolve(c, "combat.concentration_save", ""); Check.True(c.Character.Required().Concentration is null); Check.Equal(6, dice.Count);
        c = Fixture(false); c.Character = c.Character.Required() with { HitPoints = 1 }; dice = new(20, 1, 15, 1, 1); engine = new(dice);
        engine.Resolve(c, "combat.start", ""); Cast(engine, c, "Blade Ward"); engine.Resolve(c, "combat.move", "0,2");
        Check.True(c.Character.Concentration is null && c.Character.HitPoints == 0); Check.Equal(5, dice.Count);
        Check.True(c.Combat!.Standard!.Wait is null); Check.Equal(1, StandardCombatTests.P(c).X); StandardCombatEngine.ValidateState(c);
        c = Fixture(false); c.Adventure = StandardCombatTests.Document("withdraw"); dice = new(20, 1); engine = new(dice);
        engine.Resolve(c, "combat.start", ""); Cast(engine, c, "Blade Ward"); engine.Resolve(c, "combat.end_turn", "");
        Check.Equal("victory", c.Combat!.Status); Check.True(c.Character.Required().Concentration is not null);
        engine.Resolve(c, "combat.concentration_end", ""); Check.True(c.Character.Concentration is null); Check.Equal(2, dice.Count);
        StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task HealingSourcesAndActionEconomy()
    {
        var c = StandardCombatTests.Campaign(); var build = FullCreationTests.Complete("cleric", "dwarf", "sage");
        build = build with { PreparedSpells = new[] { "cure-wounds", "healing-word" }.Concat(build.PreparedSpells).Distinct().Take(build.PreparedSpells.Length).ToArray() };
        c.Character = PlayResources.Ensure(BuildEvaluator.Create(build)) with { HitPoints = 1 };
        var dice = new SequenceDice(20, 1, 2, 3); var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", "");
        int bonus = CharacterEngine.Ability(c.Character, "wisdom"); var word = Spell(c, "Healing Word"); engine.Resolve(c, word.Kind, word.Target);
        Check.Equal(1 + 5 + bonus, c.Character.HitPoints); Check.Equal(4, dice.Count);
        Check.True(StandardCombatTests.P(c).ActionAvailable && !StandardCombatTests.P(c).BonusActionAvailable);
        Check.True(!Adventure.Choices(c).Any(a => a.Kind == "combat.cast" && a.Label.StartsWith("Cure Wounds", StringComparison.Ordinal)));
        Check.Equal(1, CharacterEngine.Value(c.Character, "Spell Slots (1st)")); StandardCombatEngine.ValidateState(c);
        // A single one-handed weapon leaves one hand available for S; this does not waive M.
        c = Fixture(); c.Character = c.Character.Required() with { Inventory = c.Character.Required().Inventory.Select(i => i with { Equipped = i.Id == "dagger" }).ToArray() };
        new CombatEngine(new SequenceDice(20, 1)).Resolve(c, "combat.start", "");
        Check.True(Adventure.Choices(c).Any(a => a.Kind == "combat.cast"));
        return Task.CompletedTask;
    }
}
