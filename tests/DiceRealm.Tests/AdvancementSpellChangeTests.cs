using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementSpellChangeTests
{
    internal static AdvancementDraft Set(AdvancementDraft draft, string key, params string[] values) => draft with
    {
        Selections = [..draft.Selections.Where(s => s.Key != key), new(key, values)]
    };
    internal static Character Qualified(Character c) => c with
    {
        Abilities = c.Abilities.Select(a => a with { Score = 16, Modifier = 3 }).ToArray()
    };

    public static Task InitialFeatReplacementPreservesSourcesAndSpentUses()
    {
        var c = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("wizard", "dwarf", "sage")));
        var original = c.BuildMechanics!.SpellGrants.Single(g => g.Source.Contains("/feat:magic-initiate/", StringComparison.Ordinal) && g.FreeUses == 1);
        Check.True(c.Build!.PreparedSpells.Contains(original.Id), "Fixture must own the same spell from another source");
        c = c with { Resources = c.Resources.Select(r => r.Name == PlayResources.FreeSpell(original) || r.Name == "Spell Slots (1st)" ? r with { Current = 0 } : r).ToArray() };
        string key = "spell-change:" + original.Source;
        var draft = Set(Set(AdvancementTests.Complete(c, "fighter"), key, original.Id), key + ":replacement", "shield");
        string before = JsonSerializer.Serialize(c), build = JsonSerializer.Serialize(c.Build);
        var view = AdvancementEngine.Evaluate(c, draft, 20);
        Check.True(view.CanApply, JsonSerializer.Serialize(view.Issues)); Check.Equal(before, JsonSerializer.Serialize(c));
        var next = view.Character!;
        var changed = next.BuildMechanics!.SpellGrants.Single(g => g.Source == original.Source && g.FreeUses == 1);
        Check.Equal("shield", changed.Id); Check.Equal(original.Ability, changed.Ability); Check.Equal(build, JsonSerializer.Serialize(next.Build));
        Check.Equal(0, next.Resources.Single(r => r.Name == PlayResources.FreeSpell(changed)).Current);
        Check.True(!next.Resources.Any(r => r.Name == PlayResources.FreeSpell(original)));
        Check.Equal(0, next.Resources.Single(r => r.Name == "Spell Slots (1st)").Current);
        var spells = AdvancementSheet.Spells(next, "");
        Check.True(!spells.Any(s => s.Source == original.Source && s.SpellId == original.Id));
        Check.True(spells.Any(s => s.Source == "class:wizard" && s.SpellId == original.Id), "Replacing the feat must not remove the prepared class copy");
        Check.True(spells.Any(s => s.Source == original.Source && s.SpellId == "shield" && s.Id.EndsWith("/free", StringComparison.Ordinal) && !s.Available));
        Check.True(spells.Any(s => s.Source == original.Source && s.SpellId == "shield" && s.Resource == "Spell Slots (1st)"));
        Check.Equal(1, PlayResources.LongRest(next).Resources.Single(r => r.Name == PlayResources.FreeSpell(changed)).Current);
        foreach (var bad in new[]
        {
            Set(draft, key + ":replacement", "fireball"), Set(draft, key + ":replacement", "healing-word"),
            Set(draft, key + ":replacement", original.Id), Set(draft, key, original.Id, "shield"),
            Set(draft, key, "keep"), Set(draft, key + ":list", "cleric")
        })
        {
            Check.True(!AdvancementEngine.Evaluate(c, bad, 20).CanApply); Check.Equal(before, JsonSerializer.Serialize(c));
        }
        var cantrip = next.BuildMechanics.SpellGrants.First(s => s.Source == original.Source && s.FreeUses == 0);
        string newCantrip = AdvancementCatalog.Get().Spells.First(s => s.Level == 0 && s.Classes.Contains("wizard")
            && !next.BuildMechanics.SpellGrants.Any(g => g.Source == original.Source && g.Id == s.Id)).Id;
        var second = Set(Set(AdvancementTests.Complete(next, "fighter"), key, cantrip.Id), key + ":replacement", newCantrip);
        var result = AdvancementEngine.Evaluate(next, second, 20).Character!;
        Check.True(result.BuildMechanics!.SpellGrants.Any(g => g.Source == original.Source && g.Id == newCantrip));
        Check.True(!result.BuildMechanics.SpellGrants.Any(g => g.Source == original.Source && g.Id == cantrip.Id));
        Check.Equal(0, result.Resources.Single(r => r.Name == PlayResources.FreeSpell(changed)).Current);
        return Task.CompletedTask;
    }

    public static Task RepeatedFeatReplacementIsIndependentOfClassLevel()
    {
        var c = Qualified(PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("fighter", "dwarf", "sage"))));
        c = AdvancementTests.Level(AdvancementTests.Level(c), subclass: "fighter:champion");
        c = AdvancementTests.Level(c, pick: g => g.Key == "feat" ? ["magic-initiate"]
            : g.Key == "feat:magic-initiate:4:list" ? ["0"] : g.Key == "feat:magic-initiate:4:ability" ? ["wis"] : null);
        var initial = c.BuildMechanics!.SpellGrants.First(g => g.Source.Contains("/feat:magic-initiate/", StringComparison.Ordinal) && g.FreeUses == 0);
        var feature = c.Advancement!.Classes.Single().BonusSpells!.Single(s => s.Origin == "feat:magic-initiate:4" && s.Uses > 0);
        c = c with { Resources = c.Resources.Select(r => r.Name == AdvancementSheet.FreeSpell(feature) ? r with { Current = 0 } : r).ToArray() };
        string newSpell = AdvancementCatalog.Get().Spells.First(s => s.Level == 1 && s.Classes.Contains("cleric") && s.Id != feature.Id).Id;
        string newCantrip = AdvancementCatalog.Get().Spells.First(s => s.Level == 0 && s.Classes.Contains("wizard")
            && !c.BuildMechanics.SpellGrants.Any(g => g.Source == initial.Source && g.Id == s.Id)).Id;
        var draft = AdvancementTests.Complete(c, "wizard");
        draft = Set(Set(draft, "spell-change:" + initial.Source, initial.Id), "spell-change:" + initial.Source + ":replacement", newCantrip);
        draft = Set(Set(draft, "spell-change:" + feature.Origin, feature.Id), "spell-change:" + feature.Origin + ":replacement", newSpell);
        string before = JsonSerializer.Serialize(c);
        var preview = AdvancementEngine.Evaluate(c, draft, 20); Check.True(preview.CanApply, JsonSerializer.Serialize(preview.Issues));
        Check.Equal(before, JsonSerializer.Serialize(c)); var next = preview.Character!;
        var owner = next.Advancement!.Classes.Single(s => s.ClassId == "fighter");
        Check.Equal(4, owner.Level); Check.Equal(1, next.Advancement.Classes.Single(s => s.ClassId == "wizard").Level);
        var changed = owner.BonusSpells!.Single(s => s.Origin == feature.Origin && s.Uses > 0);
        Check.Equal(newSpell, changed.Id); Check.Equal("wis", changed.Ability);
        var choices = owner.Choices ?? throw new Exception("Feat source choices missing");
        Check.True(choices.Any(s => s.Key.StartsWith(feature.Origin + ":", StringComparison.Ordinal) && s.Values.Contains(newSpell)));
        Check.True(!choices.Any(s => s.Key.StartsWith(feature.Origin + ":", StringComparison.Ordinal) && s.Values.Contains(feature.Id)));
        Check.Equal(0, next.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(changed)).Current);
        Check.True(!next.Resources.Any(r => r.Name == AdvancementSheet.FreeSpell(feature)));
        Check.True(next.BuildMechanics!.SpellGrants.Any(s => s.Source == initial.Source && s.Id == newCantrip));
        next = AdvancementTests.Level(next, "wizard");
        Check.True(next.Advancement!.Classes.Single(s => s.ClassId == "fighter").BonusSpells!.Contains(changed));
        Check.Equal(0, next.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(changed)).Current);
        return Task.CompletedTask;
    }

    public static Task RangerUsesFollowClassLevelNotProficiency()
    {
        var ranger = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("ranger", "dwarf", "soldier")));
        var initial = ranger.BuildMechanics!.SpellGrants.Single(g => g.Source == "class:ranger" && g.Id == "hunter-s-mark");
        ranger = ranger with { Resources = ranger.Resources.Select(r => r.Name == PlayResources.FreeSpell(initial) ? r with { Current = 0 } : r).ToArray() };
        while (ranger.Level < 5) ranger = AdvancementTests.Level(ranger, subclass: ranger.Level == 2 ? "ranger:hunter" : "");
        var resource = ranger.Resources.Single(r => r.Name == PlayResources.FreeSpell(initial));
        Check.Equal(3, resource.Maximum); Check.Equal(1, resource.Current);
        Check.Equal(3, ranger.BuildMechanics!.SpellGrants.Single(g => g.Source == "class:ranger").FreeUses);
        var multi = Qualified(BuildEvaluator.Create(FullCreationTests.Complete("wizard", "dwarf", "sage")));
        while (multi.Level < 4) multi = AdvancementTests.Level(multi, subclass: multi.Level == 2 ? "wizard:abjurer" : "");
        multi = AdvancementTests.Level(multi, "ranger");
        var spell = multi.Advancement!.Classes.Single(s => s.ClassId == "ranger").BonusSpells!.Single(s => s.Origin == "class:ranger" && s.Id == "hunter-s-mark");
        Check.Equal(3, multi.ProficiencyBonus); Check.Equal(2, spell.Uses);
        Check.Equal(2, multi.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(spell)).Maximum);
        multi = multi with { Resources = multi.Resources.Select(r => r.Name == AdvancementSheet.FreeSpell(spell) ? r with { Current = 0 } : r).ToArray() };
        while (multi.Level < 9) multi = AdvancementTests.Level(multi, "ranger", multi.Level == 6 ? "ranger:hunter" : "");
        Check.Equal(4, multi.ProficiencyBonus);
        resource = multi.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(spell));
        Check.Equal(3, resource.Maximum); Check.Equal(1, resource.Current);
        Check.True(AdvancementSheet.Spells(multi, "").Any(s => s.Source == spell.Origin && s.SpellId == spell.Id && s.Id.EndsWith("/free", StringComparison.Ordinal)));
        return Task.CompletedTask;
    }

    public static Task SpeciesSpellsFollowCharacterLevelAndOriginalLineage()
    {
        foreach (var row in new[]
        {
            ("elf", "drow", "faerie-fire", "darkness"), ("elf", "high-elf", "detect-magic", "misty-step"), ("elf", "wood-elf", "longstrider", "pass-without-trace"),
            ("tiefling", "abyssal", "ray-of-sickness", "hold-person"), ("tiefling", "chthonic", "false-life", "ray-of-enfeeblement"), ("tiefling", "infernal", "hellish-rebuke", "darkness")
        })
        {
            string root = "species:" + row.Item1, source = root + "/lineage:" + row.Item2;
            var build = FullCreationTests.Complete("fighter", row.Item1, "soldier");
            build = build with { Selections = [..build.Selections.Where(s => s.Key != root + "/lineage" && !s.Key.StartsWith(root + "/lineage:", StringComparison.Ordinal)),
                new(root + "/lineage", [row.Item2]), new(source + "/spell-ability", ["wis"])] };
            var c = Qualified(PlayResources.Ensure(BuildEvaluator.Create(build)));
            string originalBuild = JsonSerializer.Serialize(c.Build);
            c = AdvancementTests.Level(c); Check.True(!c.BuildMechanics!.SpellGrants.Any(s => s.Id == row.Item3));
            c = AdvancementTests.Level(c, "wizard");
            Check.Equal(2, c.Advancement!.Classes.Single(s => s.ClassId == "fighter").Level);
            var third = c.BuildMechanics!.SpellGrants.Single(s => s.Source == source && s.Id == row.Item3);
            Check.Equal("wis", third.Ability); Check.Equal(1, third.FreeUses); Check.Equal("always-prepared", third.Mode);
            c = c with { Resources = c.Resources.Select(r => r.Name == PlayResources.FreeSpell(third) ? r with { Current = 0 } : r).ToArray() };
            var scholar = AdvancementEngine.Evaluate(c, AdvancementTests.Complete(c, "wizard"), 20);
            Check.True(scholar.CanApply && scholar.Notices.Any(n => n.Contains("合格熟练技能不足")));
            Check.Equal(JsonSerializer.Serialize(c.Skills), JsonSerializer.Serialize(scholar.Character!.Skills));
            Check.Equal(JsonSerializer.Serialize(c.Expertise), JsonSerializer.Serialize(scholar.Character.Expertise));
            c = scholar.Character; Check.True(!c.BuildMechanics!.SpellGrants.Any(s => s.Source == source && s.Id == row.Item4));
            c = AdvancementTests.Level(c, "wizard", "wizard:abjurer");
            var fifth = c.BuildMechanics!.SpellGrants.Single(s => s.Source == source && s.Id == row.Item4);
            Check.Equal("wis", fifth.Ability); Check.Equal(originalBuild, JsonSerializer.Serialize(c.Build));
            Check.Equal(0, c.Resources.Single(r => r.Name == PlayResources.FreeSpell(third)).Current);
            Check.Equal(1, c.Resources.Single(r => r.Name == PlayResources.FreeSpell(fifth)).Current);
            var routes = AdvancementSheet.Spells(c, "").Where(s => s.Source == source && s.SpellId == fifth.Id).ToArray();
            Check.True(routes.All(s => s.Ability == "wisdom"));
            Check.True(routes.Any(s => s.Id.EndsWith("/free", StringComparison.Ordinal)) && routes.Any(s => s.Resource == "Spell Slots (2nd)"));
            Check.Equal(1, c.BuildMechanics.SpellGrants.Count(s => s.Source == source && s.Id == fifth.Id));
        }
        var gnome = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("fighter", "gnome", "soldier")));
        var grant = gnome.BuildMechanics!.SpellGrants.Single(s => s.Id == "speak-with-animals");
        gnome = gnome with { Resources = gnome.Resources.Select(r => r.Name == PlayResources.FreeSpell(grant) ? r with { Current = 0 } : r).ToArray() };
        while (gnome.Level < 5) gnome = AdvancementTests.Level(gnome, subclass: gnome.Level == 2 ? "fighter:champion" : "");
        Check.Equal(3, gnome.BuildMechanics!.SpellGrants.Single(s => s.Id == grant.Id).FreeUses);
        Check.Equal(3, gnome.Resources.Single(r => r.Name == PlayResources.FreeSpell(grant)).Maximum);
        Check.Equal(1, gnome.Resources.Single(r => r.Name == PlayResources.FreeSpell(grant)).Current);
        return Task.CompletedTask;
    }
}
