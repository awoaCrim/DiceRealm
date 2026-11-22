using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementRestTests
{
    public static Task RetainedSourceChoices()
    {
        var druid = BuildEvaluator.Create(FullCreationTests.Complete("druid", "human", "sage"));
        druid = AdvancementTests.Level(AdvancementTests.Level(druid), subclass: "druid:land");
        const string key = "subclass:druid:land:list";
        var source = druid.Advancement!.Classes.Single();
        Check.Equal("0", source.Choices!.Single(c => c.Key == key).Values.Single());
        Check.True(source.BonusSpells!.Any(s => s.Id == "burning-hands"));
        string before = JsonSerializer.Serialize(druid);
        var valid = AdvancementTests.Complete(druid);
        var changed = valid with { Selections = [..valid.Selections.Where(s => s.Key != key), new(key, ["1"])] };
        var refused = AdvancementEngine.Evaluate(druid, changed, 20);
        Check.True(!refused.CanApply && refused.Issues.Any(i => i.Code == "retained_source_choice"));
        Check.Equal(before, JsonSerializer.Serialize(druid));
        druid = AdvancementEngine.Evaluate(druid, valid, 20).Character!;
        druid = AdvancementTests.Level(druid);
        var spells = druid.Advancement!.Classes.Single().BonusSpells!;
        Check.True(spells.Any(s => s.Id == "fireball") && !spells.Any(s => s.Id == "sleet-storm"), "Level gain must retain one coherent land list");
        return Task.CompletedTask;
    }

    public static Task MultiClassDiceAndArcaneRecovery()
    {
        var wizard = BuildEvaluator.Create(FullCreationTests.Complete("wizard", "human", "sage"));
        wizard = wizard with { Abilities = wizard.Abilities.Select(a => a with { Score = 16, Modifier = 3 }).ToArray() };
        for (int level = 2; level <= 5; level++) wizard = AdvancementTests.Level(wizard, subclass: level == 3 ? "wizard:evoker" : "");
        var mixed = AdvancementTests.Level(wizard, "fighter");
        mixed = AdvancementTests.Level(mixed, "fighter");
        var campaign = TestContent.Campaign("harbor", "Advanced rest"); campaign.Character = mixed with { HitPoints = 1 };
        var dice = new SequenceDice(1, 2); var engine = new CharacterEngine(dice);
        string before = JsonSerializer.Serialize(campaign.Character);
        var choices = CharacterEngine.Choices(campaign);
        Check.True(choices.Any(c => c.Kind == "rest.short" && c.Target == "hit_die:d10"));
        Check.Equal(before, JsonSerializer.Serialize(campaign.Character)); Check.Equal(0, dice.Count);
        engine.Resolve(campaign, "rest.short", "hit_die:d10");
        Check.Equal(5, campaign.Character.HitPoints); Check.Equal(1, CharacterEngine.Value(campaign.Character, "Hit Dice (d10)"));
        Check.Equal(5, CharacterEngine.Value(campaign.Character, "Hit Dice (d6)")); Check.Equal(60, campaign.ElapsedMinutes);
        engine.Resolve(campaign, "rest.hit_die", "");
        Check.Equal(10, campaign.Character.HitPoints); Check.Equal(4, CharacterEngine.Value(campaign.Character, "Hit Dice (d6)"));
        Check.Equal(60, campaign.ElapsedMinutes); Check.Equal(2, dice.Count);
        Check.Throws<GameException>(() => engine.Resolve(campaign, "rest.hit_die", "d12")); Check.Equal(2, dice.Count);

        campaign.Character = campaign.Character with { Resources = campaign.Character.Resources.Select(r => r.Name.StartsWith("Spell Slots (", StringComparison.Ordinal) ? r with { Current = 0 } : r).Append(new("Pact Slots (3rd)", 0, 2, "short")).ToArray() };
        var allocations = AdvancementRest.ArcaneChoices(campaign.Character);
        Check.True(allocations.Length > 1 && allocations.All(a => a.Slots.Select((n, i) => n * (i + 1)).Sum() <= 3), "Use Wizard 5, not total level 7");
        Check.True(allocations.All(a => a.Slots[3] == 0 && a.Slots[4] == 0), "Only actually expended available slots can recover");
        var third = allocations.Single(a => a.Slots[2] == 1);
        var info = ActionInformation.Build(campaign, CharacterEngine.Choices(campaign)).Single(a => a.Kind == "rest.short" && a.Target == third.Target);
        Check.True(info.Details!.Note.Contains("1 个 3 环位") && info.Details.Cost.Contains("Arcane Recovery"));
        engine.Resolve(campaign, "rest.short", third.Target);
        Check.Equal(1, CharacterEngine.Value(campaign.Character, "Spell Slots (3rd)"));
        Check.Equal(0, CharacterEngine.Value(campaign.Character, "Spell Slots (2nd)"));
        Check.Equal(0, CharacterEngine.Value(campaign.Character, "Arcane Recovery")); Check.Equal(2, dice.Count);
        // Pact recovers independently as a short-rest resource, never through the Arcane allocation.
        Check.Equal(2, CharacterEngine.Value(campaign.Character, "Pact Slots (3rd)"));
        Check.Throws<GameException>(() => engine.Resolve(campaign, "rest.short", third.Target));
        engine.Resolve(campaign, "rest.long", "");
        Check.Equal(1, CharacterEngine.Value(campaign.Character, "Arcane Recovery"));
        CharacterEngine.Change(campaign, "Spell Slots (2nd)", -1);
        Check.True(AdvancementRest.ArcaneChoices(campaign.Character).Any(a => a.Slots[1] == 1));
        campaign.Character = campaign.Character with { Inventory = campaign.Character.Inventory.Where(i => i.Id != "spellbook").ToArray() };
        Check.Equal(0, AdvancementRest.ArcaneChoices(campaign.Character).Length);
        return Task.CompletedTask;
    }
}
