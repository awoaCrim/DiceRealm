using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementSourceOwnershipTests
{
    internal static CharacterBuild OrderBuild(string classId)
    {
        string order = classId == "cleric" ? "thaumaturge" : "magician";
        var build = FullCreationTests.Complete(classId, "dwarf", "sage");
        build = build with { Selections = build.Selections.Select(s => s.Key == "class:" + classId + "/order" ? s with { Values = [order] } : s).ToArray() };
        for (int pass = 0; pass < 20; pass++)
        {
            var preview = BuildEvaluator.Evaluate(build);
            if (preview.CanCreate) return build;
            var group = preview.Groups.FirstOrDefault(g => !g.Complete) ?? throw new Exception(JsonSerializer.Serialize(preview.Issues));
            build = build with { Selections = [..build.Selections.Where(s => s.Key != group.Key), new(group.Key, group.Options.Take(group.Count).Select(o => o.Id).ToArray())] };
        }
        throw new Exception("Order build did not complete");
    }

    public static Task OrderCantripMovesOnceAndCanBeReplaced()
    {
        foreach (string classId in new[] { "cleric", "druid" })
        {
            var c = PlayResources.Ensure(BuildEvaluator.Create(OrderBuild(classId)));
            string source = "class:" + classId + (classId == "cleric" ? "/thaumaturge" : "/magician");
            var extra = c.BuildMechanics!.SpellGrants.Single(g => g.Source == source);
            var original = JsonSerializer.Serialize(c.Build);
            c = c with { HitPoints = c.MaxHitPoints - 3, TemporaryHitPoints = 4,
                Resources = c.Resources.Select(r => r with { Current = 0 }).ToArray() };
            string before = JsonSerializer.Serialize(c);
            var draft = AdvancementTests.Complete(c);
            var preview = AdvancementEngine.Evaluate(c, draft, 20);
            Check.Equal(before, JsonSerializer.Serialize(c));
            var grown = preview.Character!;
            var cls = grown.Advancement!.Classes.Single();
            Check.True(cls.Cantrips.Contains(extra.Id));
            Check.Equal(c.Build!.Cantrips.Length + 1, cls.Cantrips.Length);
            Check.True(!grown.BuildMechanics!.SpellGrants.Any(g => g.Source == source));
            Check.Equal(JsonSerializer.Serialize(c.BuildMechanics.SpellGrants.Where(g => g.Source != source)), JsonSerializer.Serialize(grown.BuildMechanics.SpellGrants));
            Check.Equal(original, JsonSerializer.Serialize(grown.Build));
            Check.Equal(3, grown.MaxHitPoints - grown.HitPoints); Check.Equal(4, grown.TemporaryHitPoints);
            Check.Equal(1, grown.Resources.Single(r => r.Name == AdvancementProjection.SlotName(1)).Current);
            string replacement = AdvancementCatalog.Get().Spells.First(s => s.Level == 0 && s.Classes.Contains(classId)
                && !cls.Cantrips.Contains(s.Id) && !grown.BuildMechanics.SpellGrants.Any(g => g.Id == s.Id)).Id;
            string subclass = classId == "cleric" ? "cleric:life" : "druid:land";
            var replace = AdvancementSpellChangeTests.Set(AdvancementTests.Complete(grown, subclass: subclass), "spells:cantrips",
                cls.Cantrips.Select(id => id == extra.Id ? replacement : id).ToArray());
            var third = AdvancementEngine.Evaluate(grown, replace, 20).Character!;
            Check.True(third is not null);
            Check.True(!CharacterPlayEngine.SpellSources(third!).Any(s => s.SpellId == extra.Id && (s.Source == source || s.Source == "class:" + classId)));
            Check.True(CharacterPlayEngine.SpellSources(third!).Any(s => s.SpellId == replacement && s.Source == "class:" + classId));
            var reopened = JsonSerializer.Deserialize<Character>(JsonSerializer.Serialize(third))!;
            Check.Equal(JsonSerializer.Serialize(third), JsonSerializer.Serialize(reopened));
            Check.Equal(3, AdvancementEngine.State(reopened).Classes.Single().Level);

            // Gaining a DIFFERENT class must still transfer the original order, not lose
            // its extra cantrip until the original class happens to level up.
            var qualified = c with { Abilities = c.Abilities.Select(a => a with { Score = 16, Modifier = 3 }).ToArray() };
            var multi = AdvancementTests.Level(qualified, "fighter");
            Check.True(multi.Advancement!.Classes.Single(s => s.ClassId == classId).Cantrips.Contains(extra.Id));
            Check.True(!multi.BuildMechanics!.SpellGrants.Any(g => g.Source == source));
        }
        return Task.CompletedTask;
    }

    internal static AdvancementDraft ReplaceArmor(Character c) => AdvancementTests.Complete(c, pick: g => g.Key == "optional:EI"
        ? ["pact-of-the-chain", "eldritch-mind", "pact-of-the-blade"] : null);

    public static Task InvocationSourceRevokedAndFreeRoutesPreserved()
    {
        var c = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("warlock", "dwarf", "sage")));
        Check.True(c.Features.Contains("armor-of-shadows"));
        string original = JsonSerializer.Serialize(c.Build);
        c = c with { Resources = c.Resources.Select(r => r with { Current = 0 }).ToArray() };
        var retained = AdvancementTests.Level(c);
        var armor = retained.Advancement!.Classes.Single().BonusSpells!.Single(s => s.Origin == "optional:armor-of-shadows");
        Check.Equal("at-will", armor.Mode); Check.Equal("self", armor.Condition);
        Check.True(!retained.BuildMechanics!.SpellGrants.Any(s => s.Source == "class:warlock/invocation"));
        var routes = CharacterPlayEngine.SpellSources(retained).Where(s => s.Source == armor.Origin).ToArray();
        Check.Equal(1, routes.Length); Check.True(routes[0].Id.EndsWith("/at-will", StringComparison.Ordinal));
        Check.Equal("", routes[0].Resource); Check.True(routes[0].Details.Contains("自己"));
        var replaced = AdvancementEngine.Evaluate(c, ReplaceArmor(c), 20).Character!;
        Check.True(!replaced.Features.Contains("armor-of-shadows"));
        Check.True(replaced.Features.Contains("pact-of-the-chain") && replaced.Features.Contains("eldritch-mind"));
        Check.True(!CharacterPlayEngine.SpellSources(replaced).Any(s => s.Source is "optional:armor-of-shadows" or "class:warlock/invocation"));
        var chain = CharacterPlayEngine.SpellSources(replaced).Single(s => s.Source == "optional:pact-of-the-chain");
        Check.True(chain.Id.EndsWith("/at-will", StringComparison.Ordinal)); Check.Equal("", chain.Resource);
        Check.True(chain.Details.Contains("魔法动作") && chain.Details.Contains("不免材料"));
        Check.Equal(original, JsonSerializer.Serialize(replaced.Build));
        Check.Equal(1, replaced.Resources.Single(r => r.Name == AdvancementProjection.SlotName(1, true)).Current);
        var nextDraft = AdvancementSpellChangeTests.Set(AdvancementTests.Complete(replaced, subclass: "warlock:fiend"), "optional:EI",
            "armor-of-shadows", "eldritch-mind", "pact-of-the-blade");
        var third = AdvancementEngine.Evaluate(replaced, nextDraft, 20).Character!;
        Check.True(third is not null); Check.True(!third!.Features.Contains("pact-of-the-chain"));
        Check.True(!CharacterPlayEngine.SpellSources(third).Any(s => s.Source == "optional:pact-of-the-chain"));
        Check.True(CharacterPlayEngine.SpellSources(third).Any(s => s.Source == "optional:armor-of-shadows"));
        var bad = third with { Advancement = third.Advancement! with { Classes = third.Advancement.Classes.Select(s => s with
        { BonusSpells = s.BonusSpells!.Select(b => b.Mode == "at-will" ? b with { Condition = "any-target" } : b).ToArray() }).ToArray() } };
        Check.Throws<GameException>(() => AdvancementEngine.State(bad));
        return Task.CompletedTask;
    }

    public static Task LegacyTransfersOnlyOnExplicitGrowth()
    {
        var c = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("warlock", "dwarf", "sage")));
        var oldGrant = c.BuildMechanics!.SpellGrants.Single(s => s.Source == "class:warlock/invocation");
        var grown = AdvancementEngine.Evaluate(c, ReplaceArmor(c), 20).Character!;
        // Exact old failure shape: live optional set is correct but immutable-build spell
        // grant and feature label survived replacement. A read must not repair/write it.
        var legacy = grown with { BuildMechanics = grown.BuildMechanics! with { SpellGrants = [..grown.BuildMechanics.SpellGrants, oldGrant] },
            Features = [..grown.Features, "armor-of-shadows"] };
        string before = JsonSerializer.Serialize(legacy);
        _ = AdvancementEngine.State(legacy); _ = CharacterPlayEngine.SpellSources(legacy);
        Check.Equal(before, JsonSerializer.Serialize(legacy));
        var qualified = legacy with { Abilities = legacy.Abilities.Select(a => a with { Score = 16, Modifier = 3 }).ToArray() };
        var migrated = AdvancementTests.Level(qualified, "fighter");
        Check.True(!migrated.BuildMechanics!.SpellGrants.Any(g => g.Source == oldGrant.Source));
        Check.True(!migrated.Features.Contains("armor-of-shadows"));
        Check.True(migrated.Features.Contains("pact-of-the-chain"));
        Check.True(!CharacterPlayEngine.SpellSources(migrated).Any(s => s.Source == oldGrant.Source));
        Check.Equal(JsonSerializer.Serialize(legacy.Advancement!.Steps), JsonSerializer.Serialize(migrated.Advancement!.Steps.Take(1)));
        return Task.CompletedTask;
    }
}
