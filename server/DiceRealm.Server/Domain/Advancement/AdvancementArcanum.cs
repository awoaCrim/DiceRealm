namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    // Validate persisted counters before deriving a new level. A just-evaluated candidate
    // legitimately lacks its newly earned pools until Refresh, so State keeps ownership
    // validation separate from this original-input/store-boundary check.
    public static void ValidateResources(Character c)
    {
        if (c.Advancement is null) return;
        var spells = State(c).Classes.SelectMany(cls => cls.BonusSpells ?? []).Where(b => b.Mode == "arcanum").ToArray();
        var names = spells.Select(AdvancementSheet.FreeSpell).ToHashSet();
        if (c.Resources is null || names.Any(name => c.Resources.Count(r => r is not null && r.Name == name) != 1)
            || c.Resources.Any(r => r is null || r.Name is null || names.Contains(r.Name) && (r.Maximum != 1 || r.Current is < 0 or > 1 || r.Recovery != "long")
                || r.Name.StartsWith("Free: ", StringComparison.Ordinal)
                    && new[] { 6, 7, 8, 9 }.Any(level => r.Name.EndsWith(" [class:warlock/arcanum:" + level + "]", StringComparison.Ordinal))
                    && !names.Contains(r.Name)))
            throw new GameException("invalid_advancement_state", "秘法奥秘次数记录缺失或不一致；不会推测已用次数或补回资源，请恢复一致备份。", 409);
    }

    public static void ValidateState(Campaign campaign)
    {
        foreach (var (_, character) in PartyEngine.Characters(campaign, includeRevoked: true)) ValidateResources(character);
    }

    private static bool ValidArcanum(AdvancementClass cls)
    {
        const string prefix = "class:warlock/arcanum:";
        var spells = (cls.BonusSpells ?? []).Where(b => b.Mode == "arcanum" || b.Origin.StartsWith(prefix, StringComparison.Ordinal)).ToArray();
        var levels = cls.ClassId == "warlock" ? new[] { 6, 7, 8, 9 }.Where(n => cls.Level >= 2 * n - 1).ToArray() : [];
        return spells.Length == levels.Length && levels.All(level => spells.Count(b =>
            b.Origin == prefix + level && b.Mode == "arcanum" && b.Ability == "" && b.Uses == 0
            && b.Recovery == "long" && b.Resource == "" && b.Condition == ""
            && AdvancementCatalog.Get().Spells.Any(s => s.Id == b.Id && s.Level == level && s.Classes.Contains("warlock"))) == 1);
    }

    private sealed partial class Evaluation
    {
        private void ReplaceArcanum(AdvancementClass prior, List<AdvancementBonusSpell> bonuses)
        {
            if (Draft.ClassId != "warlock" || prior.ClassId != "warlock") return;
            var owned = (prior.BonusSpells ?? []).Where(b => b.Mode == "arcanum").ToArray();
            if (owned.Length == 0) return;
            var catalog = AdvancementCatalog.Get();
            const string key = "mystic-arcanum:replace";
            string? origin = Choose(key, "秘法奥秘 · 本次邪术师升级最多更换一个法术", 1,
                new[] { new BuildOption("keep", "保留全部现有秘法奥秘") }.Concat(owned.Select(b =>
                    new BuildOption(b.Origin, "更换 " + catalog.Spells.Single(s => s.Id == b.Id).Name))), ["keep"]).FirstOrDefault();
            if (origin is null or "keep") return;
            var old = owned.Single(b => b.Origin == origin);
            int level = catalog.Spells.Single(s => s.Id == old.Id).Level;
            string? id = Choose(key + ":replacement", "同环级的另一邪术师法术（" + level + " 环）", 1,
                catalog.Spells.Where(s => s.Classes.Contains("warlock") && s.Level == level && s.Id != old.Id)
                    .Select(s => new BuildOption(s.Id, s.Name))).FirstOrDefault();
            if (id is null) return;
            var changed = old with { Id = id };
            bonuses[bonuses.IndexOf(old)] = changed;
            RenameResource(AdvancementSheet.FreeSpell(old), AdvancementSheet.FreeSpell(changed));
        }
    }
}
