using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementInvocationTests
{
    private static Character Warlock(params string[] cantrips) => PlayResources.Ensure(BuildEvaluator.Create(
        FullCreationTests.Complete("warlock", "dwarf", "sage") with { Cantrips = cantrips }));
    private static AdvancementDraft Two(Character c, params string[] invocations) => AdvancementTests.Complete(c,
        pick: g => g.Key == "optional:EI" ? invocations : null);

    public static Task RepeatBindingsAndReplacementLimits()
    {
        var c = Warlock("eldritch-blast", "poison-spray");
        var draft = Two(c, "armor-of-shadows", "agonizing-blast/eldritch-blast", "agonizing-blast/poison-spray");
        string before = JsonSerializer.Serialize(c);
        var preview = AdvancementEngine.Evaluate(c, draft, 20);
        Check.True(preview.CanApply); Check.Equal(before, JsonSerializer.Serialize(c));
        var grown = preview.Character!;
        Check.Equal(2, grown.Advancement!.Classes.Single().OptionalFeatures.Count(s => s.StartsWith("agonizing-blast/", StringComparison.Ordinal)));
        Check.True(grown.Features.Contains("agonizing-blast/eldritch-blast") && grown.Features.Contains("agonizing-blast/poison-spray"));
        var duplicate = AdvancementSpellChangeTests.Set(draft, "optional:EI", "armor-of-shadows", "agonizing-blast/eldritch-blast", "agonizing-blast/eldritch-blast");
        Check.Throws<GameException>(() => AdvancementEngine.Evaluate(c, duplicate, 20));
        var thirdDraft = AdvancementTests.Complete(grown, subclass: "warlock:fiend");
        var replacement = AdvancementSpellChangeTests.Set(thirdDraft, "optional:EI", "armor-of-shadows", "agonizing-blast/eldritch-blast", "repelling-blast/poison-spray");
        var third = AdvancementEngine.Evaluate(grown, replacement, 20).Character!;
        Check.True(third is not null); Check.True(!third!.Features.Contains("agonizing-blast/poison-spray"));
        Check.True(third.Features.Contains("repelling-blast/poison-spray"));
        var tooMany = AdvancementEngine.Evaluate(grown, AdvancementSpellChangeTests.Set(thirdDraft, "optional:EI",
            "eldritch-mind", "repelling-blast/eldritch-blast", "agonizing-blast/poison-spray"), 20);
        Check.True(!tooMany.CanApply && tooMany.Issues.Any(i => i.Code == "replacement_limit"));
        var reopened = JsonSerializer.Deserialize<Character>(JsonSerializer.Serialize(third))!;
        Check.Equal(JsonSerializer.Serialize(third.Advancement), JsonSerializer.Serialize(AdvancementEngine.State(reopened)));
        var bad = third with { Advancement = third.Advancement! with { Classes = third.Advancement.Classes.Select(s => s with
        { OptionalFeatures = ["armor-of-shadows/eldritch-blast", "agonizing-blast/eldritch-blast", "repelling-blast/poison-spray"] }).ToArray() } };
        Check.Throws<GameException>(() => AdvancementEngine.State(bad));
        return Task.CompletedTask;
    }

    public static Task BindingEligibilityUsesCurrentWarlockCantrips()
    {
        var touch = Warlock("chill-touch", "thunderclap");
        var options = AdvancementEngine.Evaluate(touch, new() { ClassId = "warlock" }, 20).Groups.Single(g => g.Key == "optional:EI").Options;
        Check.True(options.Any(o => o.Id == "repelling-blast/chill-touch"));
        Check.True(!options.Any(o => o.Id.StartsWith("eldritch-spear/", StringComparison.Ordinal)));
        Check.True(!options.Any(o => o.Id == "repelling-blast/thunderclap"));
        var c = Warlock("eldritch-blast", "mind-sliver");
        var draft = Two(c, "armor-of-shadows", "eldritch-spear/eldritch-blast", "eldritch-spear/mind-sliver");
        var grown = AdvancementEngine.Evaluate(c, draft, 20).Character!;
        Check.True(grown is not null);
        var third = AdvancementTests.Complete(grown!, subclass: "warlock:fiend");
        // Removing a known cantrip cannot leave the old invocation attached to a spell
        // from another source, even if a racial/feat spell has the same display name.
        var changedSpells = AdvancementSpellChangeTests.Set(third, "spells:cantrips", "eldritch-blast", "poison-spray");
        Check.True(!AdvancementEngine.Evaluate(grown!, changedSpells, 20).CanApply);
        var changedBoth = AdvancementSpellChangeTests.Set(changedSpells, "optional:EI", "armor-of-shadows", "eldritch-spear/eldritch-blast", "eldritch-spear/poison-spray");
        var result = AdvancementEngine.Evaluate(grown!, changedBoth, 20);
        Check.True(result.CanApply); Check.True(result.Character!.Advancement!.Classes.Single().OptionalFeatures.Contains("eldritch-spear/poison-spray"));
        var forged = AdvancementSpellChangeTests.Set(draft, "optional:EI", "armor-of-shadows", "repelling-blast/mind-sliver", "eldritch-spear/eldritch-blast");
        Check.True(!AdvancementEngine.Evaluate(c, forged, 20).CanApply);
        return Task.CompletedTask;
    }

    public static Task LegacySingleBindingRemainsReadable()
    {
        var c = Warlock("eldritch-blast", "poison-spray");
        var grown = AdvancementEngine.Evaluate(c, Two(c, "armor-of-shadows", "eldritch-mind", "agonizing-blast/eldritch-blast"), 20).Character!;
        var cls = grown.Advancement!.Classes.Single();
        var legacy = grown with { Advancement = grown.Advancement with { Classes = [cls with
        {
            OptionalFeatures = ["armor-of-shadows", "eldritch-mind", "agonizing-blast"],
            Choices = [..cls.Choices!, new("optional:agonizing-blast:cantrip", ["eldritch-blast"])]
        }] }, Features = grown.Features.Select(f => f == "agonizing-blast/eldritch-blast" ? "agonizing-blast" : f).ToArray() };
        string original = JsonSerializer.Serialize(legacy);
        Check.True(AdvancementEngine.State(legacy).Classes.Single().OptionalFeatures.Contains("agonizing-blast"));
        var next = AdvancementTests.Level(legacy, subclass: "warlock:fiend");
        Check.Equal(original, JsonSerializer.Serialize(legacy));
        Check.True(next.Advancement!.Classes.Single().OptionalFeatures.Contains("agonizing-blast/eldritch-blast"));
        Check.True(!next.Advancement.Classes.Single().Choices!.Any(s => s.Key == "optional:agonizing-blast:cantrip"));
        Check.Equal(JsonSerializer.Serialize(legacy.Advancement!.Steps), JsonSerializer.Serialize(next.Advancement.Steps.Take(1)));
        return Task.CompletedTask;
    }
}
