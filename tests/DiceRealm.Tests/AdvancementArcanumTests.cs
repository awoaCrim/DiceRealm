using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementArcanumTests
{
    internal const string Key = "mystic-arcanum:replace";
    internal static Character Warlock(int level)
    {
        var c = AdvancementSpellChangeTests.Qualified(PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("warlock", "dwarf", "soldier"))));
        while (c.Level < level) c = AdvancementTests.Level(c, subclass: c.Level == 2 ? "warlock:fiend" : "");
        return c;
    }
    internal static AdvancementBonusSpell Arcanum(Character c, int level) => c.Advancement!.Classes.Single(s => s.ClassId == "warlock").BonusSpells!
        .Single(b => b.Origin == "class:warlock/arcanum:" + level);
    internal static AdvancementDraft Replace(Character c, int level = 6)
    {
        var old = Arcanum(c, level);
        string replacement = AdvancementCatalog.Get().Spells.First(s => s.Level == level && s.Classes.Contains("warlock") && s.Id != old.Id).Id;
        return AdvancementSpellChangeTests.Set(AdvancementSpellChangeTests.Set(AdvancementTests.Complete(c), Key, old.Origin), Key + ":replacement", replacement);
    }

    public static Task ReplacementPreservesSpentUsesAndHistory()
    {
        var c = Warlock(11); var old = Arcanum(c, 6);
        c = c with { HitPoints = c.MaxHitPoints - 7, TemporaryHitPoints = 3,
            Resources = c.Resources.Select(r => r.Name == AdvancementSheet.FreeSpell(old) || r.Name.StartsWith("Pact Slots", StringComparison.Ordinal) ? r with { Current = 0 } : r).ToArray() };
        string before = JsonSerializer.Serialize(c), build = JsonSerializer.Serialize(c.Build), steps = JsonSerializer.Serialize(c.Advancement!.Steps);
        var multiclass = AdvancementTests.Complete(c, "fighter");
        Check.True(!AdvancementEngine.Evaluate(c, multiclass, 20).Groups.Any(g => g.Key == Key));
        Check.True(!AdvancementEngine.Evaluate(c, AdvancementSpellChangeTests.Set(multiclass, Key, old.Origin), 20).CanApply);
        var draft = Replace(c); var view = AdvancementEngine.Evaluate(c, draft, 20);
        Check.True(view.CanApply, JsonSerializer.Serialize(view.Issues)); Check.Equal(before, JsonSerializer.Serialize(c));
        var next = view.Character!; var changed = Arcanum(next, 6);
        Check.True(changed.Id != old.Id); Check.Equal(old.Origin, changed.Origin);
        Check.Equal(0, next.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(changed)).Current);
        Check.True(!next.Resources.Any(r => r.Name == AdvancementSheet.FreeSpell(old)));
        Check.Equal(7, next.MaxHitPoints - next.HitPoints); Check.Equal(3, next.TemporaryHitPoints);
        Check.Equal(build, JsonSerializer.Serialize(next.Build)); Check.Equal(steps, JsonSerializer.Serialize(next.Advancement!.Steps.Take(10)));
        var routes = AdvancementSheet.Spells(next, "").Where(s => s.Source == old.Origin).ToArray();
        Check.Equal(1, routes.Length); Check.True(routes[0].Id.EndsWith("/free", StringComparison.Ordinal) && !routes[0].Available && routes[0].SpellId == changed.Id);
        Check.Equal(1, PlayResources.LongRest(next).Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(changed)).Current);
        next = JsonSerializer.Deserialize<Character>(JsonSerializer.Serialize(next))!;
        Check.Equal(12, AdvancementEngine.State(next).Classes.Single().Level);
        // Acquisition of the seventh-level arcanum and one old-source replacement coexist.
        var thirteenth = AdvancementEngine.Evaluate(next, Replace(next), 20).Character!;
        Check.Equal(0, thirteenth.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(Arcanum(thirteenth, 6))).Current);
        Check.Equal(1, thirteenth.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(Arcanum(thirteenth, 7))).Current);
        Check.Equal(13, thirteenth.Level);
        for (int target = 15; target <= 17; target += 2)
        {
            thirteenth = AdvancementTests.Level(thirteenth);
            thirteenth = AdvancementEngine.Evaluate(thirteenth, Replace(thirteenth), 20).Character!;
            Check.Equal(target, thirteenth.Level);
            Check.Equal(0, thirteenth.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(Arcanum(thirteenth, 6))).Current);
            Check.Equal(1, thirteenth.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(Arcanum(thirteenth, (target + 1) / 2))).Current);
        }
        var fighter = AdvancementTests.Level(c, "fighter");
        var resumed = AdvancementEngine.Evaluate(fighter, Replace(fighter), 20).Character!;
        Check.Equal(12, resumed.Advancement!.Classes.Single(s => s.ClassId == "warlock").Level);
        Check.Equal(0, resumed.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(Arcanum(resumed, 6))).Current);
        return Task.CompletedTask;
    }

    public static Task InvalidChoicesAndCorruptOwnershipAreRejected()
    {
        var c = Warlock(13); var old = Arcanum(c, 6); var draft = Replace(c); string before = JsonSerializer.Serialize(c);
        foreach (var bad in new[]
        {
            AdvancementSpellChangeTests.Set(draft, Key + ":replacement", old.Id),
            AdvancementSpellChangeTests.Set(draft, Key + ":replacement", Arcanum(c, 7).Id),
            AdvancementSpellChangeTests.Set(draft, Key + ":replacement", "heal"),
            AdvancementSpellChangeTests.Set(draft, Key, old.Origin, Arcanum(c, 7).Origin),
            AdvancementSpellChangeTests.Set(draft, Key, "keep"),
            AdvancementSpellChangeTests.Set(draft, Key, "class:warlock/arcanum:9")
        })
        {
            Check.True(!AdvancementEngine.Evaluate(c, bad, 20).CanApply); Check.Equal(before, JsonSerializer.Serialize(c));
        }
        var cls = c.Advancement!.Classes.Single();
        foreach (var bad in new[]
        {
            cls.BonusSpells!.Where(b => b != old).ToArray(), cls.BonusSpells!.Append(old with { Id = "arcane-gate" }).ToArray(),
            cls.BonusSpells!.Select(b => b == old ? b with { Mode = "known" } : b).ToArray(),
            cls.BonusSpells!.Select(b => b == old ? b with { Uses = 2 } : b).ToArray(),
            cls.BonusSpells!.Select(b => b == old ? b with { Recovery = "short" } : b).ToArray(),
            cls.BonusSpells!.Select(b => b == old ? b with { Ability = "int" } : b).ToArray(),
            cls.BonusSpells!.Select(b => b == old ? b with { Origin = "class:warlock/arcanum:9" } : b).ToArray()
        })
        {
            var corrupt = c with { Advancement = c.Advancement with { Classes = [cls with { BonusSpells = bad }] } };
            try { AdvancementEngine.State(corrupt); throw new Exception("Corrupt arcanum accepted"); }
            catch (GameException ex) { Check.Equal("invalid_advancement_state", ex.Code); }
        }
        return Task.CompletedTask;
    }

    public static Task CorruptCountersRejectKeepMulticlassAndLegacyReopens()
    {
        var c = Warlock(13); var spell = Arcanum(c, 6); var pool = c.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(spell));
        var drafts = new[] { AdvancementTests.Complete(c), AdvancementTests.Complete(c, "fighter"), Replace(c) };
        var counters = new[]
        {
            c.Resources.Where(r => r != pool).ToArray(), c.Resources.Append(pool).ToArray(),
            c.Resources.Select(r => r == pool ? r with { Maximum = 2 } : r).ToArray(),
            c.Resources.Select(r => r == pool ? r with { Current = 2 } : r).ToArray(),
            c.Resources.Select(r => r == pool ? r with { Current = -1 } : r).ToArray(),
            c.Resources.Select(r => r == pool ? r with { Recovery = "short" } : r).ToArray()
        };
        foreach (var resources in counters)
            foreach (var draft in drafts)
            {
                var corrupt = c with { Resources = resources }; string before = JsonSerializer.Serialize(corrupt);
                try { AdvancementEngine.Evaluate(corrupt, draft, 20); throw new Exception("Corrupt counter accepted"); }
                catch (GameException ex) { Check.Equal("invalid_advancement_state", ex.Code); }
                Check.Equal(before, JsonSerializer.Serialize(corrupt));
            }
        // Frozen from the earlier growth build, not produced by the current evaluator.
        var legacy = JsonSerializer.Deserialize<Character>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "advancement-warlock11-pre-arcanum.json")),
            new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        string original = JsonSerializer.Serialize(legacy);
        AdvancementEngine.ValidateResources(legacy); Check.Equal(11, AdvancementEngine.State(legacy).Classes.Single().Level);
        var next = AdvancementEngine.Evaluate(legacy, Replace(legacy), 20).Character!;
        Check.Equal(0, next.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(Arcanum(next, 6))).Current);
        Check.Equal(original, JsonSerializer.Serialize(legacy)); Check.Equal(3, next.MaxHitPoints - next.HitPoints);
        Check.Equal(JsonSerializer.Serialize(legacy.Advancement!.Steps), JsonSerializer.Serialize(next.Advancement!.Steps.Take(10)));
        return Task.CompletedTask;
    }
}
