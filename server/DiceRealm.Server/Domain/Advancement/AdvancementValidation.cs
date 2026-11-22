namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private static bool ValidDraft(AdvancementDraft? draft) => draft is not null && draft.Revision == BuildCatalog.Revision
        && draft.ClassId is { Length: > 0 and <= 32 } && draft.SubclassId is { Length: <= 80 }
        && draft.Selections is { Length: <= 128 } && ValidSelections(draft.Selections);
    private static bool ValidSelections(BuildSelection[] items) => items.All(s => s is not null && s.Key is { Length: > 0 and <= 512 }
        && !s.Key.Any(char.IsControl) && s.Values is { Length: <= 100 }
        && s.Values.All(v => v is { Length: > 0 and <= 512 } && !v.Any(char.IsControl))
        && s.Values.Distinct().Count() == s.Values.Length) && items.Select(s => s.Key).Distinct().Count() == items.Length;
    private static bool ValidState(Character c, CharacterAdvancement state)
    {
        var catalog = AdvancementCatalog.Get();
        if (c.Level is < 1 or > 20 || state.SchemaVersion != 1 || state.Revision != BuildCatalog.Revision
            || state.Classes is not { Length: > 0 and <= 12 } || state.Steps is null || state.Steps.Length != c.Level - 1) return false;
        bool SpellIds(string[]? ids, Func<AdvancementSpellData, bool> allowed) => ids is { Length: <= 391 }
            && ids.Distinct().Count() == ids.Length && ids.All(id => catalog.Spells.Any(s => s.Id == id && allowed(s)));
        foreach (var cls in state.Classes)
        {
            if (cls is null || cls.Level is < 1 or > 20 || !catalog.Classes.Any(s => s.Id == cls.ClassId)
                || cls.SubclassId is null || (cls.Level < 3 ? cls.SubclassId != "" : !catalog.Subclasses.Any(s => s.Id == cls.SubclassId && s.ClassId == cls.ClassId))
                || !SpellIds(cls.Cantrips, s => s.Level == 0) || !SpellIds(cls.PreparedSpells, s => s.Level > 0)
                || !SpellIds(cls.Spellbook, s => s.Level > 0 && s.Classes.Contains("wizard"))
                || cls.ClassId != "wizard" && cls.Spellbook.Length > 0
                || cls.OptionalFeatures is not { Length: <= 58 } || cls.OptionalFeatures.Distinct().Count() != cls.OptionalFeatures.Length
                || cls.OptionalFeatures.Any(id => !ValidOptional(cls, id))
                || cls.OptionalFeatures.Select(id => BoundIdentity(cls, id)).Distinct().Count() != cls.OptionalFeatures.Length
                || cls.Masteries is { Length: > 39 } || (cls.Masteries ?? []).Any(id => !BuildCatalog.Get().Equipment.Any(e => e.Id == id && e.Mastery.Length > 0))
                || cls.Choices is { Length: > 512 } || cls.Choices is not null && !ValidSelections(cls.Choices)
                || cls.BonusSpells is { Length: > 391 } || (cls.BonusSpells ?? []).Any(b => b is null || !catalog.Spells.Any(s => s.Id == b.Id)
                    || b.Mode is not ("known" or "prepared" or "innate" or "ritual" or "arcanum" or "mastery" or "signature" or "at-will")
                    || b.Mode == "at-will" && (cls.ClassId != "warlock" || !cls.OptionalFeatures.Any(id => InvocationSpell(id) == b))
                    || b.Origin is not { Length: > 0 and <= 200 } || b.Ability is null || b.Ability != "" && !BuildCatalog.Get().Abilities.Contains(b.Ability)
                    || b.Uses is < 0 or > 20 || b.Recovery is not ("long" or "short" or "") || b.Resource is null || b.Condition is null)) return false;
            string list = catalog.Subclasses.SingleOrDefault(s => s.Id == cls.SubclassId)?.CasterProgression == "1/3" ? "wizard" : cls.ClassId;
            int maximum = AdvancementCatalog.MaximumSpellLevel(cls);
            bool InList(AdvancementSpellData s) => s.Classes.Contains(list)
                || cls.ClassId == "bard" && cls.Level >= 10 && s.Classes.Any(id => id is "cleric" or "druid" or "wizard");
            if (!SpellIds(cls.Cantrips, s => s.Level == 0 && s.Classes.Contains(list))
                || !SpellIds(cls.PreparedSpells, s => s.Level <= maximum && InList(s) && (cls.ClassId != "wizard" || cls.Spellbook.Contains(s.Id)))
                || !SpellIds(cls.Spellbook, s => s.Level <= maximum && s.Classes.Contains("wizard"))
                || (cls.BonusSpells ?? []).DistinctBy(b => (b.Id, b.Origin, b.Mode)).Count() != (cls.BonusSpells?.Length ?? 0)
                || !ValidArcanum(cls)) return false;
        }
        if (state.Classes.Select(s => s.ClassId).Distinct().Count() != state.Classes.Length || state.Classes.Sum(s => s.Level) != c.Level
            || !state.Classes.Any(s => s.ClassId == c.Build!.ClassId)) return false;
        var levels = new Dictionary<string, int> { [c.Build!.ClassId] = 1 };
        var subclasses = new Dictionary<string, string>();
        for (int i = 0; i < state.Steps.Length; i++)
        {
            var step = state.Steps[i];
            if (step is null || step.CharacterLevel != i + 2 || step.ClassId is null || step.SubclassId is null
                || step.ClassLevel != levels.GetValueOrDefault(step.ClassId) + 1 || !state.Classes.Any(s => s.ClassId == step.ClassId)
                || step.HitPointIncrease is < -500 or > 500 || step.HitPointIncrease < 1 && state.FeatSources is null
                || !ValidDraft(step.Choices) || step.Choices.ClassId != step.ClassId
                || step.Features is not { Length: <= 100 } || step.Features.Distinct().Count() != step.Features.Length
                || step.Features.Any(id => !catalog.Features.Any(f => f.Id == id && f.Level == step.ClassLevel && id.Split('|')[1] == step.ClassId))) return false;
            if (step.ClassLevel >= 3 && !catalog.Subclasses.Any(s => s.Id == step.SubclassId && s.ClassId == step.ClassId)
                || step.ClassLevel < 3 && step.SubclassId != "") return false;
            if (step.ClassLevel == 3)
            {
                if (step.Choices.SubclassId != step.SubclassId) return false;
                subclasses[step.ClassId] = step.SubclassId;
            }
            if (step.ClassLevel > 3 && subclasses.GetValueOrDefault(step.ClassId) != step.SubclassId
                || step.Choices.SubclassId != "" && step.Choices.SubclassId != step.SubclassId) return false;
            foreach (string feature in step.Features)
            {
                var parts = feature.Split('|');
                if (parts.Length == 6 && step.SubclassId != step.ClassId + ":" + AdvancementCatalog.Slug(parts[3])) return false;
            }
            levels[step.ClassId] = step.ClassLevel;
        }
        return state.Classes.All(s => levels.GetValueOrDefault(s.ClassId) == s.Level
            && (subclasses.GetValueOrDefault(s.ClassId) ?? "") == s.SubclassId) && ValidFeatSources(c, state);
    }
}
