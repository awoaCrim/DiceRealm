namespace DiceRealm.Server.Domain;

// Fully evaluated, self-only exploration effects. No model-supplied dice, HP, source or target.
// The historical use/spell/feature operations deliberately remain recording/adjudication.
public static class NaturalActions
{
    public const string HealingPotion = "xdmg:potion-of-healing";
    public const int ExplorationSeconds = 6;
    public static bool SupportedItem(string? rulesId) => rulesId == HealingPotion;
    public sealed record Choice(string Key, string Label, string Cost, string Effect, string Resource = "", int Spend = 0,
        int Dice = 0, int Die = 0, int Bonus = 0, string ItemId = "", string Condition = "", bool Maximize = false, string SpellSource = "");
    public static int ClassLevel(Character c, string id) => c.Advancement is not null
        ? c.Advancement.Classes.SingleOrDefault(s => s.ClassId == id)?.Level ?? 0
        : c.Build is not null ? c.Build.ClassId == id ? c.Level : 0
        : c.TemplateId == CharacterEngine.Fighter && id == "fighter" || c.TemplateId == CharacterEngine.Wizard && id == "wizard" ? c.Level : 0;
    private static bool Unable(Character c) => c.HitPoints <= 0 || c.Exhaustion >= 6 ||
        c.Conditions.Any(s => s is "Unconscious" or "Incapacitated" or "Paralyzed" or "Petrified" or "Stunned");
    private static int Resource(Character c, string name) => c.Resources.FirstOrDefault(r => r.Name == name && r.Source == "XPHB")?.Current ?? 0;
    private static bool Life(Character c, int level) => c.Advancement?.Classes.Any(s => s.ClassId == "cleric" && s.SubclassId == "cleric:life" && s.Level >= level) == true;
    private static bool FreeHand(Character c) => EquipmentLoadout.GestureHand(c);
    private static bool ArmorPermitsSpells(Character c) => c.Inventory.Where(i => i.Equipped && i.Quantity > 0)
        .Select(i => PlayCatalog.Equipment(i.Id)).Where(e => e?.Kind is "LA" or "MA" or "HA")
        .All(e => PlayCatalog.EquipmentBlock(c, e!, true) == "");
    private static int SlotLevel(string resource)
    {
        for (int level = 1; level <= 9; level++)
            if (resource == AdvancementProjection.SlotName(level) || resource == AdvancementProjection.SlotName(level, true)) return level;
        return 0;
    }
    public static Choice[] Choices(Campaign c, CharacterSheetView? sheet = null)
    {
        sheet ??= CharacterPlayEngine.View(c, includeEffects: false);
        var ch = sheet.Character;
        if (!sheet.Enabled || Unable(ch) || PartyEngine.NeedsRecovery(c)) return [];
        int missing = ch.MaxHitPoints - ch.HitPoints;
        var result = new List<Choice>();
        int fighter = ClassLevel(ch, "fighter");
        if (missing > 0 && fighter > 0 && Resource(ch, "Second Wind") > 0)
            result.Add(new("second-wind", "回气 Second Wind · 治疗自身", "Second Wind ×1；1d10 + Fighter 等级", "heal", "Second Wind", 1, 1, 10, fighter));
        if (missing > 0 && ch.Build?.SpeciesId == "aasimar" && Resource(ch, "Healing Hands") > 0)
            result.Add(new("healing-hands", "治愈之手 Healing Hands · 治疗自身", "Healing Hands ×1；熟练加值颗 d4", "heal", "Healing Hands", 1, ch.ProficiencyBonus, 4));
        if (ClassLevel(ch, "paladin") > 0)
        {
            int pool = Resource(ch, "Lay on Hands"), maximum = Math.Min(missing, pool);
            // Highest useful amount first; every lower exact amount remains a legal candidate.
            for (int points = Math.Min(100, maximum); points >= 1; points--)
                result.Add(new("lay-on-hands/" + points, "圣疗 Lay on Hands · 自愈 " + points + " 点", "Lay on Hands 治疗池 " + points + " 点", "heal", "Lay on Hands", points, Bonus: points));
            if (pool >= 5 && ch.Conditions.Contains("Poisoned"))
                result.Add(new("lay-on-hands/poison", "圣疗 Lay on Hands · 解除自身中毒", "Lay on Hands 治疗池 5 点；不恢复 HP", "condition", "Lay on Hands", 5, Condition: "Poisoned"));
        }
        foreach (var item in ch.Inventory.Where(i => i.Quantity > 0 && missing > 0))
            if (c.Adventure!.Items.Any(i => i.Id == item.Id && i.RulesId == HealingPotion))
                result.Add(new("item/" + item.Id, "饮用 " + item.Name + " · 治疗自身", item.Name + " ×1；恢复 2d4+2 HP", "heal", Dice: 2, Die: 4, Bonus: 2, ItemId: item.Id));
        if (!ArmorPermitsSpells(ch)) return result.ToArray();
        foreach (var spell in sheet.Spells.Where(s => s.Available && s.SpellId is "cure-wounds" or "healing-word" or "lesser-restoration"))
        {
            // Feature-bound/ritual options are not unconditional casting authority. No material
            // spells are in this set; S requires a genuinely empty hand in this conservative UI.
            if (spell.Id.EndsWith("/feature", StringComparison.Ordinal) || spell.Id.Contains("ritual", StringComparison.Ordinal) ||
                spell.Resource != "" && spell.Remaining <= 0 || spell.Ability == "" || spell.SpellId != "healing-word" && !FreeHand(ch) ||
                spell.SpellId == "healing-word" && ch.Conditions.Contains("Blinded")) continue;
            int slot = SlotLevel(spell.Resource), level = slot == 0 ? spell.SpellId == "lesser-restoration" ? 2 : 1 : slot;
            string cost = spell.Resource == "" ? "该来源无需法术资源" : spell.Resource + " ×1";
            string source = spell.Source + " · " + cost;
            if (spell.SpellId == "lesser-restoration")
            {
                foreach (string condition in new[] { "Blinded", "Deafened", "Paralyzed", "Poisoned" }.Where(ch.Conditions.Contains))
                    result.Add(new("spell/" + spell.Id + "/" + condition, "次级复原术 Lesser Restoration · 解除自身 " + condition + "（" + source + "）",
                        cost + "；需能发声、空手施法", "condition", spell.Resource, spell.Resource == "" ? 0 : 1, Condition: condition, SpellSource: spell.Id));
                continue;
            }
            if (missing <= 0) continue;
            int modifier = CharacterEngine.Ability(ch, spell.Ability) + (slot > 0 && Life(ch, 3) ? 2 + slot : 0);
            result.Add(new("spell/" + spell.Id, (spell.SpellId == "cure-wounds" ? "疗伤术 Cure Wounds" : "治愈真言 Healing Word") + " · 治疗自身（" + source + "）",
                cost + "；需能发声" + (spell.SpellId == "cure-wounds" ? "、空手施法" : "并能看到自身"), "heal", spell.Resource, spell.Resource == "" ? 0 : 1,
                2 * level, spell.SpellId == "cure-wounds" ? 8 : 4, modifier, Maximize: Life(ch, 17), SpellSource: spell.Id));
        }
        return result.ToArray();
    }
    public static ActionDetails Details(Choice choice) => new(choice.Label,
        choice.Cost + (choice.Dice > 0 ? $"；治疗值 {choice.Dice}d{choice.Die}{choice.Bonus:+0;-0;+0}" : "") + "；探索记时 " + ExplorationSeconds + " 秒", "只作用于当前角色自身；非战斗",
        "确认才执行并结算效果，不进入主持补账。" + (choice.Dice > 0 ? choice.Maximize ? "Supreme Healing 使用最大骰面，不掷骰。" : "确认同时授权服务端投掷此恢复骰。" : "不掷骰。") +
        " 未记录的阻碍须先核实；取消不消耗。");
    public static Resolution Resolve(Campaign c, CharacterPlayRequest request, RulesEngine rules)
    {
        if (request.Value != 1) throw new GameException("invalid_character_command", "数额由服务端提供的完整候选决定，不能追加参数。");
        var selected = Choices(c).SingleOrDefault(x => x.Key == request.Key)
            ?? throw new GameException("action_unavailable", "此效果、来源、资源或自身状态现在不允许执行，请刷新候选。", 409);
        var ch = PlayResources.Ensure(c.ActingCharacter);
        // All validation precedes randomness and mutation. A maximized roll is not reported as rolled.
        int[] rolls = selected.Dice == 0 || selected.Maximize ? [] : rules.RollDice(selected.Dice, selected.Die);
        int total = Math.Max(0, (selected.Maximize ? selected.Dice * selected.Die : rolls.Sum()) + selected.Bonus);
        int healed = selected.Effect == "heal" ? Math.Min(total, ch.MaxHitPoints - ch.HitPoints) : 0;
        ch = ch with
        {
            HitPoints = ch.HitPoints + healed,
            Resources = ch.Resources.Select(r => r.Name == selected.Resource ? r with { Current = r.Current - selected.Spend } : r).ToArray(),
            Inventory = ch.Inventory.Select(i => i.Id == selected.ItemId ? i with { Quantity = i.Quantity - 1 } : i).Where(i => i.Quantity > 0).ToArray(),
            Conditions = selected.Condition == "" ? ch.Conditions : ch.Conditions.Where(x => x != selected.Condition).ToArray()
        };
        c.ActingCharacter = ch; CharacterEngine.Advance(c, ExplorationSeconds);
        string rollText = selected.Dice == 0 ? "" : selected.Maximize ? $"最大骰面 {selected.Dice}d{selected.Die}={selected.Dice * selected.Die}；"
            : $"{selected.Dice}d{selected.Die} [{string.Join(", ", rolls)}]；";
        string effect = selected.Effect == "heal" ? rollText + $"恢复值 {total}，实际恢复 {healed} HP（{ch.HitPoints}/{ch.MaxHitPoints}）。"
            : "已解除 " + selected.Condition + "；未恢复 HP。";
        string spent = selected.ItemId != "" ? "已消耗 1 瓶。" : selected.Spend > 0 ? $"已消耗 {selected.Resource} ×{selected.Spend}。" : "未消耗法术资源。";
        return new("resolved", "character.execute", ch.Name + "：" + selected.Label + "。" + effect + spent + $"探索时间经过 {ExplorationSeconds} 秒。", null, ["character:" + ch.Id]);
    }
}
