using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementStateTests
{
    public static Task RejectsEarlySpellsAndSubclassHistoryChanges()
    {
        var c = AdvancementSpellChangeTests.Qualified(BuildEvaluator.Create(FullCreationTests.Complete("wizard", "dwarf", "sage")));
        c = AdvancementTests.Level(c, "cleric");
        c = AdvancementTests.Level(c, "cleric");
        // Shared second-level slots do not grant a Wizard-1 or Cleric-2 a second-level spell.
        Check.True(c.Resources.Any(r => r.Name == "Spell Slots (2nd)"));
        var wizard = c.Advancement!.Classes.Single(s => s.ClassId == "wizard");
        void Reject(Character value)
        {
            string before = JsonSerializer.Serialize(value);
            try { AdvancementEngine.State(value); throw new Exception("Corrupt progression was accepted"); }
            catch (GameException ex) { Check.Equal("invalid_advancement_state", ex.Code); }
            Check.Equal(before, JsonSerializer.Serialize(value));
        }
        Character Change(AdvancementClass cls) => c with { Advancement = c.Advancement! with
        { Classes = c.Advancement.Classes.Select(s => s.ClassId == cls.ClassId ? cls : s).ToArray() } };
        Reject(Change(wizard with { Spellbook = [..wizard.Spellbook, "misty-step"] }));
        Reject(Change(wizard with { PreparedSpells = ["misty-step", ..wizard.PreparedSpells.Skip(1)], Spellbook = [..wizard.Spellbook, "misty-step"] }));
        Reject(Change(wizard with { PreparedSpells = ["cure-wounds", ..wizard.PreparedSpells.Skip(1)] }));
        Reject(Change(wizard with { Cantrips = ["guidance", ..wizard.Cantrips.Skip(1)] }));
        string notInBook = AdvancementCatalog.Get().Spells.First(s => s.Level == 1 && s.Classes.Contains("wizard") && !wizard.Spellbook.Contains(s.Id)).Id;
        Reject(Change(wizard with { PreparedSpells = [notInBook, ..wizard.PreparedSpells.Skip(1)] }));
        Reject(c with { Advancement = c.Advancement with { SchemaVersion = 99 } });
        while (c.Level < 7) c = AdvancementTests.Level(c, "wizard", c.Advancement!.Classes.Single(s => s.ClassId == "wizard").Level == 2 ? "wizard:abjurer" : "");
        wizard = c.Advancement!.Classes.Single(s => s.ClassId == "wizard");
        Reject(Change(wizard with { SubclassId = "wizard:evoker" }));
        var steps = c.Advancement.Steps.ToArray();
        int index = Array.FindIndex(steps, s => s.ClassId == "wizard" && s.ClassLevel == 4);
        steps[index] = steps[index] with { SubclassId = "wizard:evoker" };
        Reject(c with { Advancement = c.Advancement with { Steps = steps } });
        steps = c.Advancement.Steps.ToArray();
        steps[0] = steps[0] with { Features = ["spell mastery|wizard|xphb|18"] };
        Reject(c with { Advancement = c.Advancement with { Steps = steps } });
        steps = c.Advancement.Steps.ToArray();
        int subclass = Array.FindIndex(steps, s => s.ClassId == "wizard" && s.ClassLevel == 3);
        steps[subclass] = steps[subclass] with { Choices = steps[subclass].Choices with { SubclassId = "wizard:evoker" } };
        Reject(c with { Advancement = c.Advancement with { Steps = steps } });
        Check.Equal(7, c.Level); Check.Equal("wizard:abjurer", AdvancementEngine.State(c).Classes.Single(s => s.ClassId == "wizard").SubclassId);
        return Task.CompletedTask;
    }
}
