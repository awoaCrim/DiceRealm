using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementTests
{
    private static void Equal<T>(T expected, T actual, string message = "") => Check.True(EqualityComparer<T>.Default.Equals(expected, actual), message + $" Expected {expected}; got {actual}.");
    // Consume public groups like a UI; no second implementation of progression rules.
    internal static AdvancementDraft Complete(Character c, string? classId = null, string subclass = "", Func<BuildGroup, string[]?>? pick = null)
    {
        var draft = new AdvancementDraft { ClassId = classId ?? c.Build!.ClassId, SubclassId = subclass };
        for (int pass = 0; pass < 150; pass++)
        {
            var result = AdvancementEngine.Evaluate(c, draft, 20);
            if (result.CanApply) return draft;
            var group = result.Groups.FirstOrDefault(g => !g.Complete);
            if (group is null) throw new Exception($"{draft.ClassId}/{subclass} level {c.Level + 1}: " + JsonSerializer.Serialize(result.Issues));
            var explicitPick = pick?.Invoke(group);
            var prior = group.Selected.Where(id => group.Options.Any(o => o.Id == id)).ToArray();
            var options = group.Options.OrderByDescending(o => o.Id == "ability-score-improvement")
                .ThenBy(o => o.Id == "lessons-of-the-first-ones")
                .ThenBy(o => o.Id is "agonizing-blast" or "eldritch-spear" or "repelling-blast")
                .ThenByDescending(o => group.Key.StartsWith("spellbook:") || group.Key.StartsWith("additional:")
                    ? AdvancementCatalog.Get().Spells.SingleOrDefault(s => s.Id == o.Id)?.Level ?? 0 : 0).ToArray();
            var values = explicitPick ?? prior.Concat(options.Select(o => o.Id)).Distinct().Take(group.Count).ToArray();
            Check.True(group.Count == values.Length, "Insufficient choices: " + group.Key);
            if (group.Key == "subclass") draft = draft with { SubclassId = values[0] };
            else draft = draft with { Selections = [..draft.Selections.Where(s => s.Key != group.Key), new(group.Key, values)] };
        }
        throw new Exception("Advancement choice dependency loop: " + classId + "/" + c.Level);
    }
    internal static Character Level(Character c, string? classId = null, string subclass = "", Func<BuildGroup, string[]?>? pick = null)
        => AdvancementEngine.Evaluate(c, Complete(c, classId, subclass, pick), 20).Character!;
    public static Task CatalogAndPureProgression()
    {
        var data = AdvancementCatalog.Get();
        Equal(12, data.Classes.Length); Equal(48, data.Subclasses.Length); Equal(391, data.Spells.Length);
        Equal(355000, data.Experience[19]); Equal(4, data.FullCasterSlots[17][0]);
        Check.True(data.Evidence.All(e => e.Sha256.Length == 64));
        foreach (var classId in new[] { "fighter", "wizard" })
        {
            var c = BuildEvaluator.Create(FullCreationTests.Complete(classId, "dwarf", "farmer"));
            c = PlayResources.Ensure(c) with { HitPoints = c.MaxHitPoints - 3, TemporaryHitPoints = 4 };
            string originalBuild = JsonSerializer.Serialize(c.Build);
            for (int level = 2; level <= 20; level++)
            {
                var before = JsonSerializer.Serialize(c);
                string sub = level == 3 ? (classId == "fighter" ? "fighter:champion" : "wizard:evoker") : "";
                var draft = Complete(c, subclass: sub);
                var preview = AdvancementEngine.Evaluate(c, draft, 20);
                Equal(before, JsonSerializer.Serialize(c), "Preview must not change the source character");
                Check.True(preview.CanApply); c = preview.Character!;
                Equal(level, c.Level); Equal(level - 1, c.Advancement!.Steps.Length);
                Equal(3, c.MaxHitPoints - c.HitPoints); Equal(4, c.TemporaryHitPoints);
                Equal(originalBuild, JsonSerializer.Serialize(c.Build));
                Equal(data.Proficiency[level - 1], c.ProficiencyBonus);
                Equal(level, c.Resources.Single(r => r.Name == CharacterEngine.HitDie(c)).Maximum);
                Check.True(!AdvancementEngine.Evaluate(c, new() { ClassId = classId }, c.Level).CanApply);
            }
            Check.True(!AdvancementEngine.Evaluate(c, new() { ClassId = classId }, 20).CanApply);
            if (classId == "wizard")
            {
                Equal(1, c.Resources.Single(r => r.Name == "Spell Slots (9th)").Maximum);
                Equal(2, c.Advancement!.Classes[0].BonusSpells!.Count(s => s.Mode == "mastery"));
                Equal(2, c.Advancement.Classes[0].BonusSpells!.Count(s => s.Mode == "signature"));
            }
        }
        return Task.CompletedTask;
    }
    public static Task AllSubclassProgressions()
    {
        var failures = new List<string>();
        foreach (var sub in AdvancementCatalog.Get().Subclasses)
        {
            var c = BuildEvaluator.Create(FullCreationTests.Complete(sub.ClassId, "human", "sage"));
            try
            {
                for (int level = 2; level <= 20; level++) c = Level(c, subclass: level == 3 ? sub.Id : "");
                Equal(20, c.Level); Equal(sub.Id, c.Advancement!.Classes[0].SubclassId);
            }
            catch (Exception ex) { failures.Add(sub.Id + " @ " + (c.Level + 1) + ": " + ex.Message); }
        }
        Check.True(failures.Count == 0, string.Join(Environment.NewLine, failures));
        return Task.CompletedTask;
    }
    public static Task MulticlassAndPreservation()
    {
        var fighter = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("fighter", "dwarf", "farmer")));
        fighter = fighter with { HitPoints = 0, Resources = fighter.Resources.Select(r => r with { Current = 0 }).ToArray() };
        int hp = fighter.MaxHitPoints;
        var second = Level(fighter);
        Equal(0, second.HitPoints);
        Equal(6 + CharacterEngine.Ability(fighter, "constitution") + 1 + 2, second.MaxHitPoints - hp, "Fixed d10, dwarf, Tough");
        Equal(1, second.Resources.Single(r => r.Name == "Hit Dice (d10)").Current);
        Equal(0, second.Resources.Single(r => r.Name == "Second Wind").Current);
        Equal(1, second.Resources.Single(r => r.Name == "Action Surge").Current);
        Check.True(!AdvancementEngine.Evaluate(second, new() { ClassId = "wizard" }, 20).CanApply, "INT prerequisite is not met");
        var qualified = second with { Abilities = second.Abilities.Select(a => a with { Score = 16, Modifier = 3 }).ToArray() };
        var wizard = Level(qualified, "wizard");
        Equal(3, wizard.Level); Equal(1, wizard.Advancement!.Classes.Single(s => s.ClassId == "wizard").Level);
        Equal(2, wizard.Resources.Single(r => r.Name == "Spell Slots (1st)").Maximum);
        Equal(1, wizard.Resources.Single(r => r.Name == "Hit Dice (d6)").Maximum);
        Equal(JsonSerializer.Serialize(qualified.Inventory), JsonSerializer.Serialize(wizard.Inventory));
        Equal(JsonSerializer.Serialize(qualified.BuildMechanics!.Saves), JsonSerializer.Serialize(wizard.BuildMechanics!.Saves));
        AdvancementClass C(string id, int level, string sub = "") => new(id, level, sub, [], [], [], []);
        Equal(3, AdvancementCatalog.SharedSlots([C("wizard", 1), C("paladin", 1)])[0], "Half caster rounds up");
        Equal(0, AdvancementCatalog.SharedSlots([C("warlock", 4)])[0], "Pact is not a shared slot");
        Equal(2, AdvancementCatalog.SharedSlots([C("wizard", 1), C("warlock", 4)])[0]);
        Equal(3, AdvancementCatalog.SharedSlots([C("wizard", 1), C("fighter", 5, "fighter:eldritch-knight")])[0], "Third caster rounds down");
        Equal(1, AdvancementCatalog.MaximumSpellLevel(C("wizard", 1)), "Shared slots cannot grant higher-level spells");
        return Task.CompletedTask;
    }
}
