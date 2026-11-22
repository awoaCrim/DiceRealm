namespace DiceRealm.Server.Domain;

// Source-scoped acquisition resolution shared by draft evaluation and final creation.
// It grants neither equipment nor the results of using an ability (familiars, spells, etc.).
internal sealed class BuildChoices(BuildCatalogData catalog, CharacterBuild build, List<BuildIssue> issues)
{
    internal readonly List<BuildGroup> Groups = [];
    internal readonly List<string> Skills = [], Tools = [], Languages = ["common"], Feats = [], Features = [], Armor = [], Weapons = [], Masteries = [], Resistances = [];
    internal readonly List<BuildSpellGrant> Spells = [];
    internal readonly Dictionary<string, int> SkillBonuses = [];
    internal int HitPointBonus, InitiativeBonus, Speed;
    internal string Size = "";
    private readonly HashSet<string> recognized = [];
    private readonly List<(string Source, string Id, string SpellClass, string[] Dependencies)> featSources = [];

    internal void Resolve(BuildClass? cls, BuildSpecies? species, BuildBackground? background)
    {
        Languages.AddRange(Choose("languages", "choices", "另选两种标准语言", 2,
            catalog.Languages.Where(x => x.Kind == "standard" && x.Id != "common").Select(x => new BuildOption(x.Id, x.Name)), []));
        if (background is not null)
        {
            Skills.AddRange(background.Skills); ResolveTools("background:" + background.Id, background.Tools, ["$background"]);
            featSources.Add(("background:" + background.Id, background.Feat, background.SpellClass, ["$background"]));
        }
        if (species is not null) Species(species, background);
        if (cls is not null)
        {
            Features.AddRange(cls.Features); Armor.AddRange(cls.Armor); Weapons.AddRange(cls.Weapons);
            ResolveTools("class:" + cls.Id, cls.Tools, ["$class"]);
            Skills.AddRange(Choose("$classSkills", "choices", "职业技能熟练", cls.SkillCount,
                SkillOptions(cls.Skills), ["$class"], build.ClassSkills));
            ClassFeatures(cls);
        }
        foreach (var entry in featSources) Feat(entry.Source, entry.Id, entry.SpellClass, entry.Dependencies);
        if (cls is not null)
        {
            Choose("$expertise", "choices", "技能专精（须已熟练）", cls.Id == "rogue" ? 2 : 0,
                SkillOptions(Skills.Distinct()), ["$class", "$classSkills", "$species", "$background", ..Groups.Where(g => g.Options.Any(o => catalog.Skills.Any(s => s.Id == o.Id))).Select(g => g.Key)], build.Expertise);
            ClassSpells(cls);
        }
    }
    internal void Finish()
    {
        foreach (var selection in build.Selections.Where(x => !recognized.Contains(x.Key)))
            Issue("choices", "choice_not_granted", "该选择的来源或前置分支已失效，请清除后重新选择。", selection.Key);
    }
    internal string[] Choose(string key, string step, string label, int count, IEnumerable<BuildOption> source, string[] dependencies, string[]? explicitValues = null)
    {
        var options = source.DistinctBy(x => x.Id).ToArray();
        var matches = build.Selections.Where(x => x.Key == key).ToArray();
        if (explicitValues is null) recognized.Add(key);
        var values = explicitValues ?? matches.SelectMany(x => x.Values).ToArray();
        bool valid = (explicitValues is not null || matches.Length <= 1) && values.Distinct().Count() == values.Length
            && values.Length <= count && values.All(v => options.Any(o => o.Id == v));
        bool complete = valid && values.Length == count;
        if (count > 0) Groups.Add(new(key, step, label, count, options, values, dependencies, complete));
        if (!valid) Issue(step, "choice_invalid", label + "含有无效、重复或超额的选项。", key);
        else if (!complete) Issue(step, "choice_required", $"{label}：需要选择 {count} 项，当前 {values.Length} 项。", key);
        return valid ? values : [];
    }
    private void Issue(string step, string code, string message, string key) => issues.Add(new(step, code, message, key));
    private IEnumerable<BuildOption> SkillOptions(IEnumerable<string> ids) => ids.Distinct().Select(id => catalog.Skills.Single(s => s.Id == id)).Select(s => new BuildOption(s.Id, s.Name));
    private IEnumerable<BuildOption> ItemOptions(IEnumerable<string> ids) => ids.Distinct().Select(id => catalog.Equipment.Single(i => i.Id == id)).Select(i => new BuildOption(i.Id, i.Name));
    private static IEnumerable<BuildOption> Values(params (string Id, string Label)[] values) => values.Select(v => new BuildOption(v.Id, v.Label));
    private void ResolveTools(string source, BuildTools tools, string[] dependencies)
    {
        Tools.AddRange(tools.Fixed);
        for (int i = 0; i < tools.Choices.Length; i++)
        {
            var pool = tools.Choices[i];
            Tools.AddRange(Choose(source + "/tools-" + i, "choices", source + " · 工具 / 乐器熟练", pool.Count, ItemOptions(pool.Options), dependencies));
        }
    }
    private string SpellAbility(string source, string[] dependencies) => Choose(source + "/spell-ability", "choices", "来源施法属性", 1,
        Values(("int", "智力 INT"), ("wis", "感知 WIS"), ("cha", "魅力 CHA")), dependencies).FirstOrDefault() ?? "";
    private void GrantSpell(string id, string ability, string source, string mode = "cantrip", int freeUses = 0)
    {
        if (!catalog.Spells.Any(s => s.Id == id)) throw new InvalidOperationException("Missing source spell: " + id);
        if (ability != "") Spells.Add(new(id, ability, source, mode, freeUses));
    }
    private void ChooseSpells(string source, string key, string label, int count, string classId, int level, string ability, string[] dependencies, string[]? excluded = null)
    {
        var candidates = catalog.Spells.Where(s => s.Level == level && s.Classes.Contains(classId) && !(excluded ?? []).Contains(s.Id));
        foreach (var id in Choose(source + "/" + key, "spells", label, count, candidates.Select(s => new BuildOption(s.Id, s.Name)), dependencies))
            GrantSpell(id, ability, source, level == 0 ? "cantrip" : "always-prepared", level == 0 ? 0 : 1);
    }
    private void Species(BuildSpecies species, BuildBackground? background)
    {
        string source = "species:" + species.Id; string[] deps = ["$species"];
        Features.AddRange(species.Features); Speed = species.Speed; Resistances.AddRange(species.Resistances);
        Size = species.Sizes.Length == 1 ? species.Sizes[0] : Choose(source + "/size", "choices", "体型", 1,
            species.Sizes.Select(x => new BuildOption(x, x == "S" ? "小型" : "中型")), deps).FirstOrDefault() ?? "";
        switch (species.Id)
        {
            case "aasimar": GrantSpell("light", "cha", source); break;
            case "dwarf": HitPointBonus++; break;
            case "human":
                Skills.AddRange(Choose(source + "/skill", "choices", "Human · 额外技能熟练", 1, SkillOptions(catalog.Skills.Select(s => s.Id)), deps));
                var originFeat = Choose(source + "/origin-feat", "choices", "Human · 额外起源专长", 1,
                    catalog.Feats.Where(f => f.Category == "O" && (f.Repeatable || f.Id != background?.Feat)).Select(f => new BuildOption(f.Id, f.Name)), ["$species", "$background"]).FirstOrDefault();
                if (originFeat is not null) featSources.Add((source + "/versatile", originFeat, "", ["$species", source + "/origin-feat"]));
                break;
            case "dragonborn":
                var colors = new (string Id, string Label, string Damage)[] { ("black","黑龙 / 强酸","acid"),("blue","蓝龙 / 闪电","lightning"),("brass","黄铜龙 / 火焰","fire"),("bronze","青铜龙 / 闪电","lightning"),("copper","赤铜龙 / 强酸","acid"),("gold","金龙 / 火焰","fire"),("green","绿龙 / 毒素","poison"),("red","红龙 / 火焰","fire"),("silver","银龙 / 寒冷","cold"),("white","白龙 / 寒冷","cold") };
                var color = Choose(source + "/ancestry", "choices", "龙族祖先", 1, colors.Select(c => new BuildOption(c.Id, c.Label)), deps).FirstOrDefault();
                if (color is not null) Resistances.Add(colors.Single(c => c.Id == color).Damage);
                break;
            case "goliath":
                Choose(source + "/ancestry", "choices", "巨人祖先", 1, Values(("cloud","云巨人 / 传送"),("fire","火巨人 / 火焰伤害"),("frost","霜巨人 / 寒冷与减速"),("hill","山丘巨人 / 倒地"),("stone","石巨人 / 减伤"),("storm","风暴巨人 / 雷鸣反击")), deps);
                break;
            case "elf": case "gnome": case "tiefling":
                var candidates = species.Id == "elf" ? Values(("drow","卓尔"),("high-elf","高等精灵"),("wood-elf","木精灵"))
                    : species.Id == "gnome" ? Values(("forest","森林侏儒"),("rock","岩侏儒"))
                    : Values(("abyssal","深渊血统"),("chthonic","冥界血统"),("infernal","炼狱血统"));
                var lineage = Choose(source + "/lineage", "choices", "血统", 1, candidates, deps).FirstOrDefault();
                if (species.Id == "elf") Skills.AddRange(Choose(source + "/keen-senses", "choices", "精灵 · 敏锐感官", 1, SkillOptions(["insight","perception","survival"]), deps));
                if (lineage is null) break;
                string child = source + "/lineage:" + lineage;
                string ability = SpellAbility(child, ["$species", source + "/lineage"]);
                string[] cantrips = lineage switch { "drow" => ["dancing-lights"], "high-elf" => ["prestidigitation"], "wood-elf" => ["druidcraft"], "forest" => ["minor-illusion"], "rock" => ["mending","prestidigitation"], "abyssal" => ["thaumaturgy","poison-spray"], "chthonic" => ["thaumaturgy","chill-touch"], _ => ["thaumaturgy","fire-bolt"] };
                foreach (var spell in cantrips) GrantSpell(spell, ability, child);
                if (lineage == "wood-elf") Speed = 35;
                if (lineage == "forest") GrantSpell("speak-with-animals", ability, child, "always-prepared", 2);
                if (species.Id == "tiefling") Resistances.Add(lineage == "abyssal" ? "poison" : lineage == "chthonic" ? "necrotic" : "fire");
                break;
        }
    }
    private void ClassFeatures(BuildClass cls)
    {
        string source = "class:" + cls.Id; string[] deps = ["$class"];
        if (cls.Features.Contains("Weapon Mastery"))
        {
            var weapons = catalog.Equipment.Where(e => e.Price is not null && e.WeaponCategory != "" && e.Mastery.Length > 0);
            if (cls.Id == "barbarian") weapons = weapons.Where(e => e.Kind == "M");
            if (cls.Id == "rogue") weapons = weapons.Where(e => e.WeaponCategory == "simple" || e.Properties.Any(p => p is "F" or "L"));
            Masteries.AddRange(Choose(source + "/masteries", "choices", "武器精通（不赠送武器）", cls.Id == "fighter" ? 3 : 2,
                weapons.Select(e => new BuildOption(e.Id, e.Name, string.Join(" / ",e.Mastery))), deps));
        }
        if (cls.Features.Contains("Fighting Style"))
            Feats.AddRange(Choose(source + "/style", "choices", "战斗风格", 1, catalog.Feats.Where(f => f.Category == "FS").Select(f => new BuildOption(f.Id, f.Name)), deps));
        if (cls.Id is "cleric" or "druid")
        {
            bool divine = cls.Id == "cleric";
            string? order = Choose(source + "/order", "choices", divine ? "神圣圣职" : "原初职能", 1, divine
                ? Values(("protector","守护者 / 军用武器与重甲"),("thaumaturge","奇术师 / 额外戏法与技能加值"))
                : Values(("warden","守卫者 / 军用武器与中甲"),("magician","魔术师 / 额外戏法与技能加值")), deps).FirstOrDefault();
            if (order is "protector" or "warden") { Armor.Add(divine ? "heavy" : "medium"); Weapons.Add("martial"); }
            else if (order is not null)
            {
                string child = source + "/" + order;
                ChooseSpells(child, "cantrip", "职能额外戏法", 1, cls.Id, 0, "wis", ["$class", source + "/order", "$cantrips"], build.Cantrips);
                int wisdom = build.BaseScores.Length == 6 && build.BackgroundBonuses.Length == 6 ? build.BaseScores[4] + build.BackgroundBonuses[4] : 10;
                int bonus = Math.Max(1, RulesEngine.AbilityModifier(wisdom));
                SkillBonuses["arcana"] = bonus; SkillBonuses[divine ? "religion" : "nature"] = bonus;
            }
        }
        if (cls.Id == "druid") Languages.Add("druidic");
        if (cls.Id == "rogue")
        {
            Languages.Add("thieves-cant");
            Languages.AddRange(Choose(source + "/language", "choices", "盗贼黑话已获得 · 另选一种语言", 1,
                catalog.Languages.Where(l => l.Kind is "standard" or "rare" && !Languages.Contains(l.Id)).Select(l => new BuildOption(l.Id,l.Name)), ["$class", "languages"]));
        }
        if (cls.Id == "warlock")
        {
            string? invocation = Choose(source + "/invocation", "choices", "一级魔能祈唤", 1,
                Values(("armor-of-shadows","幽影护甲 / 随意施放法师护甲"),("eldritch-mind","魔能心智 / 专注豁免优势"),("pact-of-the-blade","刃之契约 / 创建不召唤武器"),("pact-of-the-chain","链之契约 / 创建不召唤魔宠"),("pact-of-the-tome","书之契约 / 休息召唤时再选书中法术")), deps).FirstOrDefault();
            if (invocation is not null)
            {
                Features.Add(invocation);
                if (invocation == "armor-of-shadows") GrantSpell("mage-armor", "cha", source + "/invocation", "at-will");
                if (invocation == "pact-of-the-chain") GrantSpell("find-familiar", "cha", source + "/invocation", "at-will");
            }
        }
    }
    private void Feat(string parent, string id, string fixedSpellClass, string[] deps)
    {
        var feat = catalog.Feats.Single(f => f.Id == id);
        if (Feats.Contains(id) && !feat.Repeatable) { Issue("choices", "feat_duplicate", "该专长不能重复取得。", parent); return; }
        Feats.Add(id); string source = parent + "/feat:" + id;
        ResolveTools(source, feat.Tools, deps);
        if (id == "alert") InitiativeBonus = 2;
        if (id == "tough") HitPointBonus += 2;
        if (id == "tavern-brawler") Weapons.Add("improvised");
        if (id == "skilled")
        {
            var toolIds = catalog.Equipment.Where(e => e.Kind is "AT" or "INS" or "GS" or "T" && e.Price is not null).Select(e => e.Id).ToArray();
            var values = Choose(source + "/proficiencies", "choices", "Skilled · 三项技能 / 工具熟练", 3, SkillOptions(catalog.Skills.Select(s => s.Id)).Concat(ItemOptions(toolIds)), deps);
            Skills.AddRange(values.Where(v => catalog.Skills.Any(s => s.Id == v))); Tools.AddRange(values.Where(toolIds.Contains));
        }
        if (id == "magic-initiate")
        {
            var fixedLists = featSources.Where(f => f.Id == id && f.SpellClass != "").Select(f => f.SpellClass);
            var usedLists = Groups.Where(g => g.Key.EndsWith("/spell-list",StringComparison.Ordinal) && g.Complete).SelectMany(g => g.Selected);
            string? list = fixedSpellClass != "" ? fixedSpellClass : Choose(source + "/spell-list", "choices", "Magic Initiate · 法术列表", 1,
                Values(("cleric","牧师"),("druid","德鲁伊"),("wizard","法师")).Where(o => !fixedLists.Contains(o.Id) && !usedLists.Contains(o.Id)), deps).FirstOrDefault();
            if (list is not null)
            {
                string child = source + "/" + list; string[] childDeps = [..deps, source + "/spell-list"];
                string ability = SpellAbility(child, childDeps);
                ChooseSpells(child, "cantrips", "Magic Initiate · 两个戏法", 2, list, 0, ability, childDeps);
                ChooseSpells(child, "spell", "Magic Initiate · 一个一级法术", 1, list, 1, ability, childDeps);
            }
        }
    }
    private void ClassSpells(BuildClass cls)
    {
        string[] deps = ["$class"];
        var cantrips = catalog.Spells.Where(s => s.Level == 0 && s.Classes.Contains(cls.Id));
        var leveled = catalog.Spells.Where(s => s.Level == 1 && s.Classes.Contains(cls.Id) && !cls.AutomaticSpells.Contains(s.Id));
        Choose("$cantrips", "spells", "职业戏法", cls.Cantrips, cantrips.Select(s => new BuildOption(s.Id,s.Name)), deps, build.Cantrips);
        var book = Choose("$spellbook", "spells", "法术书", cls.Spellbook, leveled.Select(s => new BuildOption(s.Id,s.Name)), deps, build.Spellbook);
        Choose("$preparedSpells", "spells", "职业准备法术", cls.Prepared, leveled.Where(s => cls.Spellbook == 0 || book.Contains(s.Id)).Select(s => new BuildOption(s.Id,s.Name)),
            cls.Spellbook > 0 ? ["$class", "$spellbook"] : deps, build.PreparedSpells);
        foreach (var id in cls.AutomaticSpells) GrantSpell(id, cls.SpellAbility, "class:" + cls.Id, "always-prepared");
    }
}
