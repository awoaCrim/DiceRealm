namespace DiceRealm.Server.Domain;

// Inputs only. HP, modifiers, resources and inventory are always constructed on the server.
public sealed record CharacterCreationChoices(int[] BaseScores, int[] BackgroundBonuses, string[] ClassSkills, string HumanSkill, string EquipmentId);
public sealed record CreationEquipment(string Id, string Label, string Description);
public sealed record CreationTemplate(string TemplateId, string Label, string[] ClassSkills, CreationEquipment[] Equipment, CharacterCreationChoices Defaults, string Limitation);
public sealed record CreationCatalog(string Ruleset, string Source, string Revision, string[] Abilities, int[] StandardArray, string[] HumanSkills, CreationTemplate[] Templates, string Scope);
public sealed record PreviewCharacterRequest(string CharacterName, string TemplateId, CharacterCreationChoices Creation);

public static class CharacterCreation
{
    public static readonly string[] Abilities = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
    private static readonly int[] StandardArray = [15, 14, 13, 12, 10, 8];
    private static readonly string[] Skills = ["Acrobatics", "Animal Handling", "Arcana", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Medicine", "Nature", "Perception", "Performance", "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival"];
    public static CreationCatalog Catalog() => new("dnd2024", "XPHB", "e5f3e77b303a92df10487207857200245e71957c", Abilities, StandardArray, Skills,
    [
        new(CharacterEngine.Fighter, "Fighter", ["Acrobatics", "Animal Handling", "Athletics", "History", "Insight", "Intimidation", "Persuasion", "Perception", "Survival"],
        [new("class-a", "职业装备 A + Soldier 金币", "Chain Mail、Greatsword、Flail、8 Javelins、Dungeoneer's Pack、54 GP。初始准备 Greatsword；Flail/Javelin 只记录，不自动使用。"),
         new("fighter-purchase", "金币购置：重甲、大剑、匕首", "职业 C 155 GP + Soldier B 50 GP；购置 Chain Mail 75 GP、Greatsword 50 GP、Dagger 2 GP，余 78 GP。初始准备 Greatsword；没有自动赠送旅行包。")],
         new([15,13,14,10,12,8], [2,0,1,0,0,0], ["Perception","Survival"], "Investigation", "class-a"),
         "本版本重甲 Fighter 限最终 STR ≥ 13；低力量的重武器/重甲惩罚尚未开放。"),
        new(CharacterEngine.Wizard, "Wizard", ["Arcana", "History", "Insight", "Investigation", "Medicine", "Nature", "Religion"],
        [new("class-a", "职业装备 A：准备法器长棍", "2 Daggers、Arcane Focus (Quarterstaff)、Robe、Spellbook、Scholar's Pack、55 GP。长棍采用双手近战。"),
         new("wizard-dagger", "相同装备 A：准备匕首", "携带相同装备及 55 GP，只将初始准备武器改为 Dagger（单手近战）；仍携带法器。投掷和双持不自动化。")],
         new([8,13,14,15,12,10], [1,0,2,0,0,0], ["Arcana","History"], "Investigation", "class-a"), "法术书、已准备法术和专长沿用已验证的起步选择。")
    ], "仅 Human / Soldier / 等级 1；标准数组各用一次，Soldier 仅 STR/DEX/CON +2/+1（不同项）或各 +1；职业 2 技能与 Human 1 技能均不得与背景或彼此重复。固定 Alert、Savage Attacker、语言、工具及职业特性；不开放点购、其他物种/背景或任意装备。未自动化条目只记录，需主持裁定。");

    public static Character Apply(Character preset, CharacterCreationChoices choices)
    {
        var template = Catalog().Templates.Single(t => t.TemplateId == preset.TemplateId);
        void Require(bool condition, string message) { if (!condition) throw new GameException("invalid_character_creation", message); }
        Require(choices.BaseScores is { Length: 6 } && choices.BaseScores.Order().SequenceEqual(StandardArray.Order()), "标准数组必须恰好为 15、14、13、12、10、8，各用一次。");
        var bonus = choices.BackgroundBonuses;
        Require(bonus is { Length: 6 } && bonus.Skip(3).All(b => b == 0) &&
            (bonus.Take(3).Order().SequenceEqual(new[] {0,1,2}) || bonus.Take(3).All(b => b == 1)), "Soldier 加值只能分配给 STR/DEX/CON：不同项 +2/+1，或三项各 +1。");
        Require(choices.ClassSkills is { Length: 2 } && choices.ClassSkills.All(s => template.ClassSkills.Contains(s)) && choices.ClassSkills.Distinct().Count() == 2, "请选择两个不同的本职业技能。");
        Require(Skills.Contains(choices.HumanSkill), "请选择支持的 Human 额外技能。");
        string[] skills = ["Athletics", "Intimidation", ..choices.ClassSkills!, choices.HumanSkill];
        Require(skills.Distinct().Count() == skills.Length, "技能不得与 Soldier 背景、职业或 Human 选择重复。本版本不开放重复熟练替换。");
        Require(template.Equipment.Any(e => e.Id == choices.EquipmentId), "此职业不支持该起始装备选项。");
        var abilities = Abilities.Select((n,i) => { int score = choices.BaseScores![i] + bonus![i]; return new Ability(n,score,RulesEngine.AbilityModifier(score)); }).ToArray();
        bool wizard = preset.ClassName == "Wizard";
        Require(wizard || abilities[0].Score >= 13, "本版本重甲 Fighter 仅支持最终 STR ≥ 13；这属于当前实现范围，不是通用建卡限制。");
        int hp = (wizard ? 6 : 10) + abilities[2].Modifier;
        var inventory = choices.EquipmentId switch
        {
            "fighter-purchase" => new Item[] { new("greatsword","Greatsword",1,true), new("chain-mail","Chain Mail",1,true), new("dagger","Dagger",1,false), new("gold-piece","Gold Piece",78,false) },
            "wizard-dagger" => preset.Inventory.Select(i => CharacterEngine.WeaponIds.Contains(i.Id) ? i with { Equipped = i.Id == "dagger" } : i).ToArray(),
            _ => preset.Inventory
        };
        return preset with
        {
            Abilities = abilities, Skills = skills, MaxHitPoints = hp, HitPoints = hp, ArmorClass = wizard ? 10 + abilities[1].Modifier : 16,
            Inventory = inventory, Spellcasting = preset.Spellcasting is null ? null : preset.Spellcasting with { AttackBonus = 2 + abilities[3].Modifier, SaveDc = 10 + abilities[3].Modifier },
            Features = preset.Features.Select(f => f.StartsWith("Skillful:",StringComparison.Ordinal) ? "Skillful: " + choices.HumanSkill : f).ToArray(),
            Creation = new(choices.BaseScores!.ToArray(), bonus!.ToArray(), choices.ClassSkills!.ToArray(), choices.HumanSkill, choices.EquipmentId)
        };
    }
}
