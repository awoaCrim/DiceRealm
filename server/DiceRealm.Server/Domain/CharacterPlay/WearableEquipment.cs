namespace DiceRealm.Server.Domain;

// Physical wearing and attunement share one authority. Inventory absence is NOT evidence
// of 100 feet/24 hours separation; acquisition history and missing attunements are retained.
public static class WearableEquipment
{
    public static readonly string[] FixedSlots = ["head", "cloak", "hands", "wrists", "feet"];
    public static readonly string[] AccessorySlots = ["ring", "neck", "waist", "eyes", "clothing"];
    public const string BoundaryNotice = "同调最多3件，同类不能重复；卸下不会结束同调。未实现真实距离与24小时离物追踪，不按缺库存或换场景猜测结束。本人专注短休在模拟时间中原子完成；没有实时中断事件引擎。";
    public static CharacterAttunement[] Attunements(Character c) => c.PlayState?.Attunements ?? [];
    public static bool Attuned(Character c, Item i) => Attunements(c).Any(a => a.ItemId == i.Id && a.RulesId == i.RulesId);
    private static bool Unable(Character c) => c.HitPoints <= 0 || c.Exhaustion >= 6 || c.Conditions.Any(s =>
        s is "Dead" or "Unconscious" or "Incapacitated" or "Paralyzed" or "Petrified" or "Stunned");
    public static string Block(Campaign c, bool focusedRest = false, string executingIntentId = "")
    {
        string reason = CharacterPlayEngine.Block(c);
        if (reason != "") return reason;
        if (Unable(c.ActingCharacter)) return "当前角色无法自行穿戴或专注同调。";
        if (focusedRest && !ContentRuntime.SafeRest(c)) return "此地点尚不允许安全专注短休。";
        var actors = focusedRest ? PartyEngine.Characters(c).Select(p => p.Id).ToHashSet(StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal) { c.ActingActorId };
        if (c.PendingRolls.Any(r => r.Status == "pending" && actors.Contains(r.ActorId)) ||
            c.PendingIntents.Any(i => i.Status == "pending" && actors.Contains(i.ActorId) &&
                !(i.Id == executingIntentId && i.ActorId == c.ActingActorId)))
            return focusedRest ? "队伍中仍有待确认的行动或投掷，请由本人先完成或放弃。" : "本人仍有待确认的行动或投掷，请先完成或放弃。";
        return "";
    }
    private static string Slot(Item item, WearableDefinition d) =>
        item.Equipped && AccessorySlots.Contains(d.Slot) ? d.Slot + ":" + item.Id : d.Slot;
    private static bool Ready(Character ch, Item item, WearableDefinition d) => item.Quantity == 1 && item.Equipped &&
        !ch.Conditions.Contains("Dead") && (!d.RequiresAttunement || Attuned(ch, item));
    public static bool Effective(Character ch, Item item)
    {
        var d = WearableCatalog.For(item);
        return d is { Supported: true } && Ready(ch, item, d) &&
            (d.Id != "bracers-of-defense" || !BuildRuntime.Armored(ch) && !EquipmentLoadout.Shield(ch));
    }
    public static bool Has(Character ch, string id) => ch.Inventory.Any(i => WearableCatalog.For(i)?.Id == id && Effective(ch, i));
    public static int SaveBonus(Character ch) => (Has(ch, "cloak-of-protection") ? 1 : 0) + (Has(ch, "ring-of-protection") ? 1 : 0);
    public static int SkillBonus(Character ch, string ability, string skill) => ability == "dexterity" && skill == "Sleight of Hand" && Has(ch, "gloves-of-thievery") ? 5 : 0;
    public static bool Advantage(Character ch, string ability, string skill) => ability == "dexterity" && skill == "Stealth" && Has(ch, "boots-of-elvenkind");
    public static ArmorClassCalculation ArmorClass(Character ch, ArmorClassCalculation basis)
    {
        var sources = ch.Inventory.Where(i => Effective(ch, i)).GroupBy(i => i.RulesId).Select(g => g.First())
            .Select(i => (Item: i, Bonus: WearableCatalog.For(i)!.Id switch
            { "cloak-of-protection" or "ring-of-protection" => 1, "bracers-of-defense" => 2, _ => 0 }))
            .Where(x => x.Bonus > 0).ToArray();
        return new(basis.Value + sources.Sum(s => s.Bonus), [..basis.Sources, ..sources.Select(s => s.Item.Name + " +" + s.Bonus)]);
    }
    private static string WearReason(Character ch, Item item, WearableDefinition d, string block)
    {
        if (block != "") return block;
        if (item.Quantity != 1) return "旧堆叠物品未迁移；完整穿戴只支持数量1的独立实物。";
        if (!item.Equipped && FixedSlots.Contains(d.Slot) && ch.Inventory.Any(i => i.Id != item.Id && i.Quantity > 0 && i.Equipped && WearableCatalog.For(i)?.Slot == d.Slot))
            return Label(d.Slot) + "已有物品，请先明确卸下；不会替换另一件。";
        return "";
    }
    private static string AttunementReason(Character ch, Item item, WearableDefinition d, string block)
    {
        if (block != "") return block;
        if (Attuned(ch, item)) return "";
        if (item.Quantity != 1) return "同调需要接触数量1的独立实物；旧堆叠不自动迁移。";
        if (Attunements(ch).Any(a => a.RulesId == d.RulesId)) return "已经同调此种物品的另一副本；请先结束原同调。";
        if (Attunements(ch).Length >= 3) return "已经同调3件物品，请先结束一件的同调。";
        return "";
    }
    public static SheetWearablesView View(Campaign c, string executingIntentId = "")
    {
        var ch = c.ActingCharacter;
        string wearBlock = Block(c, executingIntentId: executingIntentId), restBlock = Block(c, focusedRest: true, executingIntentId: executingIntentId);
        var slots = FixedSlots.Select(slot => new SheetEquipmentSlot(slot, Label(slot),
            ch.Inventory.FirstOrDefault(i => i.Quantity > 0 && i.Equipped && WearableCatalog.For(i)?.Slot == slot)?.Id ?? "", "", true)).ToList();
        foreach (string slot in AccessorySlots)
        {
            foreach (var i in ch.Inventory.Where(i => i.Quantity > 0 && i.Equipped && WearableCatalog.For(i)?.Slot == slot))
                slots.Add(new(slot + ":" + i.Id, Label(slot), i.Id, "", true));
            slots.Add(new(slot, Label(slot) + " +", "", "", true));
        }
        var items = new List<SheetWearableItem>(); var options = new List<SheetLoadoutOption>(); var attunement = new List<SheetLoadoutOption>();
        foreach (var i in ch.Inventory.Where(i => i.Quantity > 0 && WearableCatalog.For(i) is not null))
        {
            var d = WearableCatalog.For(i)!; bool attuned = Attuned(ch, i), effective = Effective(ch, i);
            string status = (i.Equipped ? "已穿戴" : "未穿戴") + (d.Slot == "clothing" ? " · 普通衣物" :
                (d.RequiresAttunement ? attuned ? " · 已同调" : " · 未同调" : " · 无需同调") + (effective ? " · 效果生效" : " · 效果未生效"));
            string notice = i.Quantity != 1 ? "旧堆叠未迁移；不是可完整穿戴的独立实物。" : d.Notice;
            if (d.Id == "bracers-of-defense" && i.Equipped && attuned && !effective) notice += "当前穿甲或实际持盾，护腕AC加值不生效。";
            items.Add(new(i.Id, d.RulesId, Slot(i, d), i.Name, i.Equipped, d.RequiresAttunement, attuned, effective, status, notice));
            string reason = WearReason(ch, i, d, wearBlock);
            options.Add(new((i.Equipped ? "unwear:" : "wear:") + i.Id, (i.Equipped ? "卸下 " : "穿戴 ") + i.Name,
                Slot(i, d), i.Equipped ? "" : i.Id, 0, reason == "", reason));
            if (!d.RequiresAttunement) continue;
            reason = AttunementReason(ch, i, d, restBlock);
            attunement.Add(new((attuned ? "unattune:" : "attune:") + i.Id,
                (attuned ? "结束同调 " : "同调 ") + i.Name, Slot(i, d), i.Id, 3600, reason == "", reason));
        }
        foreach (var a in Attunements(ch).Where(a => !ch.Inventory.Any(i => i.Id == a.ItemId && i.Quantity > 0)))
        {
            // The retained bond is authority, not a fabricated inventory item. This bounded
            // catalog has no cursed items; ending the bond does not require physical contact.
            if (WearableCatalog.ByRulesId(a.RulesId) is not { RequiresAttunement: true } d) continue;
            items.Add(new(a.ItemId, a.RulesId, d.Slot, d.Name, false, true, true, false, "不在库存 · 仍同调",
                "实物不在当前库存，效果未生效；可通过另一次本人专注短休结束同调。" + d.Notice));
            attunement.Add(new("unattune:" + a.ItemId, "结束同调 " + d.Name, d.Slot, a.ItemId, 3600, restBlock == "", restBlock));
        }
        string missing = Attunements(ch).Any(a => !ch.Inventory.Any(i => i.Id == a.ItemId && i.Quantity > 0))
            ? "存在不在当前库存的同调实物；不会据此自动结束同调。" : "";
        return new(slots.ToArray(), options.ToArray(), items.ToArray(), attunement.ToArray(), Attunements(ch).Length, 3, BoundaryNotice + missing);
    }
    public static (Character Character, int Seconds, string Summary) Apply(Campaign c, string operation, string key, string executingIntentId = "")
    {
        var view = View(c, executingIntentId);
        var options = operation == "wear" ? view.Options : view.AttunementOptions;
        var option = options.SingleOrDefault(o => o.Key == key) ?? throw new GameException("invalid_character_command", "请选择服务端提供的完整穿戴或同调选项。");
        if (!option.Available) throw new GameException("wearable_unavailable", option.Reason, 409);
        var ch = PlayResources.Ensure(c.ActingCharacter);
        // Match the complete server-owned key; an instance ID may itself contain colons.
        if (operation == "wear")
        {
            var item = ch.Inventory.Single(i => (i.Equipped ? "unwear:" : "wear:") + i.Id == key);
            ch = ch with { Inventory = ch.Inventory.Select(i => i.Id == item.Id ? i with { Equipped = !i.Equipped } : i).ToArray() };
        }
        else
        {
            var ending = Attunements(ch).SingleOrDefault(a => "unattune:" + a.ItemId == key);
            CharacterAttunement[] next;
            if (ending is not null) next = Attunements(ch).Where(a => a.ItemId != ending.ItemId).ToArray();
            else
            {
                var item = ch.Inventory.Single(i => "attune:" + i.Id == key && i.Quantity == 1);
                foreach (var (actor, other) in PartyEngine.Characters(c, includeRevoked: true).Where(p => p.Id != c.ActingActorId).ToArray())
                    PartyEngine.SetCharacter(c, actor, EndInstance(other, item.Id));
                next = [..Attunements(ch), new CharacterAttunement(item.Id, item.RulesId!)];
            }
            ch = ch with { PlayState = ch.PlayState! with { Attunements = next.Length == 0 ? null : next } };
            c.ActingCharacter = ch;
            CharacterEngine.Advance(c, 3600);
            ch = PlayResources.ShortRest(c.ActingCharacter);
            ch = ch with { ShortRestDiceAvailable = true, PlayState = ch.PlayState! with { PreparationOpen = false } };
        }
        return (ch, option.Seconds, ch.Name + "：" + option.Label + (operation == "attunement"
            ? "。经过3600秒，仅恢复本人短休资源；没有自动治疗或代掷生命骰，可继续选择本人的生命骰与奥术回想。" : "；不自动攻击，卸下不结束同调。"));
    }
    public static Character EndInstance(Character ch, string itemId) => ch.PlayState?.Attunements is null ? ch : ch with
    { PlayState = ch.PlayState with { Attunements = ch.PlayState.Attunements.Where(a => a.ItemId != itemId).ToArray() is { Length: > 0 } remaining ? remaining : null } };
    public static Character EndOnDeath(Character ch) => !ch.Conditions.Contains("Dead") || ch.PlayState?.Attunements is null ? ch : ch with
    { PlayState = ch.PlayState with { Attunements = null } };
    public static Character Project(Campaign c, Character ch)
    {
        var armor = BuildRuntime.ArmorClassCalculation(ch, (ch.Effects ?? []).Any(e => e.Id == "mage-armor" && e.ExpiresAtSeconds > c.ElapsedSeconds));
        var wornArmor = BuildRuntime.Equipped(ch).FirstOrDefault(e => e.Kind is "LA" or "MA" or "HA");
        var l = EquipmentLoadout.Read(ch);
        string Names(IEnumerable<string> ids) => string.Join("、", ids.Where(id => id != "").Distinct().Select(id => ch.Inventory.FirstOrDefault(i => i.Id == id)?.Name ?? id));
        string held = Names(EquipmentLoadout.Held(ch).Select(h => h.Item.Id));
        string reserve = Names(EquipmentLoadout.HandSlots.Where(s => !s.StartsWith(l.ActiveSet + "-", StringComparison.Ordinal)).Select(s => EquipmentLoadout.Id(l, s)));
        var issues = new List<string>(); string invalid = EquipmentLoadout.Validate(ch, l);
        if (invalid != "") issues.Add(invalid);
        foreach (var i in ch.Inventory.Where(i => i.Equipped && i.Quantity > 0 && WearableCatalog.For(i) is not null))
        {
            var d = WearableCatalog.For(i)!;
            if (!d.Supported) issues.Add(i.Name + "：能力尚未自动结算，详见物品说明。");
            else if (i.Quantity != 1) issues.Add(i.Name + "：旧堆叠未迁移，效果未生效。");
            else if (d.RequiresAttunement && !Attuned(ch, i)) issues.Add(i.Name + "：尚未同调，魔法效果未生效。");
            else if (d.Id == "bracers-of-defense" && !Effective(ch, i)) issues.Add(i.Name + "：穿甲或实际持盾，AC加值未生效。");
        }
        if (Attunements(ch).Any(a => !ch.Inventory.Any(i => i.Id == a.ItemId && i.Quantity > 0))) issues.Add("同调实物不在当前库存；缺少距离证据，不自动结束。");
        var mechanics = ch.BuildMechanics;
        if (mechanics is not null) mechanics = mechanics with
        {
            Skills = BuildCatalog.Get().Skills.Select(s => new BuildSkillValue(s.Id, s.Name, BuildCatalog.AbilityName(s.Ability),
                RulesEngine.TestModifier(ch, BuildCatalog.AbilityName(s.Ability), s.Name, false), ch.Skills.Contains(s.Name), (ch.Expertise ?? []).Contains(s.Name))).ToArray(),
            SavingThrows = ch.Abilities.Select(a => new BuildSaveValue(a.Name, RulesEngine.TestModifier(ch, a.Name, "", true), RulesEngine.SavingProficiencies(ch).Contains(a.Name))).ToArray()
        };
        return ch with { ArmorClass = armor.Value, BuildMechanics = mechanics,
            EquipmentStatus = new(wornArmor?.Name ?? "未穿护甲", held == "" ? "未持握武器或盾" : held, reserve == "" ? "无备用持握配置" : reserve, issues.Distinct(StringComparer.Ordinal).ToArray(), armor.Sources) };
    }
    private static string Label(string slot) => slot switch
    { "head" => "头部", "clothing" => "衣着", "cloak" => "斗篷", "hands" => "手部", "wrists" => "护腕", "feet" => "足部", "ring" => "戒指", "neck" => "颈部", "waist" => "腰部", "eyes" => "眼部", _ => slot };
}
