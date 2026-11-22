using System.Text.Json;

namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private sealed partial class Evaluation
    {
        public void FeatChoices(AdvancementClass next)
        {
            bool abilityFeat = Acquired.Any(f => f.Name is "Ability Score Improvement" or "Epic Boon");
            bool style = Acquired.Any(f => f.Name is "Fighting Style" or "Additional Fighting Style");
            if (!abilityFeat && !style) return;
            var options = AdvancementCatalog.Get().Feats.Where(f => (style ? f.Category == "FS" : f.Category != "FS")
                && (f.Id != "magic-initiate" || OwnedMagicInitiateLists().Count < MagicInitiateLists.Length)
                && (f.Id != "blessed-warrior" || next.ClassId == "paladin") && (f.Id != "druidic-warrior" || next.ClassId == "ranger")
                && (!CurrentFeats.Contains(f.Id) || Flag(f.Mechanics, "repeatable")) && Prerequisites(f.Mechanics, next));
            foreach (string id in Choose("feat", style ? "战斗风格" : "成长专长", 1, options.Select(f => new BuildOption(f.Id, f.Name))))
            {
                var feat = AdvancementCatalog.Get().Feats.Single(f => f.Id == id);
                GainFeat(id);
                if (id == "ability-score-improvement")
                {
                    var abilities = BuildCatalog.Get().Abilities;
                    var choices = new List<BuildOption>();
                    for (int i = 0; i < abilities.Length; i++)
                    {
                        if (Score(abilities[i]) <= 18) choices.Add(new(abilities[i] + "+" + abilities[i], abilities[i] + " +2"));
                        for (int j = i + 1; j < abilities.Length; j++)
                            if (Score(abilities[i]) <= 19 && Score(abilities[j]) <= 19)
                                choices.Add(new(abilities[i] + "+" + abilities[j], abilities[i] + " +1 / " + abilities[j] + " +1"));
                    }
                    foreach (var selected in Choose("feat:ability", "属性值提升（最高 20）", 1, choices))
                        foreach (var ability in selected.Split('+')) Increase(ability, 1, 20);
                }
                else if (feat.Mechanics.TryGetProperty("ability", out var bonuses))
                {
                    // Other 2024 feats have one fixed ability or a one-point choice.
                    foreach (var bonus in bonuses.EnumerateArray())
                    {
                        int cap = bonus.TryGetProperty("max", out var maximum) ? maximum.GetInt32() : 20;
                        if (bonus.TryGetProperty("choose", out var choice))
                        {
                            var allowed = choice.GetProperty("from").EnumerateArray().Select(v => v.GetString()!).Where(a => Score(a) < cap
                                && (id != "resilient" || !Character.BuildMechanics!.Saves.Contains(BuildCatalog.AbilityName(a))));
                            foreach (var a in Choose("feat:ability", "专长属性提升", 1, allowed.Select(a => new BuildOption(a, a + " +1")))) Increase(a, 1, cap);
                        }
                        else foreach (var fixedBonus in bonus.EnumerateObject().Where(p => BuildCatalog.Get().Abilities.Contains(p.Name)))
                            Increase(fixedBonus.Name, fixedBonus.Value.GetInt32(), cap);
                    }
                }
                Proficiencies("feat:" + id, feat.Mechanics, id is "keen-mind" or "observant");
                if (id == "elemental-adept")
                    GrantChoices.Add(new("feat:elemental-adept:" + (Character.Level + 1), Choose("feat:damage", "元素专精伤害类型", 1,
                        new[] { "acid", "cold", "fire", "lightning", "thunder" }.Select(v => new BuildOption(v, v))
                            .Where(o => !State.Steps.Any(s => s.Choices.Selections.Any(v => v.Key == "feat:damage" && v.Values.Contains(o.Id)))))));
                if (id == "weapon-master")
                {
                    var chosen = Choose("feat:mastery", "武器精通", 1, BuildCatalog.Get().Equipment.Where(e => e.Mastery.Length > 0).Select(e => new BuildOption(e.Id, e.Name)));
                    GrantChoices.Add(new("feat:weapon-master", chosen));
                    Masteries = Masteries.Concat(chosen).Distinct().ToArray();
                }
                if (feat.Mechanics.TryGetProperty("resist", out var resistance))
                    foreach (var group in resistance.EnumerateArray())
                    {
                        if (group.ValueKind == JsonValueKind.String) Resistances.Add(group.GetString()!);
                        else if (group.TryGetProperty("choose", out var choice))
                        {
                            var selected = Choose("feat:resistance", "伤害抗性", choice.GetProperty("count").GetInt32(),
                                choice.GetProperty("from").EnumerateArray().Select(v => new BuildOption(v.GetString()!, v.GetString()!)));
                            GrantChoices.Add(new("feat:" + id + ":resistance", selected));
                            Resistances.UnionWith(selected);
                        }
                    }
            }
        }
        private int Score(string id) => Character.Abilities.Single(a => a.Name == BuildCatalog.AbilityName(id)).Score;
        private static bool Flag(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
        private bool Prerequisites(JsonElement mechanics, AdvancementClass next, string[]? selectedOptional = null)
        {
            if (!mechanics.TryGetProperty("prerequisite", out var prerequisites)) return true;
            return prerequisites.EnumerateArray().Any(group => group.EnumerateObject().All(p => p.Name switch
            {
                "level" => p.Value.ValueKind == JsonValueKind.Number ? Character.Level + 1 >= p.Value.GetInt32()
                    : (next.ClassId == p.Value.GetProperty("class").GetProperty("name").GetString()!.ToLowerInvariant()
                        ? next.Level : State.Classes.SingleOrDefault(c => c.ClassId == p.Value.GetProperty("class").GetProperty("name").GetString()!.ToLowerInvariant())?.Level ?? 0)
                        >= p.Value.GetProperty("level").GetInt32(),
                "ability" => p.Value.EnumerateArray().Any(a => a.EnumerateObject().All(v => Score(v.Name) >= v.Value.GetInt32())),
                "feature" => p.Value.EnumerateArray().All(f => Acquired.Any(a => a.Name == f.GetString()) || Character.Features.Any(v => v.StartsWith(f.GetString()!, StringComparison.Ordinal))),
                "proficiency" => p.Value.EnumerateArray().Any(v => v.EnumerateObject().All(prop => prop.Name == "armor" && Armor.Contains(prop.Value.GetString()!))),
                "spellcasting2020" => State.Classes.Append(next).Any(c => AdvancementCatalog.Progression(c) != ""),
                "otherSummary" => next.Level == 2 && next.ClassId is "paladin" or "ranger" && Acquired.Any(f => f.Name == "Fighting Style"),
                "optionalfeature" => p.Value.EnumerateArray().All(v => (selectedOptional ?? []).Select(OptionalDefinition).Contains(AdvancementCatalog.Slug(v.GetString()!.Split('|')[0]))),
                "spell" => p.Value.EnumerateArray().All(v => v.ValueKind == JsonValueKind.String
                    ? next.Cantrips.Contains(AdvancementCatalog.Slug(v.GetString()!.Split('|')[0]))
                    : next.Cantrips.Any(id => AdvancementCatalog.Get().Spells.Any(s => s.Id == id && s.DealsDamage))),
                // Special Paladin/Ranger style substitutions need spell acquisition, not a
                // blanket exemption from prerequisites. Unsupported predicates fail closed.
                _ => false
            }));
        }
        public void OptionalChoices(AdvancementClassData cls, AdvancementSubclassData? sub, AdvancementClass? prior)
        {
            OptionalFeatures = prior?.OptionalFeatures.ToArray() ?? [];
            foreach (var source in new[] { cls.OptionalfeatureProgression, sub?.OptionalfeatureProgression ?? default })
            {
                if (source.ValueKind != JsonValueKind.Array) continue;
                foreach (var entry in source.EnumerateArray())
                {
                    var progression = entry.GetProperty("progression");
                    int count = progression.ValueKind == JsonValueKind.Array ? progression[Class.Level - 1].GetInt32()
                        : progression.EnumerateObject().Where(p => int.Parse(p.Name) <= Class.Level).OrderBy(p => int.Parse(p.Name)).Select(p => p.Value.GetInt32()).LastOrDefault();
                    if (count == 0) continue;
                    var types = entry.GetProperty("featureType").EnumerateArray().Select(v => v.GetString()).ToArray();
                    string key = "optional:" + types[0];
                    // Filter against the proposed complete set, then recheck every selected
                    // dependency. Replacing a prerequisite cannot orphan a retained feature.
                    var proposed = Draft.Selections.SingleOrDefault(s => s.Key == key)?.Values ?? OptionalFeatures;
                    var spellClass = Class with { Cantrips = Draft.Selections.SingleOrDefault(s => s.Key == "spells:cantrips")?.Values ?? Class.Cantrips };
                    var options = AdvancementCatalog.Get().OptionalFeatures.Where(f => f.Types.Any(t => types.Contains(t)) && Prerequisites(f.Mechanics, spellClass, proposed));
                    var chosen = Choose(key, entry.GetProperty("name").GetString()!, count, options.SelectMany(f => OptionalOptions(f, spellClass)), OptionalFeatures);
                    if (OptionalFeatures.Except(chosen).Count() > 1)
                        Issue(key, "replacement_limit", "每次取得本职业等级最多替换一个已有可选能力。");
                    foreach (var id in chosen.Except(OptionalFeatures))
                    {
                        var option = AdvancementCatalog.Get().OptionalFeatures.Single(f => f.Id == OptionalDefinition(id));
                        if (IsLesson(id)) LessonTraining(id);
                        else if (option.Mechanics.TryGetProperty("featProgression", out _))
                            Issue(key, "advancement_choice_not_supported", "此能力的专长来源尚未接线，不能只记录名称。");
                    }
                    OptionalFeatures = chosen;
                }
            }
        }
        private void Proficiencies(string key, JsonElement mechanics, bool existingBecomesExpertise = false)
        {
            if (mechanics.TryGetProperty("skillToolLanguageProficiencies", out var mixed))
            {
                int index = 0;
                foreach (var group in mixed.EnumerateArray())
                    foreach (var choice in group.GetProperty("choose").EnumerateArray())
                    {
                        var options = new List<BuildOption>();
                        foreach (var type in choice.GetProperty("from").EnumerateArray())
                        {
                            if (type.GetString() == "anySkill") options.AddRange(BuildCatalog.Get().Skills.Where(s => !Skills.Contains(s.Name)).Select(s => new BuildOption("skill:" + s.Id, s.Name)));
                            else if (type.GetString() == "anyTool") options.AddRange(BuildCatalog.Get().Equipment.Where(e => (e.Kind is "AT" or "INS" or "GS" or "T") && e.Price is not null && !Tools.Contains(e.Id)).Select(e => new BuildOption("tool:" + e.Id, e.Name)));
                            else Issue(key, "advancement_choice_not_supported", "混合熟练选择含未接线的来源类型，不能忽略。");
                        }
                        foreach (var id in Choose(key + ":proficiencies:" + index++, "技能 / 工具熟练", choice.GetProperty("count").GetInt32(), options))
                            if (id.StartsWith("skill:", StringComparison.Ordinal)) GainTraining(Skills, Skill(id[6..]).Name);
                            else GainTraining(Tools, id[5..]);
                    }
            }
            if (mechanics.TryGetProperty("skillProficiencies", out var groups))
            {
                int index = 0;
                foreach (var group in groups.EnumerateArray())
                {
                    foreach (var prop in group.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.True)) GainTraining(Skills, Skill(prop.Name).Name);
                    int count = 0; IEnumerable<BuildSkill> options = [];
                    if (group.TryGetProperty("any", out var any)) { count = any.GetInt32(); options = BuildCatalog.Get().Skills; }
                    else if (group.TryGetProperty("choose", out var choose))
                    {
                        count = choose.TryGetProperty("count", out var n) ? n.GetInt32() : 1;
                        options = choose.GetProperty("from").EnumerateArray().Select(v => Skill(v.GetString()!));
                    }
                    if (count > 0)
                        foreach (var id in Choose(key + ":skill:" + index++, "技能熟练", count,
                                     options.Where(s => existingBecomesExpertise ? !Expertise.Contains(s.Name) : !Skills.Contains(s.Name)).Select(s => new BuildOption(s.Id, s.Name))))
                        {
                            string name = Skill(id).Name;
                            if (existingBecomesExpertise && Skills.Contains(name)) GainTraining(Expertise, name); else GainTraining(Skills, name);
                        }
                }
            }
            if (mechanics.TryGetProperty("expertise", out var expertise))
                foreach (var group in expertise.EnumerateArray())
                    if (group.TryGetProperty("anyProficientSkill", out var count)) ExpertiseChoice(key + ":expertise", count.GetInt32());
            foreach (string property in new[] { "armorProficiencies", "weaponProficiencies", "toolProficiencies" })
            {
                if (!mechanics.TryGetProperty(property, out var values)) continue;
                var target = property == "armorProficiencies" ? Armor : property == "weaponProficiencies" ? Weapons : Tools;
                foreach (var group in values.EnumerateArray())
                {
                    foreach (var prop in group.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.True)) GainTraining(target, property == "toolProficiencies" ? AdvancementCatalog.Slug(prop.Name) : prop.Name);
                    if (group.TryGetProperty("choose", out var choice))
                        foreach (var id in Choose(key + ":tools", "工具熟练", choice.TryGetProperty("count", out var n) ? n.GetInt32() : 1,
                            choice.GetProperty("from").EnumerateArray().Select(v => new BuildOption(AdvancementCatalog.Slug(v.GetString()!), v.GetString()!)))) GainTraining(target, id);
                    if (group.TryGetProperty("anyMusicalInstrument", out var instruments))
                        foreach (var id in Choose(key + ":instruments", "乐器熟练", instruments.GetInt32(),
                            BuildCatalog.Get().Equipment.Where(e => e.Kind == "INS").Select(e => new BuildOption(e.Id, e.Name)))) GainTraining(target, id);
                }
            }
        }
    }
}
