using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class NaturalActionTests
{
    internal static Campaign Fixture(string cls = "fighter", string species = "dwarf")
    {
        var c = TestContent.Campaign("harbor");
        c.Character = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete(cls, species, "sage")));
        c.Character = c.Character with { HitPoints = 1 }; return c;
    }
    private static CharacterPlayRequest Command(string key) => new(Id(), 1, "execute", key);
    private static void Reject(Campaign c, CharacterPlayEngine engine, string key)
    {
        string before = HarnessJson.Serialize(c); Check.Throws<GameException>(() => engine.Resolve(c, Command(key)));
        Check.Equal(before, HarnessJson.Serialize(c));
    }
    public static Task SheetEffectsAndRecordingCompatibility()
    {
        var c = Fixture("cleric");
        c.Adventure = c.Adventure! with { Items = [..c.Adventure.Items, new("healing-draught", "Healing Draught", NaturalActions.HealingPotion)] };
        c.Character = c.Character.Required() with { Inventory = [..c.Character.Required().Inventory, new("healing-draught", "Healing Draught", 1, false), new("red-liquid", "Potion of Healing", 1, false)] };
        string before = HarnessJson.Serialize(c);
        var sheet = CharacterPlayEngine.View(c); var choices = NaturalActions.Choices(c);
        Check.Equal(before, HarnessJson.Serialize(c)); Check.Equal(choices.Length, sheet.Effects!.Length);
        foreach (var choice in choices)
        {
            var effect = sheet.Effects.Single(e => e.Key == choice.Key);
            Check.Equal(choice.Label, effect.Label); Check.Equal(choice.ItemId, effect.ItemId); Check.Equal(choice.SpellSource, effect.SpellSource);
            Check.Equal(HarnessJson.Serialize(NaturalActions.Details(choice)), HarnessJson.Serialize(effect.Details));
            if (effect.SpellSource != "") Check.True(sheet.Spells.Any(s => s.Id == effect.SpellSource));
        }
        Check.True(sheet.Effects.Any(e => e.ItemId == "healing-draught")); Check.True(!sheet.Effects.Any(e => e.ItemId == "red-liquid"));
        var old = ActionUnderstanding.Candidates(c); var current = ActionUnderstanding.Candidates(c, includeRecording: false);
        Check.True(old.Any(a => a.Character?.Operation == "use"));
        Check.True(!current.Any(a => a.Character?.Operation is "use" or "spell" or "feature"));
        Check.True(current.Any(a => a.Character?.Operation == "execute")); Check.Equal(before, HarnessJson.Serialize(c));
        Check.Equal("70e2203d3e22fa6c040d1c5d29eab59369e1a901837edbf0acfa2b3d20550849", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(11))));
        Check.True(HarnessTools.Supports(12));
        Check.True(HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(12))) != HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(11))));
        return Task.CompletedTask;
    }
    public static Task AbilitiesItemsAndFrozenCommands()
    {
        var dice = new SequenceDice(4, 3, 2, 1, 2); var engine = new CharacterPlayEngine(new(dice)); var c = Fixture();
        string before = HarnessJson.Serialize(c); var options = NaturalActions.Choices(c);
        Check.Equal(before, HarnessJson.Serialize(c)); Check.Equal(0, dice.Count);
        Check.True(options.Any(x => x.Key == "second-wind"));
        var result = engine.Resolve(c, Command("second-wind"));
        Check.Equal(6, c.Character.Required().HitPoints); Check.Equal(1, CharacterEngine.Value(c.Character.Required(), "Second Wind")); Check.Equal(1, dice.Count);
        Check.Equal(0, c.PendingRulings.Count); Check.Equal(6L, c.ElapsedSeconds); Check.True(result.Summary.Contains("1d10 [4]"));
        c = Fixture("paladin"); c.Character = c.Character.Required() with { Conditions = ["Poisoned"] };
        engine.Resolve(c, Command("lay-on-hands/poison")); Check.Equal(1, dice.Count); Check.Equal(1, c.Character.HitPoints);
        Check.True(!c.Character.Conditions.Contains("Poisoned")); Check.Equal(0, CharacterEngine.Value(c.Character, "Lay on Hands"));
        Reject(c, engine, "lay-on-hands/1");
        c = Fixture("paladin"); engine.Resolve(c, Command("lay-on-hands/3"));
        Check.Equal(4, c.Character.Required().HitPoints); Check.Equal(2, CharacterEngine.Value(c.Character.Required(), "Lay on Hands"));
        c = Fixture("fighter", "aasimar"); engine.Resolve(c, Command("healing-hands"));
        Check.Equal(6, c.Character.Required().HitPoints); Check.Equal(3, dice.Count); Check.Equal(0, CharacterEngine.Value(c.Character.Required(), "Healing Hands"));
        Reject(c, engine, "healing-hands");
        c = Fixture(); c.Character = c.Character.Required() with { Inventory = [..c.Character.Required().Inventory, new("medicine", "治疗药水", 1, false)] };
        Reject(c, engine, "item/medicine"); // a plausible name is not a rule identity
        c.Adventure = c.Adventure! with { Items = [..c.Adventure.Items, new("medicine", "治疗药水", NaturalActions.HealingPotion)] };
        ContentValidator.Validate(c.Adventure); engine.Resolve(c, Command("item/medicine"));
        Check.Equal(6, c.Character.HitPoints); Check.Equal(5, dice.Count); Check.True(!c.Character.Inventory.Any(i => i.Id == "medicine"));
        Reject(c, engine, "item/medicine");
        Check.Throws<GameException>(() => ContentValidator.Validate(c.Adventure with { Items = [new("false", "药水", "xdmg:potion-of-supreme-healing")] }));
        Check.True(!HarnessJson.Serialize(new ContentItem("legacy", "旧物品")).Contains("rulesId"));
        c = Fixture(); before = HarnessJson.Serialize(c.Character.Required().Resources);
        engine.Resolve(c, new(Id(), 1, "use", c.Character.Inventory[0].Id));
        Check.Equal(before, HarnessJson.Serialize(c.Character.Resources)); Check.Equal(1, c.PendingRulings.Count); Check.Equal(5, dice.Count);
        c.Character = c.Character with { Conditions = ["Incapacitated"] }; Reject(c, engine, "second-wind");
        Check.Equal("1adde70c276a586a72a1be091e7fd7af5f237ee07ebc2496cf0a69ad2a6426e4", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(7))));
        Check.True(HarnessTools.Supports(8));
        return Task.CompletedTask;
    }
    private static Character Healer()
    {
        var build = FullCreationTests.Complete("cleric", "dwarf", "sage");
        build = build with { PreparedSpells = new[] { "cure-wounds", "healing-word" }.Concat(build.PreparedSpells).Distinct().Take(build.PreparedSpells.Length).ToArray() };
        return PlayResources.Ensure(BuildEvaluator.Create(build));
    }
    public static Task SpellsSourcesAndClassScaling()
    {
        var c = Fixture(); c.Character = Healer() with { HitPoints = 1 };
        var dice = new SequenceDice(2, 3); var engine = new CharacterPlayEngine(new(dice));
        var cure = NaturalActions.Choices(c).First(o => o.Key.Contains("cure-wounds") && o.Resource == "Spell Slots (1st)");
        int modifier = CharacterEngine.Ability(c.Character, "wisdom");
        engine.Resolve(c, Command(cure.Key));
        Check.Equal(1 + Math.Max(0, 5 + modifier), c.Character.HitPoints); Check.Equal(2, dice.Count);
        Check.Equal(1, CharacterEngine.Value(c.Character, "Spell Slots (1st)")); Check.Equal(0, c.PendingRulings.Count);
        c.Character = c.Character with { HitPoints = 1, Inventory = c.Character.Inventory.Select(i => i.Id == "mace" ? i with { Equipped = true } : i).ToArray() };
        Check.True(NaturalActions.Choices(c).Any(x => x.Key.Contains("cure-wounds"))); // one weapon is not both hands
        if (!c.Character.Inventory.Any(i => i.Id == "shield")) c.Character = c.Character with { Inventory = [.. c.Character.Inventory, new("shield", "Shield", 1, false)] };
        c.Character = EquipmentLoadout.Commit(c.Character, EquipmentLoadout.Read(c.Character) with { MeleeMainHandId = "mace", MeleeOffHandId = "shield", MeleeGrip = "one" });
        Check.True(!NaturalActions.Choices(c).Any(x => x.Key.Contains("cure-wounds")));
        c.Character = c.Character with { Conditions = ["Blinded"] };
        Check.True(!NaturalActions.Choices(c).Any(x => x.Key.Contains("healing-word")));
        var cleric = Healer();
        for (int i = 2; i <= 17; i++) cleric = AdvancementTests.Level(cleric, subclass: i == 3 ? "cleric:life" : "");
        cleric = PlayResources.LongRest(cleric) with { HitPoints = 1 }; c.Character = cleric;
        var ninth = NaturalActions.Choices(c).First(o => o.Key.Contains("cure-wounds") && o.Resource == "Spell Slots (9th)");
        Check.True(ninth.Maximize); Check.Equal(18, ninth.Dice); Check.Equal(8, ninth.Die);
        Check.Equal(CharacterEngine.Ability(cleric, "wisdom") + 11, ninth.Bonus);
        engine.Resolve(c, Command(ninth.Key)); Check.Equal(2, dice.Count); // Supreme Healing does not roll
        Check.Equal(0, CharacterEngine.Value(c.Character, "Spell Slots (9th)"));
        Check.Equal(Math.Min(cleric.MaxHitPoints, 1 + 144 + ninth.Bonus), c.Character.HitPoints);
        // Restoration cures exactly the selected condition, not all recorded conditions.
        c.Character = c.Character with { Conditions = ["Blinded", "Poisoned"], PlayState = c.Character.PlayState! with { PreparationOpen = true, PreparedClasses = [] } };
        // Life Domain grants Lesser Restoration; it must not occupy a class preparation slot.
        var restore = NaturalActions.Choices(c).First(o => o.Condition == "Blinded" && o.Key.Contains("lesser-restoration"));
        engine.Resolve(c, Command(restore.Key)); Check.True(!c.Character.Conditions.Contains("Blinded") && c.Character.Conditions.Contains("Poisoned"));
        Check.Equal(2, dice.Count);
        // Total level must never substitute for the actual Fighter class level.
        c = Fixture(); var fighter = c.Character.Required() with { Abilities = c.Character.Required().Abilities.Select(a => a with { Score = 16, Modifier = 3 }).ToArray() };
        fighter = AdvancementTests.Level(fighter, "wizard"); c.Character = fighter;
        Check.Equal(2, fighter.Level); Check.Equal(1, NaturalActions.Choices(c).Single(o => o.Key == "second-wind").Bonus);
        return Task.CompletedTask;
    }
    internal static Campaign StoryFixture()
    {
        var c = Fixture(); var action = new ContentAction { Id = "settle-check", Kind = "script.settle", Target = "clue", Label = "核对线索后的公开后果",
            Check = new("intelligence", "Investigation", 12), Success = new("查明通行事实并领取一次奖励。", [new("fact", "known-path"), new("item", "medal", 1)]),
            Failure = new("保留失败结果。", [new("fact", "known-failure")]) };
        c.Adventure = c.Adventure! with { Items = [..c.Adventure.Items, new("medal", "信物")], Scenes = c.Adventure.Scenes.Select(s => s.Id == "harbor" ? s with { Actions = [action] } : s).ToArray() };
        c.PendingIntents.Add(new() { Id = "root", ActorId = "player", Text = "核对线索", RootSequence = 2, Published = true, Status = "completed" });
        c.PendingRulings.Add(new("ruling", "核对线索", "resolved", "需检查", "player", "harbor", Outcome: "check", OriginSequence: 2,
            Check: new("intelligence", "Investigation", [15], 15, 1, 16, 12, true, "normal")));
        return c;
    }
    public static Task VerifiedConsequencesStayWithinRoot()
    {
        var c = StoryFixture(); string before = HarnessJson.Serialize(c);
        var choices = VerifiedStoryConsequences.Choices(c, "root"); Check.Equal(1, choices.Length); Check.Equal(before, HarnessJson.Serialize(c));
        Check.Equal(0, VerifiedStoryConsequences.Choices(c, "unrelated").Length);
        c.ActingActorId = "foreign"; Check.Equal(0, VerifiedStoryConsequences.Choices(c, "root").Length); c.ActingActorId = "player";
        var plan = choices[0].Plan; var result = VerifiedStoryConsequences.Apply(c, plan, "root", Id());
        Check.True(c.Facts.Contains("known-path")); Check.Equal(1, c.Character.Required().Inventory.Single(i => i.Id == "medal").Quantity);
        Check.True(c.PendingRulings[0].Story is not null); Check.Equal(15, c.PendingRulings[0].Check!.Selected); Check.True(result.Check is null);
        Check.Equal(0, VerifiedStoryConsequences.Choices(c, "root").Length);
        Check.Throws<GameException>(() => VerifiedStoryConsequences.Apply(c, plan, "root", Id()));
        c = StoryFixture(); c.PendingRulings[0] = c.PendingRulings[0] with { Check = c.PendingRulings[0].Check! with { Selected = 1, Total = 2, Success = false } };
        VerifiedStoryConsequences.Apply(c, plan, "root", Id()); Check.True(c.Facts.Contains("known-failure") && !c.Facts.Contains("known-path"));
        Check.True(!c.Character.Required().Inventory.Any(i => i.Id == "medal"));
        foreach (string mutation in new[] { "dc", "scene", "effect", "cost", "closed", "actor" })
        {
            c = StoryFixture();
            if (mutation == "dc") c.PendingRulings[0] = c.PendingRulings[0] with { Check = c.PendingRulings[0].Check! with { Dc = 13 } };
            if (mutation == "scene") c.SceneId = "causeway";
            if (mutation == "effect") c.PendingRulings[0] = c.PendingRulings[0] with { EffectsRequestId = Id() };
            if (mutation == "actor") c.PendingRulings[0] = c.PendingRulings[0] with { ActorId = "foreign" };
            if (mutation == "closed") c.CompletedContentActions.Add("settle-check");
            if (mutation == "cost") c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s.Id == "harbor" ? s with { Actions = s.Actions.Select(a => a with { Always = [new("item", "medal", -1)] }).ToArray() } : s).ToArray() };
            Check.Equal(0, VerifiedStoryConsequences.Choices(c, "root").Length); before = HarnessJson.Serialize(c);
            Check.Throws<GameException>(() => VerifiedStoryConsequences.Apply(c, plan, "root", Id())); Check.Equal(before, HarnessJson.Serialize(c));
        }
        return Task.CompletedTask;
    }
}
