using System.Text.Json;

namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private sealed partial class Evaluation
    {
        private readonly List<BuildSelection> GrantChoices = [];
        private static readonly string[] MagicInitiateLists = ["cleric", "druid", "wizard"];
        private HashSet<int> OwnedMagicInitiateLists()
        {
            var used = new HashSet<int>();
            foreach (var grant in Character.BuildMechanics!.SpellGrants.Where(g => g.Source.Contains("/feat:magic-initiate/", StringComparison.Ordinal)))
            {
                int index = Array.IndexOf(MagicInitiateLists, grant.Source.Split('/').Last());
                if (index >= 0) used.Add(index);
            }
            foreach (var choice in State.Classes.SelectMany(c => c.Choices ?? []).Concat(GrantChoices)
                         .Where(s => s.Key.EndsWith(":list", StringComparison.Ordinal) && MagicInitiateSource(s.Key[..^5]) && SourceStillOwned(s.Key[..^5])))
                foreach (var value in choice.Values) if (int.TryParse(value, out int index)) used.Add(index);
            return used;
        }
        private string[] SourceChoice(string key, string label, int count, IEnumerable<BuildOption> options, AdvancementClass? prior)
        {
            var old = prior?.Choices?.SingleOrDefault(s => s.Key == key)?.Values;
            var selected = Choose(key, label, count, options, old);
            // A level gain acquires new schedules; it is not a rest/replacement command.
            // Changing a retained block here would otherwise mix old and new spell lists.
            if (old is not null && !old.SequenceEqual(selected))
                Issue(key, "retained_source_choice", "已取得的来源选择不能在本次升级中更换；需使用该能力允许的独立更换流程。");
            if (selected.Length == count) GrantChoices.Add(new(key, selected));
            return selected;
        }

        // Source schedules are acquisition data, not permission to execute an arbitrary
        // spell. Preserve bounded usage/ability/conditions for the actual casting owner.
        private void SourceSpells(JsonElement source, string origin, int level, int priorLevel, string ability,
            AdvancementClass? prior, List<string> book, List<AdvancementBonusSpell> bonus, bool wizardBook = false)
        {
            if (source.ValueKind != JsonValueKind.Array) return;
            var blocks = source.EnumerateArray().ToArray();
            int selectedBlock = 0;
            if (blocks.Length > 1)
            {
                var options = blocks.Select((b, i) => new BuildOption(i.ToString(), b.TryGetProperty("name", out var n) ? n.GetString()! : "来源 " + (i + 1)));
                if (MagicInitiateSource(origin))
                {
                    var used = OwnedMagicInitiateLists();
                    options = options.Where(o => !used.Contains(int.Parse(o.Id)));
                }
                var chosen = SourceChoice(origin + ":list", "额外法术来源", 1, options, prior);
                if (chosen.Length == 0) return;
                selectedBlock = int.Parse(chosen[0]);
            }
            var spells = blocks[selectedBlock];
            if (spells.TryGetProperty("ability", out var property))
            {
                if (property.ValueKind == JsonValueKind.String)
                    ability = property.GetString() == "inherit" ? Draft.Selections.SingleOrDefault(s => s.Key == "feat:ability")?.Values.FirstOrDefault() ?? ability : property.GetString()!;
                else if (property.TryGetProperty("choose", out var options))
                    ability = SourceChoice(origin + ":ability", "来源施法属性", 1,
                        options.EnumerateArray().Select(v => new BuildOption(v.GetString()!, v.GetString()!)), prior).FirstOrDefault() ?? "";
            }
            foreach (string mode in new[] { "known", "prepared", "innate" })
            {
                if (!spells.TryGetProperty(mode, out var levels)) continue;
                foreach (var schedule in levels.EnumerateObject())
                {
                    int gainedLevel = schedule.Name == "_" ? 1 : int.TryParse(schedule.Name, out int n) ? n : int.MaxValue;
                    if (gainedLevel == int.MaxValue)
                    {
                        Issue(origin, "advancement_choice_not_supported", "额外法术的取得时机不完整，不能猜测。");
                        continue;
                    }
                    if (gainedLevel > level || gainedLevel <= priorLevel) continue;
                    string key = origin + ":" + selectedBlock + ":" + mode + ":" + schedule.Name;
                    AddScheduled(schedule.Value, mode, key, 0, "long", "", "");
                }
            }
            void AddScheduled(JsonElement value, string mode, string key, int uses, string recovery, string resource, string condition)
            {
                if (value.ValueKind == JsonValueKind.Array)
                {
                    int index = 0;
                    foreach (var item in value.EnumerateArray())
                    {
                        string[] selected;
                        if (item.ValueKind == JsonValueKind.String) selected = [AdvancementCatalog.Slug(item.GetString()!.Split('|')[0])];
                        else if (item.TryGetProperty("choose", out var filter) && filter.ValueKind == JsonValueKind.String)
                        {
                            int count = item.TryGetProperty("count", out var amount) ? amount.GetInt32() : 1;
                            var options = AdvancementCatalog.Get().Spells.Where(s => MatchesSpellFilter(s, filter.GetString()!)
                                && !(wizardBook && s.Level > 0 ? book.Contains(s.Id) : bonus.Any(b => b.Id == s.Id && b.Origin == origin)));
                            selected = SourceChoice(key + ":" + index, "额外法术", count, options.Select(s => new BuildOption(s.Id, s.Name)), prior);
                        }
                        else
                        {
                            Issue(origin, "advancement_choice_not_supported", "额外法术选择不完整，不能忽略其条件。");
                            selected = [];
                        }
                        foreach (var id in selected)
                        {
                            var spell = AdvancementCatalog.Get().Spells.SingleOrDefault(s => s.Id == id);
                            string storedMode = mode == "innate" && MagicInitiateSource(origin) ? "prepared" : mode;
                            if (spell is null) Issue(origin, "source_spell_missing", "来源法术不在完整的 2024 目录中。");
                            else if (wizardBook && mode == "known" && spell.Level > 0) book.Add(id);
                            else if (!bonus.Any(b => b.Id == id && b.Origin == origin && b.Mode == storedMode))
                                bonus.Add(new(id, storedMode, origin, ability, uses, recovery, resource, condition));
                        }
                        index++;
                    }
                    return;
                }
                if (value.ValueKind != JsonValueKind.Object)
                {
                    Issue(origin, "advancement_choice_not_supported", "额外法术使用条件无效。");
                    return;
                }
                foreach (var rule in value.EnumerateObject())
                {
                    if (rule.Name == "ritual") AddScheduled(rule.Value, "ritual", key + ":ritual", 0, "", "", condition);
                    else if (rule.Name is "daily" or "rest" or "resource")
                    {
                        foreach (var count in rule.Value.EnumerateObject())
                        {
                            int amount = int.TryParse(count.Name.TrimEnd('e'), out int number) ? number
                                : BuildCatalog.Get().Abilities.Contains(count.Name) ? Math.Max(1, CharacterEngine.Ability(Character, BuildCatalog.AbilityName(count.Name))) : 0;
                            if (amount <= 0) { Issue(origin, "advancement_choice_not_supported", "额外法术使用次数不完整。"); continue; }
                            string pool = rule.Name == "resource" && spells.TryGetProperty("resourceName", out var r) ? r.GetString()! : "";
                            AddScheduled(count.Value, mode, key + ":" + rule.Name + ":" + count.Name,
                                amount, rule.Name == "rest" ? "short" : "long", pool, count.Name);
                        }
                    }
                    else Issue(origin, "advancement_choice_not_supported", "额外法术使用方式尚未接线。");
                }
            }
        }
    }
}
