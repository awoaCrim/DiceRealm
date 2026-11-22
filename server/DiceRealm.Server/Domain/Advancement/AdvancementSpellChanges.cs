namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private sealed partial class Evaluation
    {
        private readonly List<(string Before, string After)> ReplacedSpellResources = [];

        // Spell Change belongs to the feat instance, not the class taking this level.
        // Keep is explicit in the public group but is also the safe omitted default.
        public AdvancementClass[] SpellChanges(AdvancementClass[] classes)
        {
            var catalog = AdvancementCatalog.Get();
            foreach (var instance in Character.BuildMechanics!.SpellGrants
                         .Where(g => g.Source.Contains("/feat:magic-initiate/", StringComparison.Ordinal)).GroupBy(g => g.Source))
            {
                string origin = instance.Key;
                string list = origin.Split('/').Last();
                var spells = instance.ToArray();
                var replacement = Replace(origin, list, spells.Select(s => s.Id).ToArray());
                if (replacement is null) continue;
                var old = spells.Single(s => s.Id == replacement.Value.Before);
                var changed = old with { Id = replacement.Value.After };
                SpellGrants[SpellGrants.IndexOf(old)] = changed;
                if (old.FreeUses > 0) RenameResource(PlayResources.FreeSpell(old), PlayResources.FreeSpell(changed));
            }
            foreach (var original in State.Classes)
            {
                int index = Array.FindIndex(classes, s => s.ClassId == original.ClassId);
                var current = classes[index];
                var bonuses = (current.BonusSpells ?? []).ToList();
                var choices = (current.Choices ?? []).ToArray();
                foreach (var instance in (original.BonusSpells ?? []).Where(s => MagicInitiateSource(s.Origin)
                             && bonuses.Any(b => b.Origin == s.Origin)).GroupBy(s => s.Origin))
                {
                    string origin = instance.Key;
                    string[] source = original.Choices?.SingleOrDefault(s => s.Key == origin + ":list")?.Values ?? [];
                    string list = source.Length == 1 && int.TryParse(source[0], out int n) && n >= 0 && n < MagicInitiateLists.Length ? MagicInitiateLists[n] : "";
                    var replacement = Replace(origin, list, instance.Select(s => s.Id).ToArray());
                    if (replacement is null) continue;
                    var old = instance.Single(s => s.Id == replacement.Value.Before);
                    var changed = old with { Id = replacement.Value.After };
                    bonuses[bonuses.IndexOf(old)] = changed;
                    choices = choices.Select(s => s.Key.StartsWith(origin + ":", StringComparison.Ordinal)
                        ? s with { Values = s.Values.Select(id => id == old.Id ? changed.Id : id).ToArray() } : s).ToArray();
                    if (old.Uses > 0) RenameResource(AdvancementSheet.FreeSpell(old), AdvancementSheet.FreeSpell(changed));
                }
                ReplaceArcanum(original, bonuses);
                classes[index] = current with { BonusSpells = bonuses.ToArray(), Choices = choices };
            }
            return classes;

            (string Before, string After)? Replace(string origin, string list, string[] ids)
            {
                if (!MagicInitiateLists.Contains(list) || ids.Length != 3 || ids.Distinct().Count() != 3
                    || ids.Count(id => catalog.Spells.Any(s => s.Id == id && s.Level == 0 && s.Classes.Contains(list))) != 2
                    || ids.Count(id => catalog.Spells.Any(s => s.Id == id && s.Level == 1 && s.Classes.Contains(list))) != 1)
                {
                    Issue(origin, "invalid_advancement_state", "法术入门的现有来源记录不完整，不能推测列表或覆盖。");
                    return null;
                }
                string key = "spell-change:" + origin;
                string? old = Choose(key, "Magic Initiate · 本次升级最多更换一个法术", 1,
                    new[] { new BuildOption("keep", "保留全部现有法术") }.Concat(ids.Select(id => new BuildOption(id, "更换 " + catalog.Spells.Single(s => s.Id == id).Name))), ["keep"]).FirstOrDefault();
                if (old is null or "keep") return null;
                int level = catalog.Spells.Single(s => s.Id == old).Level;
                string? replacement = Choose(key + ":replacement", "同列表、同环级的新法术", 1,
                    catalog.Spells.Where(s => s.Level == level && s.Classes.Contains(list) && !ids.Contains(s.Id)).Select(s => new BuildOption(s.Id, s.Name))).FirstOrDefault();
                return replacement is null ? null : (old, replacement);
            }
        }

        private void RenameResource(string before, string after)
        {
            if (!PlayResources.Ensure(Character).Resources.Any(r => r.Name == before))
                Issue(before, "invalid_advancement_state", "被更换法术的使用次数记录缺失；不会将缺失记录视为未消耗。");
            ReplacedSpellResources.Add((before, after));
        }

        public Character PreserveReplacedResources(AdvancementClass[] classes)
        {
            var previous = PlayResources.Ensure(Character);
            var resources = previous.Resources.ToArray();
            foreach (var pair in ReplacedSpellResources)
                resources = resources.Select(r => r.Name == pair.Before ? r with { Name = pair.After } : r).ToArray();
            return PreserveSourceResources(previous with { Resources = resources }, classes);
        }

        public void LineageSpells()
        {
            var build = Character.Build!;
            var earned = AdvancementCatalog.Get().LineageSpells.Where(s => s.SpeciesId == build.SpeciesId && s.Level == Character.Level + 1).ToArray();
            if (earned.Length == 0) return;
            string root = "species:" + build.SpeciesId;
            string? lineage = build.Selections.SingleOrDefault(s => s.Key == root + "/lineage")?.Values.SingleOrDefault();
            string source = root + "/lineage:" + lineage;
            string? ability = build.Selections.SingleOrDefault(s => s.Key == source + "/spell-ability")?.Values.SingleOrDefault();
            if (lineage is null || ability is null || !BuildCatalog.Get().Abilities.Contains(ability) || !earned.Any(s => s.LineageId == lineage))
            {
                Issue(root, "invalid_advancement_state", "原始血统或施法属性记录缺失，不能在升级时重新选择。");
                return;
            }
            foreach (var spell in earned.Where(s => s.LineageId == lineage))
            {
                if (SpellGrants.Any(g => g.Source == source && g.Id == spell.SpellId)) continue;
                SpellGrants.Add(new(spell.SpellId, ability, source, "always-prepared", 1));
            }
        }
    }
}
