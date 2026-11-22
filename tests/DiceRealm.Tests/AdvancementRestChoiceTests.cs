using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementRestChoiceTests
{
    internal static CharacterBuild HighElfBuild() => FullCreationTests.Complete("wizard", "elf", "sage") with
    {
        Selections = FullCreationTests.Complete("wizard", "elf", "sage").Selections.Select(s =>
            s.Key == "species:elf/lineage" ? s with { Values = ["high-elf"] }
            : s.Key.StartsWith("species:elf/lineage:drow/", StringComparison.Ordinal) ? s with { Key = s.Key.Replace("lineage:drow/", "lineage:high-elf/", StringComparison.Ordinal) } : s).ToArray()
    };
    internal static Campaign Campaign(Character ch)
    {
        var c = TestContent.Campaign("harbor"); c.Character = PlayResources.Ensure(ch); return c;
    }
    internal static void Choose(Campaign c, string key, params string[] selected) => new CharacterPlayEngine(new RulesEngine(new SequenceDice()))
        .Resolve(c, new(Guid.NewGuid().ToString(), c.Version, "rest-choice", key, Choices: selected));
    private static string Json<T>(T value) => JsonSerializer.Serialize(value);
    public static Task LineageRestWindowAndSources()
    {
        var c = Campaign(BuildEvaluator.Create(HighElfBuild()));
        var original = Json(c.Character.Required().Build); string before = Json(c.Character.Required());
        var offered = CharacterPlayEngine.View(c).RestChoices!;
        Check.True(offered.Single().Key == AdvancementRestChoices.HighElf && !offered.Single().Available);
        Check.Equal(before, Json(c.Character));
        Check.Throws<GameException>(() => Choose(c, AdvancementRestChoices.HighElf, "acid-splash"));
        new CharacterEngine(new SequenceDice()).Resolve(c, "rest.long", "");
        var ch = c.Character;
        c.Character = ch with { HitPoints = ch.MaxHitPoints - 2, TemporaryHitPoints = 4,
            Resources = ch.Resources.Select(r => r with { Current = 0 }).ToArray() };
        string counters = Json(c.Character.Resources);
        var originalClassCantrips = c.Character.Build!.Cantrips.ToArray();
        Choose(c, AdvancementRestChoices.HighElf, "acid-splash");
        Check.Equal(original, Json(c.Character.Build)); Check.Equal(counters, Json(c.Character.Resources));
        Check.Equal(2, c.Character.MaxHitPoints - c.Character.HitPoints); Check.Equal(4, c.Character.TemporaryHitPoints);
        Check.True(c.Character.BuildMechanics!.SpellGrants.Any(g => g.Source == "species:elf/lineage:high-elf" && g.Id == "acid-splash"));
        Check.True(CharacterPlayEngine.SpellSources(c.Character).Any(s => s.Source == "class:wizard" && originalClassCantrips.Contains(s.SpellId)));
        Check.True(!CharacterPlayEngine.View(c).RestChoices!.Single().Available);
        Check.True(CharacterPlayEngine.View(c).Preparation.Available, "Rest selection must not consume the class preparation window");
        Check.Throws<GameException>(() => Choose(c, AdvancementRestChoices.HighElf, "blade-ward"));
        new CharacterPlayEngine(new RulesEngine(new SequenceDice())).Resolve(c, new("x", c.Version, "prepare", Choices: c.Character.PlayState!.PreparedSpells));
        Check.True(!c.Character.PlayState!.PreparationOpen);
        c.Character = JsonSerializer.Deserialize<Character>(Json(c.Character))!;
        AdvancementRestChoices.ValidateState(c);
        new CharacterEngine(new SequenceDice()).Resolve(c, "rest.wait", "");
        new CharacterEngine(new SequenceDice()).Resolve(c, "rest.long", "");
        new CharacterPlayEngine(new RulesEngine(new SequenceDice())).Resolve(c, new("x", c.Version, "prepare", Choices: c.Character.PlayState!.PreparedSpells));
        Check.True(CharacterPlayEngine.View(c).RestChoices!.Single().Available, "Preparing first must not discard lineage choice");
        Check.True(!CharacterPlayEngine.View(c).Preparation.Available, "Preparing cannot be repeated via an unspent lineage window");
        Choose(c, AdvancementRestChoices.HighElf, "blade-ward");
        Check.True(!c.Character.PlayState!.PreparationOpen);
        c.Character = PlayResources.LongRest(c.Character);
        new CharacterPlayEngine(new RulesEngine(new SequenceDice(10))).Resolve(c, new("x", c.Version, "check", "ability:intelligence"));
        Check.True(!CharacterPlayEngine.View(c).RestChoices!.Single().Available, "An unrelated action closes rest choices");
        c.Character = c.Character with { PlayState = c.Character.PlayState! with { RestChoicesUsed = ["invented"] } };
        Check.Throws<GameException>(() => AdvancementRestChoices.ValidateState(c));
        return Task.CompletedTask;
    }
    public static Task LandReplacementSurvivesLaterGrowth()
    {
        var ch = BuildEvaluator.Create(FullCreationTests.Complete("druid", "human", "sage"));
        for (int level = 2; level <= 5; level++) ch = AdvancementTests.Level(ch, subclass: level == 3 ? "druid:land" : "");
        var c = Campaign(PlayResources.LongRest(ch));
        string steps = Json(ch.Advancement!.Steps), build = Json(ch.Build), resources = Json(c.Character.Required().Resources);
        Choose(c, AdvancementRestChoices.Land, "1");
        var druid = c.Character.Advancement!.Classes.Single();
        Check.True(druid.BonusSpells!.Any(s => s.Id == "sleet-storm" && s.Origin == "subclass:druid:land"));
        Check.True(!druid.BonusSpells!.Any(s => s.Id is "burning-hands" or "fireball" && s.Origin == "subclass:druid:land"));
        Check.Equal(steps, Json(c.Character.Advancement.Steps)); Check.Equal(build, Json(c.Character.Build));
        Check.Equal(resources, Json(c.Character.Resources));
        Check.Throws<GameException>(() => Choose(c, AdvancementRestChoices.Land, "2"));
        c.Character = JsonSerializer.Deserialize<Character>(Json(c.Character))!;
        c.Character = AdvancementTests.Level(AdvancementTests.Level(c.Character));
        druid = c.Character.Advancement!.Classes.Single();
        Check.True(druid.BonusSpells!.Any(s => s.Id == "ice-storm") && !druid.BonusSpells!.Any(s => s.Id == "blight"), "Future schedules must use the rest-selected land");
        c.Character = PlayResources.LongRest(c.Character);
        var before = Json(c.Character); Check.Throws<GameException>(() => Choose(c, AdvancementRestChoices.Land, "999")); Check.Equal(before, Json(c.Character));
        return Task.CompletedTask;
    }
    public static Task MasteryOneSpellAndIndependentResistances()
    {
        var wizard = BuildEvaluator.Create(FullCreationTests.Complete("wizard", "human", "sage"));
        while (wizard.Level < 18) wizard = AdvancementTests.Level(wizard, subclass: wizard.Level == 2 ? "wizard:evoker" : "");
        var c = Campaign(PlayResources.LongRest(wizard));
        var offered = CharacterPlayEngine.View(c).RestChoices!.Single(s => s.Key == AdvancementRestChoices.Mastery);
        Check.Equal(1, offered.Count);
        var option = offered.Options.First(o => o.Id != "keep");
        var old = c.Character.Required().Advancement!.Classes.Single().BonusSpells!.Where(s => s.Mode == "mastery").ToArray();
        var before = Json(c.Character);
        Check.Throws<GameException>(() => Choose(c, AdvancementRestChoices.Mastery, option.Id, offered.Options.Last().Id));
        Check.Throws<GameException>(() => Choose(c, AdvancementRestChoices.Mastery, "1/shield")); // Reaction casting, not action.
        Check.Equal(before, Json(c.Character));
        Choose(c, AdvancementRestChoices.Mastery, option.Id);
        var changed = c.Character.Advancement!.Classes.Single().BonusSpells!.Where(s => s.Mode == "mastery").ToArray();
        Check.Equal(1, old.Count(s => !changed.Contains(s))); Check.Equal(1, changed.Count(s => !old.Contains(s)));
        Check.True(CharacterPlayEngine.SpellSources(c.Character).Any(s => s.SpellId == option.Id.Split('/')[1] && s.Id.EndsWith("/mastery", StringComparison.Ordinal)));
        Check.Throws<GameException>(() => Choose(c, AdvancementRestChoices.Mastery, "keep"));
        c.Character = PlayResources.LongRest(c.Character);
        Choose(c, AdvancementRestChoices.Mastery, "keep");
        Check.Equal(Json(changed), Json(c.Character.Advancement!.Classes.Single().BonusSpells!.Where(s => s.Mode == "mastery").ToArray()));

        var build = FullCreationTests.Complete("fighter", "tiefling", "soldier"); // Abyssal gives independent Poison resistance.
        var fighter = BuildEvaluator.Create(build);
        while (fighter.Level < 18) fighter = AdvancementTests.Level(fighter, subclass: fighter.Level == 2 ? "fighter:champion" : "");
        fighter = AdvancementTests.Level(fighter, pick: g => g.Key == "feat" ? ["boon-of-energy-resistance"] : g.Key == "feat:resistance" ? ["poison", "fire"] : null);
        c = Campaign(PlayResources.LongRest(fighter));
        string original = Json(c.Character.Required().Advancement!.Steps), counters = Json(c.Character.Required().Resources);
        Choose(c, AdvancementRestChoices.Energy, "cold", "acid");
        Check.True(c.Character.BuildMechanics!.Resistances.Order().SequenceEqual(new[] { "acid", "cold", "poison" }));
        Check.Equal(original, Json(c.Character.Advancement!.Steps)); Check.Equal(counters, Json(c.Character.Resources));
        c.Character = AdvancementTests.Level(c.Character);
        Check.True(c.Character.BuildMechanics!.Resistances.Contains("poison") && !c.Character.BuildMechanics.Resistances.Contains("fire"));
        return Task.CompletedTask;
    }
}
