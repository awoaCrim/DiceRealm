namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private sealed partial class Evaluation
    {
        // These clauses are expressed in prose in the verified XPHB class files, not in
        // provider proficiency metadata. Match exact source feature IDs; no name guessing.
        private void FeatureProficiencies(AdvancementClassData cls, AdvancementClass next)
        {
            bool Has(string id) => Acquired.Any(f => f.Id == id);
            void SkillChoice(string key, int count, IEnumerable<BuildSkill> options)
            {
                foreach (var id in Choose(key, "职业技能熟练", count, options.Where(s => !Skills.Contains(s.Name)).Select(s => new BuildOption(s.Id, s.Name))))
                    GainTraining(Skills, Skill(id).Name);
            }
            if (Has("protector|cleric|xphb|1")) { GainTraining(Weapons, "martial"); Armor.Add("heavy"); }
            if (Has("warden|druid|xphb|1")) { GainTraining(Weapons, "martial"); Armor.Add("medium"); }
            if (Has("martial training|bard|xphb|valor|xphb|3")) { GainTraining(Weapons, "martial"); Armor.Add("medium"); Armor.Add("shield"); }
            if (Has("bonus proficiencies|bard|xphb|lore|xphb|3")) SkillChoice("lore:skills", 3, BuildCatalog.Get().Skills);
            if (Has("student of war|fighter|xphb|battle master|xphb|3"))
            {
                SkillChoice("student-of-war:skill", 1, BuildCatalog.Get().Classes.Single(c => c.Id == "fighter").Skills.Select(Skill));
                foreach (var id in Choose("student-of-war:tool", "工匠工具熟练", 1,
                    BuildCatalog.Get().Equipment.Where(e => e.Kind == "AT" && !Tools.Contains(e.Id)).Select(e => new BuildOption(e.Id, e.Name)))) GainTraining(Tools, id);
            }
            if (Has("implements of mercy|monk|xphb|mercy|xphb|3")) { GainTraining(Skills, "Insight"); GainTraining(Skills, "Medicine"); GainTraining(Tools, "herbalism-kit"); }
            if (Has("otherworldly glamour|ranger|xphb|fey wanderer|xphb|3"))
                SkillChoice("otherworldly-glamour:skill", 1, new[] { "deception", "performance", "persuasion" }.Select(Skill));
            if (Has("iron mind|ranger|xphb|gloom stalker|xphb|7"))
            {
                if (!Saves.Contains("wisdom")) Saves.Add("wisdom");
                else foreach (var id in Choose("iron-mind:save", "额外豁免熟练", 1,
                    new[] { "intelligence", "charisma" }.Select(v => new BuildOption(v, v)))) Saves.Add(id);
            }
            if (cls.Id == "rogue" && next.Level == 15) { Saves.Add("wisdom"); Saves.Add("charisma"); }
            if (cls.Id == "monk" && next.Level == 14) foreach (var id in BuildCatalog.Get().Abilities) Saves.Add(BuildCatalog.AbilityName(id));
            if (cls.Id == "rogue" && next.Level == 1)
            {
                Languages.Add("thieves-cant");
                foreach (var id in Choose("thieves-cant:language", "额外语言", 1,
                    BuildCatalog.Get().Languages.Where(l => !Languages.Contains(l.Id)).Select(l => new BuildOption(l.Id, l.Name)))) Languages.Add(id);
            }
            if (cls.Id == "druid" && next.Level == 1) Languages.Add("druidic");
        }
    }
}
