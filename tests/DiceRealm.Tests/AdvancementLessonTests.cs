using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementLessonTests
{
    private const string Prefix = "lessons-of-the-first-ones/";
    private static Character Warlock() => PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("warlock", "dwarf", "soldier")
        with { ClassSkills = ["deception", "investigation"] }));
    internal static AdvancementDraft Complete(Character c, string[] optional, Func<BuildGroup, string[]?>? pick = null)
    {
        int level = AdvancementEngine.State(c).Classes.Single(s => s.ClassId == "warlock").Level;
        var draft = new AdvancementDraft { ClassId = "warlock", SubclassId = level == 2 ? "warlock:fiend" : "",
            Selections = [new("optional:EI", optional)] };
        for (int pass = 0; pass < 100; pass++)
        {
            var preview = AdvancementEngine.Evaluate(c, draft, 20);
            if (preview.CanApply) return draft;
            var group = preview.Groups.FirstOrDefault(g => !g.Complete) ?? throw new Exception(JsonSerializer.Serialize(preview.Issues));
            var selected = pick?.Invoke(group) ?? group.Selected.Where(v => group.Options.Any(o => o.Id == v))
                .Concat(group.Options.OrderByDescending(o => o.Id == "ability-score-improvement").Select(o => o.Id)).Distinct().Take(group.Count).ToArray();
            Check.True(group.Count == selected.Length, group.Key);
            draft = AdvancementSpellChangeTests.Set(draft, group.Key, selected);
        }
        throw new Exception("Lesson choice did not complete");
    }
    private static Character Gain(Character c, string[] optional, Func<BuildGroup, string[]?>? pick = null)
        => AdvancementEngine.Evaluate(c, Complete(c, optional, pick), 20).Character!;
    private static Character Replace(Character c, string before, string after)
        => Gain(c, AdvancementEngine.State(c).Classes.Single(s => s.ClassId == "warlock").OptionalFeatures.Select(id => id == before ? after : id).ToArray());

    public static Task DistinctOriginFeatsAndNegativeToughDelta()
    {
        var c = Warlock(); string build = JsonSerializer.Serialize(c.Build);
        c = c with { HitPoints = c.MaxHitPoints - 3, TemporaryHitPoints = 4 };
        var grown = Gain(c, ["armor-of-shadows", Prefix + "tough", Prefix + "lucky"]);
        Check.True(grown.BuildMechanics!.Feats.Contains("tough") && grown.BuildMechanics.Feats.Contains("lucky"));
        Check.Equal(3, grown.MaxHitPoints - grown.HitPoints); Check.Equal(4, grown.TemporaryHitPoints);
        Check.Equal(3, grown.Advancement!.FeatSources!.Length);
        Check.Equal(grown.ProficiencyBonus, grown.Resources.Single(r => r.Name == "Luck Points").Current);
        while (grown.Level < 5) grown = AdvancementTests.Level(grown, subclass: grown.Level == 2 ? "warlock:fiend" : "");
        int max = grown.MaxHitPoints, level = grown.Level;
        int expected = 5 + CharacterEngine.Ability(grown, "constitution") + 1 - 2 * level; // Dwarf Toughness remains.
        Check.True(expected < 0);
        var removed = Replace(grown, Prefix + "tough", "eldritch-mind");
        Check.True(!removed.BuildMechanics!.Feats.Contains("tough") && !removed.Features.Contains("tough"));
        Check.Equal(expected, removed.Advancement!.Steps.Last().HitPointIncrease);
        Check.Equal(max + expected, removed.MaxHitPoints); Check.Equal(3, removed.MaxHitPoints - removed.HitPoints);
        Check.Equal(build, JsonSerializer.Serialize(removed.Build));
        var down = Replace(grown with { HitPoints = 1 }, Prefix + "tough", "eldritch-mind");
        Check.Equal(0, down.HitPoints);
        var stillDown = Replace(grown with { HitPoints = 0 }, Prefix + "tough", "eldritch-mind");
        Check.Equal(0, stillDown.HitPoints);
        var duplicate = new AdvancementDraft { ClassId = "warlock", Selections = [new("optional:EI", [Prefix + "tough", Prefix + "tough", "armor-of-shadows"])] };
        Check.Throws<GameException>(() => AdvancementEngine.Evaluate(c, duplicate, 20));
        return Task.CompletedTask;
    }

    public static Task SkillRevocationKeepsLaterIndependentTraining()
    {
        var c = Warlock();
        var grown = Gain(c, ["armor-of-shadows", "eldritch-mind", Prefix + "skilled"],
            g => g.Key == "optional:" + Prefix + "skilled:proficiencies:0" ? ["skill:insight", "skill:medicine", "skill:stealth"] : null);
        Check.True(new[] { "Insight", "Medicine", "Stealth" }.All(grown.Skills.Contains));
        var qualified = AdvancementSpellChangeTests.Qualified(grown);
        var monk = AdvancementTests.Level(AdvancementTests.Level(qualified, "monk"), "monk");
        monk = AdvancementTests.Level(monk, "monk", "monk:mercy");
        var permanent = monk.Advancement!.FeatSources!.Single(s => s.Id == "permanent");
        Check.True(permanent.Skills.Contains("Insight") && permanent.Skills.Contains("Medicine"));
        var removed = Replace(monk, Prefix + "skilled", Prefix + "lucky");
        Check.True(removed.Skills.Contains("Insight") && removed.Skills.Contains("Medicine"));
        Check.True(!removed.Skills.Contains("Stealth")); Check.True(!removed.BuildMechanics!.Feats.Contains("skilled"));
        Check.True(removed.BuildMechanics.Tools.Contains("herbalism-kit"));
        Check.True(!removed.Advancement!.Classes.Single(s => s.ClassId == "warlock").Choices!.Any(s => s.Key.StartsWith("optional:" + Prefix + "skilled:", StringComparison.Ordinal)));
        Check.Equal(removed.Level, AdvancementEngine.State(JsonSerializer.Deserialize<Character>(JsonSerializer.Serialize(removed))!).Classes.Sum(s => s.Level));
        return Task.CompletedTask;
    }

    public static Task MagicInitiateRevocationAndSpentUses()
    {
        var c = Warlock();
        string identity = Prefix + "magic-initiate", origin = "optional:" + identity;
        var grown = Gain(c, ["armor-of-shadows", "eldritch-mind", identity]);
        var bonus = grown.Advancement!.Classes.Single().BonusSpells!.Where(b => b.Origin == origin).ToArray();
        Check.Equal(3, bonus.Length);
        var invalid = grown with { Advancement = grown.Advancement with { Classes = grown.Advancement.Classes.Select(s => s with
        { BonusSpells = s.BonusSpells!.Select(b => b.Origin == origin && b.Uses > 0 ? b with { Condition = "cha" } : b).ToArray() }).ToArray() } };
        Check.Throws<GameException>(() => AdvancementEngine.State(invalid));
        var free = bonus.Single(b => b.Uses > 0); string resource = AdvancementSheet.FreeSpell(free);
        var routes = CharacterPlayEngine.SpellSources(grown).Where(s => s.Source == origin && s.SpellId == free.Id).ToArray();
        Check.True(routes.Any(s => s.Id.EndsWith("/free", StringComparison.Ordinal)) && routes.Any(s => s.Resource.StartsWith("Pact Slots", StringComparison.Ordinal)));
        grown = grown with { Resources = grown.Resources.Select(r => r.Name == resource ? r with { Current = 0 } : r).ToArray() };
        // The feat's existing once-per-level replacement is also available across classes.
        var fighterDraft = AdvancementTests.Complete(AdvancementSpellChangeTests.Qualified(grown), "fighter");
        var offered = AdvancementEngine.Evaluate(AdvancementSpellChangeTests.Qualified(grown), fighterDraft, 20);
        Check.True(offered.Groups.Any(g => g.Key == "spell-change:" + origin));
        var removed = Replace(grown, identity, Prefix + "tough");
        Check.True(!CharacterPlayEngine.SpellSources(removed).Any(s => s.Source == origin));
        Check.True(!removed.Resources.Any(r => r.Name == resource));
        Check.Equal(0, removed.Advancement!.RetiredResources!.Single(r => r.Name == resource).Current);
        var regrant = Replace(removed, Prefix + "tough", identity);
        Check.Equal(0, regrant.Resources.Single(r => r.Name == resource).Current);
        Check.True(regrant.Advancement!.RetiredResources is null);
        var rested = PlayResources.LongRest(removed) with { NextLongRestAtSeconds = removed.NextLongRestAtSeconds + 86400 };
        var afterRest = Replace(rested, Prefix + "tough", identity);
        Check.Equal(1, afterRest.Resources.Single(r => r.Name == resource).Current);
        Check.True(afterRest.Advancement!.FeatSources!.Single(s => s.Id == origin).Feats.SequenceEqual(new[] { "magic-initiate" }));
        var lucky = Gain(c, ["armor-of-shadows", "eldritch-mind", Prefix + "lucky"]);
        lucky = lucky with { Resources = lucky.Resources.Select(r => r.Name == "Luck Points" ? r with { Current = 0 } : r).ToArray() };
        var noLuck = Replace(lucky, Prefix + "lucky", Prefix + "alert");
        Check.True(!noLuck.Resources.Any(r => r.Name == "Luck Points"));
        Check.True(noLuck.BuildMechanics!.Feats.Contains("alert"));
        Check.Equal(CharacterEngine.Ability(noLuck, "dexterity") + noLuck.ProficiencyBonus, noLuck.BuildMechanics.InitiativeBonus);
        var luckAgain = Replace(noLuck, Prefix + "alert", Prefix + "lucky");
        Check.Equal(0, luckAgain.Resources.Single(r => r.Name == "Luck Points").Current);
        Check.True(!luckAgain.BuildMechanics!.Feats.Contains("alert"));
        Check.Equal(CharacterEngine.Ability(luckAgain, "dexterity"), luckAgain.BuildMechanics.InitiativeBonus);
        return Task.CompletedTask;
    }

    public static Task ExpertiseAndIndependentRepeatableFeat()
    {
        var c = Warlock();
        string[] picks = ["skill:arcana", "skill:medicine", "skill:stealth"];
        var grown = Gain(c, ["armor-of-shadows", "eldritch-mind", Prefix + "skilled"],
            g => g.Key.EndsWith("skilled:proficiencies:0", StringComparison.Ordinal) ? picks : null);
        grown = AdvancementSpellChangeTests.Qualified(grown);
        grown = AdvancementTests.Level(grown, "wizard");
        grown = AdvancementTests.Level(grown, "wizard", pick: g => g.Key == "scholar" ? ["arcana"] : null);
        Check.True(grown.Expertise!.Contains("Arcana"));
        var removed = Replace(grown, Prefix + "skilled", Prefix + "lucky");
        Check.True(!removed.Skills.Contains("Arcana") && !removed.Expertise!.Contains("Arcana"));
        Check.True(removed.Advancement!.FeatSources!.Single(s => s.Id == "permanent").Expertise.Contains("Arcana"));
        var restored = Gain(removed, ["armor-of-shadows", "eldritch-mind", Prefix + "skilled"],
            g => g.Key.EndsWith("skilled:proficiencies:0", StringComparison.Ordinal) ? picks : null);
        Check.True(restored.Skills.Contains("Arcana") && restored.Expertise!.Contains("Arcana"));

        var permanent = AdvancementTests.Level(AdvancementTests.Level(c), subclass: "warlock:fiend");
        permanent = AdvancementTests.Level(permanent, pick: g => g.Key == "feat" ? ["skilled"] : null);
        string[] originalSkills = permanent.Skills.ToArray();
        string[] originalTools = permanent.BuildMechanics!.Tools.ToArray();
        var withLesson = Gain(permanent, [..permanent.Advancement!.Classes.Single().OptionalFeatures, Prefix + "skilled"]);
        Check.True(withLesson.Advancement!.FeatSources!.Single(s => s.Id == "permanent").Feats.Contains("skilled"));
        var after = Replace(withLesson, Prefix + "skilled", Prefix + "lucky");
        Check.True(after.BuildMechanics!.Feats.Contains("skilled"));
        Check.True(originalSkills.ToHashSet().SetEquals(after.Skills));
        Check.True(originalTools.ToHashSet().SetEquals(after.BuildMechanics.Tools));
        return Task.CompletedTask;
    }

    public static Task ToolsWeaponsAndCorruptSources()
    {
        foreach (string feat in new[] { "crafter", "musician", "tavern-brawler" })
        {
            var c = Warlock(); var grown = Gain(c, ["armor-of-shadows", "eldritch-mind", Prefix + feat]);
            var source = grown.Advancement!.FeatSources!.Single(s => s.Id == "optional:" + Prefix + feat);
            if (feat == "tavern-brawler") Check.True(source.Weapons.Contains("improvised"));
            else Check.Equal(3, source.Tools.Length);
            var removed = Replace(grown, Prefix + feat, Prefix + "lucky");
            Check.True(!removed.BuildMechanics!.Feats.Contains(feat));
            Check.Equal(JsonSerializer.Serialize(c.BuildMechanics!.Tools.Order()), JsonSerializer.Serialize(removed.BuildMechanics.Tools.Order()));
            Check.Equal(JsonSerializer.Serialize(c.BuildMechanics.WeaponTraining.Order()), JsonSerializer.Serialize(removed.BuildMechanics.WeaponTraining.Order()));
            var noLedger = grown with { Advancement = grown.Advancement with { FeatSources = null } };
            Check.Throws<GameException>(() => AdvancementEngine.State(noLedger));
            var bad = grown with { Advancement = grown.Advancement with { FeatSources = grown.Advancement.FeatSources!.Select(s => s.Id == source.Id ? s with { Feats = ["tough"] } : s).ToArray() } };
            Check.Throws<GameException>(() => AdvancementEngine.State(bad));
        }
        return Task.CompletedTask;
    }
}
