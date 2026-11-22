namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private static bool ValidFeatSources(Character c, CharacterAdvancement state)
    {
        var lessons = state.Classes.SelectMany(s => s.OptionalFeatures).Where(IsLesson).Select(id => "optional:" + id).ToHashSet();
        if (state.Classes.SelectMany(s => s.BonusSpells ?? []).Any(b => b.Origin.StartsWith(LessonPrefix, StringComparison.Ordinal)
            && (b.Origin != LessonPrefix + "magic-initiate" || !lessons.Contains(b.Origin)))) return false;
        if (state.FeatSources is null) return lessons.Count == 0 && state.RetiredResources is null;
        var sources = state.FeatSources;
        if (sources.Length is < 1 or > 11 || sources.Any(s => s is null || s.Id is null)
            || sources.Select(s => s.Id).Distinct().Count() != sources.Length || sources.Count(s => s.Id == "permanent") != 1
            || sources.Any(s => s.Id != "permanent" && !lessons.Contains(s.Id)) || lessons.Any(id => !sources.Any(s => s.Id == id))) return false;
        var catalog = AdvancementCatalog.Get();
        var build = BuildCatalog.Get();
        bool Items(string[]? values, int max, Func<string, bool> allowed) => values is not null && values.Length <= max
            && values.Distinct().Count() == values.Length && values.All(v => v is not null && allowed(v));
        foreach (var source in sources)
        {
            if (!Items(source.Feats, 77, id => catalog.Feats.Any(f => f.Id == id))
                || !Items(source.Skills, 18, id => build.Skills.Any(s => s.Name == id))
                || !Items(source.Expertise, 18, id => build.Skills.Any(s => s.Name == id))
                || !Items(source.Tools, 100, id => build.Equipment.Any(e => e.Id == id && e.Kind is "AT" or "INS" or "GS" or "T"))
                || !Items(source.Weapons, 8, id => id is "simple" or "martial" or "improvised")) return false;
            if (source.Id != "permanent" && (source.Feats.Length != 1 || source.Id != LessonPrefix + source.Feats[0]
                || !catalog.Feats.Any(f => f.Id == source.Feats[0] && f.Category == "O") || !ValidLessonContribution(state, source))) return false;
        }
        bool Same(IEnumerable<string> a, IEnumerable<string> b) => a.ToHashSet().SetEquals(b);
        var skills = sources.SelectMany(s => s.Skills).ToHashSet();
        if (!Same(sources.SelectMany(s => s.Feats), c.BuildMechanics!.Feats) || !Same(skills, c.Skills)
            || !Same(sources.SelectMany(s => s.Expertise).Where(skills.Contains), c.Expertise ?? [])
            || !Same(sources.SelectMany(s => s.Tools), c.BuildMechanics.Tools)
            || !Same(sources.SelectMany(s => s.Weapons), c.BuildMechanics.WeaponTraining)) return false;
        if (state.RetiredResources is not { } retired) return true;
        return retired.Length <= 24 && retired.All(r => r is not null && r.Name is not null && r.Current >= 0 && r.Current <= r.Maximum
            && r.Maximum is > 0 and <= 6 && r.RestBoundary >= 0 && r.RestBoundary <= c.NextLongRestAtSeconds
            && (r.Name == "Luck Points" || r.Maximum == 1 && catalog.Spells.Any(s => s.Level == 1 && r.Name == "Free: " + s.Id + " [" + LessonPrefix + "magic-initiate]")))
            && retired.Select(r => r.Name).Distinct().Count() == retired.Length;
    }

    private static bool ValidLessonContribution(CharacterAdvancement state, AdvancementFeatSource source)
    {
        var owner = state.Classes.Single(s => s.ClassId == "warlock");
        string feat = source.Feats[0];
        string[] Choice(string suffix) => owner.Choices?.SingleOrDefault(s => s.Key == source.Id + suffix)?.Values ?? [];
        var build = BuildCatalog.Get();
        var skills = new List<string>(); var tools = new List<string>(); var weapons = new List<string>();
        if (source.Expertise.Length != 0) return false;
        if (feat == "skilled")
        {
            var choices = Choice(":proficiencies:0");
            if (choices.Length != 3) return false;
            foreach (string id in choices)
                if (id.StartsWith("skill:", StringComparison.Ordinal) && build.Skills.SingleOrDefault(s => s.Id == id[6..]) is { } skill)
                    skills.Add(skill.Name);
                else if (id.StartsWith("tool:", StringComparison.Ordinal) && build.Equipment.Any(e => e.Id == id[5..] && e.Kind is "AT" or "INS" or "GS" or "T"))
                    tools.Add(id[5..]);
                else return false;
        }
        else if (feat is "crafter" or "musician")
        {
            var choices = Choice(feat == "crafter" ? ":tools" : ":instruments");
            if (choices.Length != 3) return false;
            var allowed = feat == "musician" ? build.Equipment.Where(e => e.Kind == "INS").Select(e => e.Id)
                : AdvancementCatalog.Get().Feats.Single(f => f.Id == feat).Mechanics.GetProperty("toolProficiencies")[0]
                    .GetProperty("choose").GetProperty("from").EnumerateArray().Select(v => AdvancementCatalog.Slug(v.GetString()!));
            if (choices.Any(id => !allowed.Contains(id))) return false;
            tools.AddRange(choices);
        }
        else if (feat == "tavern-brawler") weapons.Add("improvised");
        if (!skills.ToHashSet().SetEquals(source.Skills) || !tools.ToHashSet().SetEquals(source.Tools) || !weapons.ToHashSet().SetEquals(source.Weapons)) return false;
        if (feat != "magic-initiate") return true;
        var list = Choice(":list"); var ability = Choice(":ability");
        if (list.Length != 1 || !int.TryParse(list[0], out int index) || index is < 0 or > 2
            || ability.Length != 1 || ability[0] is not ("int" or "wis" or "cha")) return false;
        string spellList = new[] { "cleric", "druid", "wizard" }[index];
        var bonuses = (owner.BonusSpells ?? []).Where(b => b.Origin == source.Id).ToArray();
        if (bonuses.Length != 3 || bonuses.Select(b => b.Id).Distinct().Count() != 3) return false;
        var spells = AdvancementCatalog.Get().Spells;
        return bonuses.Count(b => spells.Any(s => s.Id == b.Id && s.Level == 0)) == 2
            && bonuses.All(b => spells.Any(s => s.Id == b.Id && s.Level <= 1 && s.Classes.Contains(spellList)
                && b.Mode == (s.Level == 0 ? "known" : "prepared") && b.Uses == s.Level && b.Condition == (s.Level == 0 ? "" : "1"))
                && b.Ability == ability[0] && b.Resource == "" && b.Recovery == "long");
    }
}
