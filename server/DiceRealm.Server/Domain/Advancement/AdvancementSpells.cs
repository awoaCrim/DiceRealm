using System.Text.Json;

namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private sealed partial class Evaluation
    {
        public AdvancementClass Spells(AdvancementClassData cls, AdvancementSubclassData? sub, AdvancementClass? prior, AdvancementClass next)
        {
            var catalog = AdvancementCatalog.Get();
            string list = sub?.CasterProgression == "1/3" ? "wizard" : cls.Id;
            int max = AdvancementCatalog.MaximumSpellLevel(next);
            bool magicalSecrets = cls.Id == "bard" && next.Level >= 10;
            bool InList(AdvancementSpellData s) => s.Classes.Contains(list) || magicalSecrets && s.Classes.Any(c => c is "cleric" or "druid" or "wizard");
            int cantripCount = AdvancementCatalog.At(sub?.CantripProgression ?? cls.CantripProgression, next.Level);
            if ((cls.Id is "cleric" or "druid") && (Acquired.Any(f => f.Name is "Thaumaturge" or "Magician")
                || State.Steps.SelectMany(s => s.Features).Any(id => FeaturesById[id].Name is "Thaumaturge" or "Magician")
                || Character.Build!.ClassId == cls.Id && Character.Build.Selections.Any(s => s.Key == "class:" + cls.Id + "/order" && s.Values.Any(v => v is "thaumaturge" or "magician"))))
                cantripCount++;
            int preparedCount = AdvancementCatalog.At(sub?.PreparedSpellsProgression ?? cls.PreparedSpellsProgression, next.Level);
            var book = (prior?.Spellbook ?? []).ToList();
            var bonus = (prior?.BonusSpells ?? []).ToList();
            if (cls.Id == "wizard")
            {
                int additions = next.Level == 1 ? 6 : 2;
                book.AddRange(Choose("spellbook:add", "新增法术书法术", additions,
                    catalog.Spells.Where(s => s.Classes.Contains("wizard") && s.Level > 0 && s.Level <= max && !book.Contains(s.Id)).Select(s => new BuildOption(s.Id, s.Name))));
            }
            AddSubclassSpells(cls, sub, prior, next, book, bonus);
            string[] cantrips = cantripCount == 0 ? [] : Choose("spells:cantrips", "本职业戏法", cantripCount,
                catalog.Spells.Where(s => s.Level == 0 && s.Classes.Contains(list) && !bonus.Any(b => b.Id == s.Id)).Select(s => new BuildOption(s.Id, s.Name)), prior?.Cantrips);
            if ((prior?.Cantrips ?? []).Except(cantrips).Count(id => !bonus.Any(b => b.Id == id)) > 1)
                Issue("spells:cantrips", "replacement_limit", "此次升级最多替换一个本职业戏法。");
            string[] prepared = preparedCount == 0 ? [] : Choose("spells:prepared", "本职业准备法术", preparedCount,
                catalog.Spells.Where(s => s.Level > 0 && s.Level <= max && InList(s) && (cls.Id != "wizard" || book.Contains(s.Id))
                    && !bonus.Any(b => b.Id == s.Id && b.Mode is "prepared" or "known")).Select(s => new BuildOption(s.Id, s.Name)), prior?.PreparedSpells);
            int replaceLimit = cls.Id is "bard" or "sorcerer" or "warlock" || sub?.CasterProgression == "1/3" ? 1 : 0;
            if ((prior?.PreparedSpells ?? []).Except(prepared).Count(id => !bonus.Any(b => b.Id == id && b.Mode is "prepared" or "known")) > replaceLimit)
                Issue("spells:prepared", "replacement_limit", "等级取得只允许新增准备数量及本职业允许的替换；完整重新准备须使用休息后的准备流程。");
            if (cls.Id == "warlock" && next.Level is 11 or 13 or 15 or 17)
            {
                int spellLevel = (next.Level + 1) / 2;
                foreach (var id in Choose("mystic-arcanum", "秘法奥秘（" + spellLevel + " 环）", 1,
                             catalog.Spells.Where(s => s.Classes.Contains("warlock") && s.Level == spellLevel).Select(s => new BuildOption(s.Id, s.Name))))
                    bonus.Add(new(id, "arcanum", "class:warlock/arcanum:" + spellLevel));
            }
            if (cls.Id == "wizard" && next.Level == 18)
                foreach (int level in new[] { 1, 2 })
                    foreach (var id in Choose("spell-mastery:" + level, "法术精通（" + level + " 环）", 1,
                                 catalog.Spells.Where(s => book.Contains(s.Id) && s.Level == level && s.ActionCasting).Select(s => new BuildOption(s.Id, s.Name))))
                        bonus.Add(new(id, "mastery", "class:wizard/mastery:" + level));
            if (cls.Id == "wizard" && next.Level == 20)
                foreach (var id in Choose("signature-spells", "招牌法术（两个三环法术）", 2,
                             catalog.Spells.Where(s => book.Contains(s.Id) && s.Level == 3).Select(s => new BuildOption(s.Id, s.Name))))
                    bonus.Add(new(id, "signature", "class:wizard/signature"));
            return next with { Cantrips = cantrips, PreparedSpells = prepared, Spellbook = book.Distinct().ToArray(), BonusSpells = bonus.ToArray(),
                Choices = (prior?.Choices ?? []).Where(s => !GrantChoices.Any(g => g.Key == s.Key)
                    && !(prior?.OptionalFeatures ?? []).Except(OptionalFeatures).Any(id => s.Key.StartsWith("optional:" + id + ":", StringComparison.Ordinal)))
                    .Concat(GrantChoices).ToArray() };
        }

        private void AddSubclassSpells(AdvancementClassData cls, AdvancementSubclassData? sub, AdvancementClass? prior,
            AdvancementClass next, List<string> book, List<AdvancementBonusSpell> bonus)
        {
            string ability = sub?.SpellcastingAbility is { Length: > 0 } a ? a : cls.SpellcastingAbility;
            SourceSpells(cls.AdditionalSpells, "class:" + cls.Id, next.Level, prior?.Level ?? 0, ability, prior, book, bonus, cls.Id == "wizard");
            if (cls.Id == "ranger")
                for (int i = 0; i < bonus.Count; i++)
                    if (bonus[i].Origin == "class:ranger" && bonus[i].Id == "hunter-s-mark")
                        bonus[i] = bonus[i] with { Uses = AdvancementCatalog.Table(cls.Tables, "Favored Enemy", next.Level) };
            if (sub is not null)
                SourceSpells(sub.AdditionalSpells, "subclass:" + sub.Id, next.Level,
                    prior?.SubclassId == sub.Id ? prior.Level : 0, ability, prior, book, bonus, cls.Id == "wizard");
            bonus.RemoveAll(b => b.Origin.StartsWith("optional:", StringComparison.Ordinal) && !OptionalFeatures.Contains(b.Origin[9..]));
            foreach (var id in OptionalFeatures.Except(prior?.OptionalFeatures ?? []))
            {
                var option = AdvancementCatalog.Get().OptionalFeatures.Single(f => f.Id == OptionalDefinition(id));
                if (IsLesson(id))
                {
                    var feat = AdvancementCatalog.Get().Feats.Single(f => f.Id == LessonFeat(id));
                    if (feat.Mechanics.TryGetProperty("additionalSpells", out var featSpells))
                        SourceSpells(featSpells, "optional:" + id, Character.Level + 1, 0, ability, prior, book, bonus);
                }
                else if (InvocationSpell(id) is { } invocationSpell)
                    bonus.Add(invocationSpell);
                else if (option.Mechanics.TryGetProperty("additionalSpells", out var source))
                    SourceSpells(source, "optional:" + id, next.Level, 0, ability, prior, book, bonus);
            }
            foreach (var id in Feats)
            {
                var feat = AdvancementCatalog.Get().Feats.Single(f => f.Id == id);
                if (feat.Mechanics.TryGetProperty("additionalSpells", out var source))
                    SourceSpells(source, "feat:" + id + ":" + (Character.Level + 1), Character.Level + 1, 0, ability, prior, book, bonus);
            }
            // Ritual Caster grows with character proficiency, independently of this class.
            foreach (var step in State.Steps.Where(s => s.Choices.Selections.Any(v => v.Key == "feat" && v.Values.Contains("ritual-caster"))))
                SourceSpells(AdvancementCatalog.Get().Feats.Single(f => f.Id == "ritual-caster").Mechanics.GetProperty("additionalSpells"),
                    "feat:ritual-caster:" + step.CharacterLevel, Character.Level + 1, Character.Level,
                    step.Choices.Selections.Single(v => v.Key == "feat:ability").Values[0], prior, book, bonus);
        }
        private static bool MatchesSpellFilter(AdvancementSpellData spell, string filter)
        {
            foreach (string part in filter.Split('|'))
            {
                var pair = part.Split('=', 2);
                if (pair.Length != 2) return false;
                var values = pair[1].Split(';');
                bool matches = pair[0] switch
                {
                    "level" => values.Contains(spell.Level.ToString()),
                    "class" => values.Any(c => spell.Classes.Contains(c.ToLowerInvariant())),
                    "school" => values.Contains(spell.School),
                    "components & miscellaneous" => values.Length == 1 && values[0] == "ritual" && spell.Ritual,
                    "spell attack" => spell.SpellAttack,
                    _ => false
                };
                if (!matches) return false;
            }
            return true;
        }
    }
}
