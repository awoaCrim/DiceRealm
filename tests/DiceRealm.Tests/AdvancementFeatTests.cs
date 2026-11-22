using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementFeatTests
{
    private static Character FighterThree(string background = "soldier")
    {
        var c = BuildEvaluator.Create(FullCreationTests.Complete("fighter", "human", background));
        c = c with { Abilities = c.Abilities.Select(a => a with { Score = 16, Modifier = 3 }).ToArray() };
        return AdvancementTests.Level(AdvancementTests.Level(c), subclass: "fighter:champion");
    }
    public static Task MixedTrainingAndPermanentResistance()
    {
        var c = FighterThree(); int skills = c.Skills.Length, tools = c.BuildMechanics!.Tools.Length;
        var draft = AdvancementTests.Complete(c, pick: group =>
        {
            if (group.Key == "feat") return ["skilled"];
            if (group.Key.StartsWith("feat:skilled:proficiencies:", StringComparison.Ordinal))
                return [..group.Options.Where(o => o.Id.StartsWith("skill:", StringComparison.Ordinal)).Take(2).Select(o => o.Id), group.Options.First(o => o.Id.StartsWith("tool:", StringComparison.Ordinal)).Id];
            return null;
        });
        string before = JsonSerializer.Serialize(c);
        var preview = AdvancementEngine.Evaluate(c, draft, 20);
        Check.True(preview.CanApply); Check.Equal(before, JsonSerializer.Serialize(c)); c = preview.Character!;
        Check.Equal(skills + 2, c.Skills.Length); Check.Equal(tools + 1, c.BuildMechanics!.Tools.Length);
        c = AdvancementTests.Level(c);
        c = AdvancementTests.Level(c, pick: g => g.Key == "feat" ? ["skilled"]
            : g.Key.StartsWith("feat:skilled:proficiencies:", StringComparison.Ordinal) ? g.Options.Where(o => o.Id.StartsWith("tool:", StringComparison.Ordinal)).Take(3).Select(o => o.Id).ToArray() : null);
        Check.Equal(tools + 4, c.BuildMechanics!.Tools.Length); Check.Equal(skills + 2, c.Skills.Length);
        while (c.Level < 18) c = AdvancementTests.Level(c);
        c = AdvancementTests.Level(c, pick: g => g.Key == "feat" ? ["boon-of-energy-resistance"] : g.Key == "feat:resistance" ? ["acid", "fire"] : null);
        Check.True(c.BuildMechanics!.Resistances.Contains("acid") && c.BuildMechanics.Resistances.Contains("fire"));
        Check.True(c.Advancement!.Steps.Last().Choices.Selections.Single(s => s.Key == "feat:resistance").Values.SequenceEqual(new[] { "acid", "fire" }));
        c = AdvancementTests.Level(c);
        Check.True(c.BuildMechanics!.Resistances.Contains("acid") && c.BuildMechanics.Resistances.Contains("fire"), "Later growth must preserve acquired passive resistance");
        return Task.CompletedTask;
    }
    public static Task RepeatedMagicInitiateUsesDifferentListsAndBothCastingRoutes()
    {
        var c = FighterThree("sage");
        Check.True(c.BuildMechanics!.SpellGrants.Any(g => g.Source.EndsWith("/feat:magic-initiate/wizard", StringComparison.Ordinal)));
        c = AdvancementTests.Level(c, pick: g =>
        {
            if (g.Key == "feat") return ["magic-initiate"];
            if (g.Key.StartsWith("feat:magic-initiate:", StringComparison.Ordinal) && g.Key.EndsWith(":ability", StringComparison.Ordinal)) return ["wis"];
            if (g.Key.EndsWith(":list", StringComparison.Ordinal))
            {
                Check.True(!g.Options.Any(o => o.Id == "2"), "The background already owns Wizard Magic Initiate");
                return ["0"];
            }
            return null;
        });
        var feature = c.Advancement!.Classes.Single().BonusSpells!.Single(s => s.Origin == "feat:magic-initiate:4" && s.Uses > 0);
        Check.Equal("prepared", feature.Mode); Check.Equal("wis", feature.Ability);
        Check.Equal("multiple", c.Spellcasting!.Ability);
        c = AdvancementTests.Level(c, "wizard");
        var routes = AdvancementSheet.Spells(c, "").Where(s => s.Source == feature.Origin && s.SpellId == feature.Id).ToArray();
        Check.True(routes.All(s => s.Ability == "wisdom")); Check.Equal("multiple", c.Spellcasting!.Ability);
        Check.True(routes.Any(s => s.Id.EndsWith("/free", StringComparison.Ordinal)) && routes.Any(s => s.Id.EndsWith("/slot/1", StringComparison.Ordinal)), "One source must expose both its free use and an owned slot route");
        c = AdvancementTests.Level(c, "fighter");
        c = AdvancementTests.Level(c, "fighter", pick: g =>
        {
            if (g.Key == "feat") return ["magic-initiate"];
            if (g.Key.EndsWith(":list", StringComparison.Ordinal))
            { Check.True(g.Options.Select(o => o.Id).SequenceEqual(new[] { "1" })); return ["1"]; }
            return null;
        });
        c = AdvancementTests.Level(c, "fighter");
        var next = AdvancementEngine.Evaluate(c, new() { ClassId = "fighter" }, 20);
        Check.True(!next.Groups.Single(g => g.Key == "feat").Options.Any(o => o.Id == "magic-initiate"), "No fourth distinct list exists");
        return Task.CompletedTask;
    }
}
