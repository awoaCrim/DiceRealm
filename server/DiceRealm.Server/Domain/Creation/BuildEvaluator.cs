using System.Security.Cryptography;
using System.Text.Json;

namespace DiceRealm.Server.Domain;

// Pure, deterministic validation/derivation. No rolls, save writes, HTTP, MCP or model calls.
public static class BuildEvaluator
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static BuildEvaluation Evaluate(CharacterBuild build)
    {
        CheckShape(build);
        var data = BuildCatalog.Get(); var issues = new List<BuildIssue>();
        void Issue(string step, string code, string message, string key = "") => issues.Add(new(step, code, message, key));
        if (build.Ruleset != data.Ruleset || build.Revision != data.Revision)
            Issue("class", "rules_version", "规则版本与当前目录不一致；请按当前目录重新选择并检查，不会自动改用其他版本。");
        var cls = data.Classes.SingleOrDefault(c => c.Id == build.ClassId);
        var species = data.Species.SingleOrDefault(c => c.Id == build.SpeciesId);
        var background = data.Backgrounds.SingleOrDefault(c => c.Id == build.BackgroundId);
        if (cls is null) Issue("class", "class_required", "请选择当前目录中的一级职业。", "$class");
        if (species is null) Issue("origin", "species_required", "请选择物种。", "$species");
        if (background is null) Issue("origin", "background_required", "请选择背景。", "$background");
        bool scoresValid = build.BaseScores.Length == 6;
        if (build.AbilityMethod == "standard") scoresValid &= build.BaseScores.Order().SequenceEqual(data.StandardArray.Order());
        else if (build.AbilityMethod == "point-buy") scoresValid &= build.BaseScores.All(s => s is >= 8 and <= 15)
            && build.BaseScores.Sum(s => s is >= 8 and <= 15 ? data.PointCosts[s - 8] : 1000) == data.PointBudget;
        else scoresValid = false;
        if (!scoresValid) Issue("abilities", "ability_invalid", "标准数组须各用一次；点购须六项均为 8..15，恰好使用 27 点。未分配项不会自动填为 8。", "$abilities");
        bool bonusesValid = build.BackgroundBonuses.Length == 6 && background is not null;
        if (bonusesValid)
        {
            var bonuses = build.BackgroundBonuses;
            bonusesValid = bonuses.Select((value,i) => (value,i)).All(x => x.value == 0 || background!.Abilities.Contains(data.Abilities[x.i]))
                && (bonuses.Order().SequenceEqual(new[] {0,0,0,0,1,2}) || bonuses.Order().SequenceEqual(new[] {0,0,0,1,1,1}));
        }
        if (!bonusesValid) Issue("abilities", "background_boost_invalid", "从所选背景的三项属性中，选择不同项 +2/+1，或三项各 +1。", "$bonuses");
        if (string.IsNullOrWhiteSpace(build.Identity.Name) || build.Identity.Name.Trim().Length > 40 || build.Identity.Name.Any(char.IsControl))
            Issue("details", "name_required", "姓名须为 1..40 个可见字符。", "$name");
        if (!BuildCatalog.Alignments.Contains(build.Identity.Alignment)) Issue("details", "alignment_invalid", "请选择有效阵营。", "$alignment");
        var resolver = new BuildChoices(data, build, issues); resolver.Resolve(cls, species, background);
        var (inventory, copper) = Equipment(data, build, cls, background, resolver, issues);
        resolver.Finish();
        var notices = new List<string> { "仅创建一级单职业角色；建卡选择与游戏内自动结算分开。未自动化的能力、法术、装备效果需主持裁定，不会由文字直接修改数值。", "改变职业、物种、背景或来源分支后，请复查依赖步骤；当前选择须重新检查后才能采用。" };
        if (resolver.Skills.Count != resolver.Skills.Distinct().Count()) notices.Add("存在重复获得的技能熟练：同一技能只计一次熟练加值，不自动叠加、转换为专精或赠送其他技能。");
        Character? character = null;
        if (issues.Count == 0 && scoresValid && bonusesValid)
        {
            character = Derive(build, data, cls!, species!, background!, resolver, inventory, copper);
            if (!character.BuildMechanics!.AutomatedCombat) notices.Add("此构筑可保存、探索并提交主持裁定；固定遭遇的自动战斗暂不接受此能力组合。不会用战士模板代算。完整选择仍保存在角色卡中。");
            if (character.Inventory.All(i => !i.Equipped)) notices.Add("尚未准备任何装备：预览 AC 使用无甲规则。持有护甲不会自动视为穿戴。");
        }
        var steps = BuildCatalog.Steps.Select(step => new BuildStep(step,
            step == "review" ? issues.Count == 0 : !issues.Any(i => i.Step == step),
            step == "review" ? issues.Count : issues.Count(i => i.Step == step))).ToArray();
        string fingerprint = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(build, Json)));
        return new(fingerprint, issues.Count == 0, issues.ToArray(), steps, resolver.Groups.ToArray(), character, notices.ToArray());
    }
    public static Character Create(CharacterBuild build)
    {
        var result = Evaluate(build);
        if (!result.CanCreate || result.Character is null)
            throw new GameException("invalid_character_build", string.Join("\n",result.Issues.Select(i => i.Message).Take(12)));
        return result.Character with { Id = Guid.NewGuid().ToString() };
    }
    private static void CheckShape(CharacterBuild b)
    {
        bool Invalid(string? value, int max = 100) => value is null || value.Length > max;
        bool InvalidIds(string[]? list, int max = 120) => list is null || list.Length > max || list.Any(s => Invalid(s,160));
        if (b is null || Invalid(b.Ruleset) || Invalid(b.Revision) || Invalid(b.ClassId) || Invalid(b.SpeciesId) || Invalid(b.BackgroundId) || Invalid(b.AbilityMethod)
            || b.BaseScores is null || b.BaseScores.Length > 6 || b.BaseScores.Any(x => x is < 0 or > 30)
            || b.BackgroundBonuses is null || b.BackgroundBonuses.Length > 6 || b.BackgroundBonuses.Any(x => x is < 0 or > 3)
            || InvalidIds(b.ClassSkills,18) || InvalidIds(b.Expertise,18) || InvalidIds(b.Cantrips,30) || InvalidIds(b.PreparedSpells,40) || InvalidIds(b.Spellbook,40)
            || Invalid(b.ClassEquipment) || Invalid(b.BackgroundEquipment) || InvalidIds(b.Equipped,8)
            || b.Selections is null || b.Selections.Length > 80 || b.Selections.Any(s => s is null || Invalid(s.Key,240) || InvalidIds(s.Values,40))
            || b.Purchases is null || b.Purchases.Length > 120 || b.Purchases.Any(p => p is null || Invalid(p.Id) || p.Quantity is < 1 or > 999)
            || b.Identity is null || Invalid(b.Identity.Name,80) || Invalid(b.Identity.Pronouns,40) || Invalid(b.Identity.Appearance,1000)
            || Invalid(b.Identity.Personality,1000) || Invalid(b.Identity.Backstory,4000) || Invalid(b.Identity.Alignment))
            throw new GameException("invalid_character_build", "建卡字段为空、类型不正确或超出长度范围。");
    }
    private static (Item[] Inventory, int Copper) Equipment(BuildCatalogData data, CharacterBuild build, BuildClass? cls, BuildBackground? background, BuildChoices choices, List<BuildIssue> issues)
    {
        var owned = new Dictionary<string,int>(); long money = 0;
        void Issue(string code, string message, string key = "") => issues.Add(new("equipment",code,message,key));
        void Add(string id, int quantity) => owned[id] = owned.GetValueOrDefault(id) + quantity;
        void Plan(string source, string selected, BuildEquipmentPlan[] options, string[] dependencies)
        {
            var plan = options.SingleOrDefault(p => p.Id == selected);
            if (plan is null) { Issue("equipment_plan_required", "请选择有效的" + (source == "class" ? "职业" : "背景") + "起始装备 / 金币方案。", "$" + source + "Equipment"); return; }
            money += plan.Copper;
            foreach (var item in plan.Items) Add(item.Id,item.Quantity);
            for (int i = 0; i < plan.Choices.Length; i++)
            {
                var pool = plan.Choices[i]; var ids = pool.Options.AsEnumerable();
                if (pool.MatchTraining) ids = ids.Where(id => build.Selections.Any(s => s.Key == "class:monk/tools-0" && s.Values.Contains(id)));
                foreach (var id in choices.Choose("equipment:" + source + "/" + plan.Id + "/" + i, "equipment", "装备包内的自选工具 / 乐器", pool.Count,
                    ids.Select(id => new BuildOption(id,data.Equipment.Single(e => e.Id == id).Name)), pool.MatchTraining ? [..dependencies, "class:monk/tools-0"] : dependencies)) Add(id,1);
            }
        }
        if (cls is not null) Plan("class",build.ClassEquipment,cls.Equipment,["$class","$classEquipment"]);
        if (background is not null) Plan("background",build.BackgroundEquipment,background.Equipment,["$background","$backgroundEquipment"]);
        // XPHB p165 Spellcasting grants the unique starting spellbook; never borrow
        // the 2014 equipment entry/price. Package A lists the same object, not a second one.
        if (cls?.Id == "wizard" && !owned.ContainsKey("spellbook")) Add("spellbook",1);
        if (build.Purchases.Select(p => p.Id).Distinct().Count() != build.Purchases.Length) Issue("purchase_duplicate","购买清单不能重复同一物品，请合并数量。");
        foreach (var purchase in build.Purchases)
        {
            var item = data.Equipment.SingleOrDefault(e => e.Id == purchase.Id);
            if (item?.Price is null) { Issue("purchase_invalid","该物品没有已核对的整铜币价格，不能购买。",purchase.Id); continue; }
            money -= (long)item.Price.Value * purchase.Quantity; Add(item.Id,purchase.Quantity);
        }
        if (money < 0) Issue("equipment_budget","装备购买超过职业与背景方案提供的合计资金。");
        if (money > int.MaxValue) Issue("equipment_budget","装备资金超出支持范围。");
        if (build.Equipped.Distinct().Count() != build.Equipped.Length || build.Equipped.Any(id => !owned.ContainsKey(id))) Issue("equipment_not_owned","只能准备不同的已持有物品。");
        var equipped = data.Equipment.Where(e => build.Equipped.Contains(e.Id)).ToArray();
        if (equipped.Count(e => e.Kind is "LA" or "MA" or "HA") > 1 || equipped.Count(e => e.Kind == "S") > 1)
            Issue("equipment_loadout","起步装备状态最多一件护甲和一面盾；可准备多把武器，按准备顺序第一把作为当前使用武器。");
        foreach (var item in equipped)
        {
            string training = item.Kind switch { "LA" => "light", "MA" => "medium", "HA" => "heavy", "S" => "shield", _ => "" };
            if (training != "" && !choices.Armor.Contains(training)) Issue("equipment_training","此构筑没有 " + item.Name + " 所需训练；本版本不自动处理未受训穿戴，请保留在背包。",item.Id);
            if (item.Kind is not ("LA" or "MA" or "HA" or "S") && item.WeaponCategory == "") Issue("equipment_not_wearable","起步准备栏仅记录护甲、盾和武器；其他物品保持持有。",item.Id);
        }
        var active = build.Equipped.Select(id => data.Equipment.SingleOrDefault(e => e.Id == id)).FirstOrDefault(e => e?.WeaponCategory is { Length: > 0 });
        if (equipped.Any(e => e.Kind == "S") && active?.Properties.Contains("2H") == true) Issue("equipment_hands","当前使用双手武器时不能同时准备盾牌；请先选择单手武器，或卸下盾牌。");
        return (owned.Select(pair => new Item(BuildCatalog.ItemId(pair.Key),data.Equipment.Single(e => e.Id == pair.Key).Name,pair.Value,build.Equipped.Contains(pair.Key))).ToArray(), (int)Math.Clamp(money,0,int.MaxValue));
    }
    private static Character Derive(CharacterBuild build, BuildCatalogData data, BuildClass cls, BuildSpecies species, BuildBackground background, BuildChoices choices, Item[] inventory, int copper)
    {
        var abilities = data.Abilities.Select((id,i) => new Ability(BuildCatalog.AbilityName(id),build.BaseScores[i]+build.BackgroundBonuses[i],RulesEngine.AbilityModifier(build.BaseScores[i]+build.BackgroundBonuses[i]))).ToArray();
        int Mod(string id) => abilities[Array.IndexOf(data.Abilities,id)].Modifier;
        int hp = cls.HitDie + Mod("con") + choices.HitPointBonus;
        var equipped = data.Equipment.Where(e => build.Equipped.Contains(e.Id)).ToArray();
        int ac = ArmorClass(cls.Id, Mod("dex"), Mod("con"), Mod("wis"), choices.Feats.Contains("defense"), equipped);
        int speed = choices.Speed - (equipped.Any(e => e.Kind == "HA" && e.Strength > abilities[0].Score) ? 10 : 0);
        var skillValues = data.Skills.Select(s => new BuildSkillValue(s.Id,s.Name,BuildCatalog.AbilityName(s.Ability),Mod(s.Ability)
            + (build.Expertise.Contains(s.Id) ? 4 : choices.Skills.Contains(s.Id) ? 2 : 0) + choices.SkillBonuses.GetValueOrDefault(s.Id),choices.Skills.Contains(s.Id),build.Expertise.Contains(s.Id))).ToArray();
        string? activeWeapon = build.Equipped.FirstOrDefault(id => data.Equipment.Any(e => e.Id == id && e.WeaponCategory != ""));
        var used = equipped.Where(e => e.WeaponCategory == "" || e.Id == activeWeapon).ToArray();
        bool automatic = species.Id == "human" && background.Id == "soldier" && choices.Feats.Contains("alert")
            && (cls.Id == "wizard" || cls.Id == "fighter" && choices.Feats.Contains("great-weapon-fighting") && choices.Masteries.Contains("greatsword"))
            && used.All(e => e.WeaponCategory == "" ? e.Id == "chain-mail" : CharacterEngine.WeaponIds.Contains(e.Id) && choices.Weapons.Contains(e.WeaponCategory))
            && !used.Any(e => e.Id == "greatsword" && abilities[0].Score < 13) && speed == 30;
        var mechanics = new BuildMechanics(cls.HitDie,speed,choices.Size,cls.Saves.Select(BuildCatalog.AbilityName).ToArray(),choices.Armor.Distinct().ToArray(),choices.Weapons.Distinct().ToArray(),
            choices.Tools.Distinct().ToArray(),choices.Languages.Distinct().ToArray(),choices.Feats.ToArray(),choices.Masteries.ToArray(),choices.Resistances.Distinct().ToArray(),choices.Spells.Select(g => g with { AttackBonus=2+Mod(g.Ability),SaveDc=10+Mod(g.Ability) }).ToArray(),skillValues,
            Mod("dex") + choices.InitiativeBonus,10 + skillValues.Single(s => s.Id == "perception").Modifier,copper,automatic,
            data.Abilities.Select(id => new BuildSaveValue(BuildCatalog.AbilityName(id),Mod(id)+(cls.Saves.Contains(id)?2:0),cls.Saves.Contains(id))).ToArray());
        var allSpells = build.Cantrips.Concat(build.PreparedSpells).Concat(build.Spellbook).Concat(choices.Spells.Select(s => s.Id)).Distinct().Select(id => data.Spells.Single(s => s.Id == id)).ToArray();
        var spellcasting = allSpells.Length == 0 ? null : new Spellcasting(cls.SpellAbility == "" ? "multiple" : BuildCatalog.AbilityName(cls.SpellAbility),
            cls.SpellAbility == "" ? 0 : 2 + Mod(cls.SpellAbility), cls.SpellAbility == "" ? 0 : 10 + Mod(cls.SpellAbility),
            allSpells.Select(s => new SpellView(s.Id,s.Name,s.Level,build.PreparedSpells.Contains(s.Id) || choices.Spells.Any(g => g.Id == s.Id) || s.Level == 0,
                automatic && cls.Id == "wizard" && (build.Cantrips.Contains(s.Id) || build.PreparedSpells.Contains(s.Id)) && s.Id is "fire-bolt" or "magic-missile" or "mage-armor",
                "见来源规则", "创建取得；未列入自动化的法术需主持裁定，施法不会在建卡时自动发生。")).ToArray());
        var resources = new List<Resource> { new($"Hit Dice (d{cls.HitDie})",1,1) };
        if (species.Id == "human") resources.Add(new("Heroic Inspiration",0,1));
        if (cls.Slots > 0) resources.Add(new(cls.PactMagic ? "Pact Slots (1st)" : "Spell Slots (1st)",cls.Slots,cls.Slots));
        if (cls.Id == "fighter") resources.Add(new("Second Wind",2,2));
        if (cls.Id == "wizard") resources.Add(new("Arcane Recovery",1,1));
        var features = choices.Features.Concat(choices.Feats.Select(id => data.Feats.Single(f => f.Id == id).Name))
            .Concat(new[] { "Languages: " + string.Join(", ",choices.Languages.Distinct()), "Size: " + choices.Size + "; speed: " + speed + " ft", "Saving throw proficiencies: " + string.Join(", ",mechanics.Saves) }).ToArray();
        var owned = inventory.ToList();
        if (copper / 100 > 0) owned.Add(new("gold-piece","Gold Piece",copper/100,false));
        if (copper % 100 / 10 > 0) owned.Add(new("silver-piece","Silver Piece",copper%100/10,false));
        if (copper % 10 > 0) owned.Add(new("copper-piece","Copper Piece",copper%10,false));
        // Clone input choices: callers cannot mutate the saved character through their draft arrays.
        var copied = JsonSerializer.Deserialize<CharacterBuild>(JsonSerializer.Serialize(build,Json),Json)!;
        var character = new Character("preview",build.Identity.Name.Trim(),"custom-level-one-2024",species.Name,cls.Name,background.Name,1,hp,hp,ac,2,abilities,
            choices.Skills.Distinct().Select(id => data.Skills.Single(s => s.Id==id).Name).ToArray(),owned.ToArray(),[],features,resources.ToArray(),"XPHB",spellcasting,[],
            Expertise:build.Expertise.Select(id => data.Skills.Single(s => s.Id==id).Name).ToArray(),Build:copied,BuildMechanics:mechanics);
        if (equipped.Count(e => e.WeaponCategory != "") > 1)
        {
            character = PlayResources.Ensure(character);
            character = character with { PlayState = character.PlayState! with { ActiveWeaponId = BuildCatalog.ItemId(activeWeapon!) } };
        }
        character = PlayResources.Ensure(character);
        var loadout = EquipmentLoadout.Read(character);
        if (EquipmentLoadout.Validate(character, loadout) == "")
        {
            character = EquipmentLoadout.Commit(character, loadout);
            character = character with { ArmorClass = BuildRuntime.ArmorClass(character, false) };
        }
        return character;
    }
    internal static int ArmorClass(string classId, int dex, int con, int wis, bool defense, BuildEquipment[] equipped, bool mageArmor = false) =>
        ArmorClassCalculation(classId, dex, con, wis, defense, equipped, mageArmor).Value;
    internal static ArmorClassCalculation ArmorClassCalculation(string classId, int dex, int con, int wis, bool defense, BuildEquipment[] equipped, bool mageArmor = false)
    {
        var armor = equipped.FirstOrDefault(e => e.Kind is "LA" or "MA" or "HA"); bool shield = equipped.Any(e => e.Kind == "S");
        int result; var sources = new List<string>();
        if (armor is not null)
        {
            int dexBonus = armor.Kind == "HA" ? 0 : armor.Kind == "MA" ? Math.Min(2, dex) : dex;
            result = armor.ArmorClass + dexBonus;
            sources.Add(armor.Name + "：" + armor.ArmorClass + (armor.Kind == "HA" ? "" : " + DEX " + dexBonus));
            if (defense) { result++; sources.Add("Defense +1（穿甲）"); }
        }
        else
        {
            result = (mageArmor ? 13 : 10) + dex;
            string formula = (mageArmor ? "Mage Armor 13" : "无甲 10") + " + DEX " + dex;
            if (classId == "barbarian" && 10 + dex + con > result)
            { result = 10 + dex + con; formula = "Barbarian无甲防御：10 + DEX " + dex + " + CON " + con; }
            if (classId == "monk" && !shield && 10 + dex + wis > result)
            { result = 10 + dex + wis; formula = "Monk无甲防御：10 + DEX " + dex + " + WIS " + wis; }
            sources.Add(formula);
        }
        if (shield) { result += 2; sources.Add("实际持盾 +2"); }
        return new(result, sources.ToArray());
    }
}
