namespace DiceRealm.Server.Domain;

// One authority for configured hands, carried spares and physical quantities. A null save
// is inferred for reading only; an explicit loadout never selects a replacement item.
public static class EquipmentLoadout
{
    public static readonly string[] HandSlots = ["melee-main", "melee-off", "ranged-main", "ranged-off"];
    public static string Id(CharacterLoadout l, string slot) => slot switch
    { "melee-main" => l.MeleeMainHandId, "melee-off" => l.MeleeOffHandId, "ranged-main" => l.RangedMainHandId, "ranged-off" => l.RangedOffHandId, _ => "" };
    public static CharacterLoadout Set(CharacterLoadout l, string slot, string id) => slot switch
    { "melee-main" => l with { MeleeMainHandId = id }, "melee-off" => l with { MeleeOffHandId = id },
      "ranged-main" => l with { RangedMainHandId = id }, "ranged-off" => l with { RangedOffHandId = id }, _ => l };
    public static CharacterLoadout Read(Character c)
    {
        if (c.PlayState?.Loadout is { } saved) return saved;
        var weapons = c.Inventory.Where(i => i.Equipped && i.Quantity > 0 && PlayCatalog.Equipment(i.Id)?.WeaponCategory is { Length: > 0 }).ToArray();
        string active = c.PlayState?.ActiveWeaponId ?? (weapons.Length == 1 ? weapons[0].Id : "");
        var item = weapons.SingleOrDefault(i => i.Id == active);
        var shields = c.Inventory.Where(i => i.Equipped && i.Quantity > 0 && PlayCatalog.Equipment(i.Id)?.Kind == "S").ToArray();
        string shield = shields.Length == 1 ? shields[0].Id : "";
        bool ranged = PlayCatalog.Equipment(item?.Id ?? "")?.Kind == "R";
        return new(ranged ? "" : item?.Id ?? "", shield, ranged ? item?.Id ?? "" : "", "", ranged ? "ranged" : "melee",
            item?.Id == "quarterstaff" && shield == "" ? "two" : "one");
    }
    public static bool TwoHands(CharacterLoadout l, string set) =>
        PlayCatalog.Equipment(Id(l, set + "-main"))?.Properties.Contains("2H") == true || set == "melee" && l.MeleeGrip == "two" && l.MeleeMainHandId != "";
    public static string Validate(Character c, CharacterLoadout l)
    {
        if (l.ActiveSet is not ("melee" or "ranged") || l.MeleeGrip is not ("one" or "two") || HandSlots.Any(s => Id(l, s) is null)) return "装备组合或握持记录不合法。";
        foreach (var slot in HandSlots)
        {
            string id = Id(l, slot); if (id == "") continue;
            var item = c.Inventory.SingleOrDefault(i => i.Id == id && i.Quantity > 0);
            var e = PlayCatalog.Equipment(id);
            if (item is null || e is null) return "装备槽引用的物品缺失；请清空或重新配置该槽位。";
            bool off = slot.EndsWith("-off", StringComparison.Ordinal);
            if (e.Kind == "S")
            {
                if (slot != "melee-off") return "盾牌只能配置于近战副手。";
                if (!PlayCatalog.ArmorTraining(c).Contains("shield")) return "缺少盾牌训练。";
            }
            else if (e.WeaponCategory == "" || (slot.StartsWith("ranged", StringComparison.Ordinal) ? e.Kind != "R" && !e.Properties.Contains("T") : !off && e.Kind == "R")) return "此物品不属于该武器槽类型。";
            if (off && e.Properties.Contains("2H")) return "副手不能持用双手武器。";
        }
        foreach (string set in new[] { "melee", "ranged" })
            if (TwoHands(l, set) && Id(l, set + "-off") != "") return "双手武器或双手握持与副手冲突；请先明确清空副手。";
        if (l.MeleeGrip == "two" && l.MeleeMainHandId != "" && PlayCatalog.Equipment(l.MeleeMainHandId)?.Properties.Contains("V") != true)
            return "只有两用武器可选择双手握持；双手武器使用其原伤害。";
        foreach (var id in HandSlots.Select(s => Id(l, s)).Where(id => id != "").Distinct())
        {
            int need = Math.Max(new[] { "melee-main", "melee-off" }.Count(s => Id(l, s) == id), new[] { "ranged-main", "ranged-off" }.Count(s => Id(l, s) == id));
            if ((c.Inventory.SingleOrDefault(i => i.Id == id)?.Quantity ?? 0) < need) return "同一组合主副手使用同种物品需要两件库存。";
        }
        return "";
    }
    public static (string Slot, Item Item)[] Held(Character c)
    {
        var l = Read(c); if (Validate(c, l) != "") return [];
        return HandSlots.Where(s => s.StartsWith(l.ActiveSet + "-", StringComparison.Ordinal) && Id(l, s) != "")
            .Select(s => (s, c.Inventory.Single(i => i.Id == Id(l, s)))).ToArray();
    }
    public static bool Shield(Character c) => Held(c).Any(h => PlayCatalog.Equipment(h.Item.Id)?.Kind == "S");
    // Two-handed weapons need the second hand only while attacking, so a hand may be
    // released for S. This does not waive material or focus requirements.
    public static bool GestureHand(Character c) => Validate(c, Read(c)) == "" && Held(c).Length < 2;
    public static int OccupiedHands(Character c) => Held(c).Length == 0 ? 0 : TwoHands(Read(c), Read(c).ActiveSet) ? 2 : Held(c).Length;
    public static string Damage(Character c, BuildEquipment e) => Read(c) is { ActiveSet: "melee", MeleeGrip: "two" } && e.Properties.Contains("V") && e.VersatileDamage != "" ? e.VersatileDamage : e.Damage;
    public static int Seconds(Character c, CharacterLoadout next)
    {
        var old = Held(c).FirstOrDefault(h => PlayCatalog.Equipment(h.Item.Id)?.Kind == "S").Item?.Id ?? "";
        string shield = next.ActiveSet == "melee" ? next.MeleeOffHandId : "";
        if (PlayCatalog.Equipment(shield)?.Kind != "S") shield = "";
        return old == shield ? 0 : (old == "" || shield == "" ? 6 : 12);
    }
    public static Character Commit(Character c, CharacterLoadout l)
    {
        string reason = Validate(c, l); if (reason != "") throw new GameException("loadout_unavailable", reason, 409);
        c = PlayResources.Ensure(c); var old = Read(c);
        var removed = HandSlots.Select(s => Id(old, s)).Except(HandSlots.Select(s => Id(l, s))).ToHashSet();
        var assigned = HandSlots.Select(s => Id(l, s)).Where(id => id != "").ToHashSet();
        return c with { Inventory = c.Inventory.Select(i => assigned.Contains(i.Id) ? i with { Equipped = true } : removed.Contains(i.Id) ? i with { Equipped = false } : i).ToArray(),
            PlayState = c.PlayState! with { Loadout = l, ActiveWeaponId = Id(l, l.ActiveSet + "-main") } };
    }
    public static CharacterLoadout Legacy(Character c, string id, bool equip)
    {
        var l = Read(c); var e = PlayCatalog.Equipment(id);
        if (!equip) { foreach (var slot in HandSlots.Where(s => Id(l, s) == id)) l = Set(l, slot, ""); return l; }
        if (e?.Kind == "S") return l with { MeleeOffHandId = id };
        string set = e?.Kind == "R" ? "ranged" : "melee";
        l = Set(l, set + "-main", id) with { ActiveSet = set };
        if (set == "melee") l = l with { MeleeGrip = id == "quarterstaff" && l.MeleeOffHandId == "" ? "two" : "one" };
        return l;
    }
    private static CharacterLoadout Change(CharacterLoadout l, string key)
    {
        var parts = key.Split(':');
        return parts[0] switch
        {
            "assign" when parts.Length == 3 && HandSlots.Contains(parts[1]) => Set(l, parts[1], parts[2]) with
                { MeleeGrip = parts[1] == "melee-main" && PlayCatalog.Equipment(parts[2])?.Properties.Contains("V") != true ? "one" : l.MeleeGrip },
            "clear" when parts.Length == 2 && HandSlots.Contains(parts[1]) => Set(l, parts[1], "") with
                { MeleeGrip = parts[1] == "melee-main" ? "one" : l.MeleeGrip },
            "set" when parts.Length == 2 => l with { ActiveSet = parts[1] },
            "grip" when parts.Length == 2 => l with { MeleeGrip = parts[1] },
            _ => throw new GameException("invalid_character_command", "请选择服务端提供的装备选项。")
        };
    }
    // A closed board is an immutable combat record, not the character's current inventory.
    public static StandardDroppedItem[]? ActiveDrops(Campaign c) => CombatEngine.InCombat(c) ? PartyEngine.Unit(c)?.Standard?.DroppedItems : null;
    public static string WithDropped(Character c, CharacterLoadout l, StandardDroppedItem[]? dropped)
    {
        string reason = Validate(c, l); if (reason != "") return reason;
        foreach (var hand in HandSlots.Where(s => s.StartsWith(l.ActiveSet + "-", StringComparison.Ordinal)).Select(s => Id(l, s)).Where(id => id != "").GroupBy(id => id))
            if ((c.Inventory.Single(i => i.Id == hand.Key).Quantity - (dropped ?? []).Count(d => d.Id == hand.Key)) < hand.Count())
                return "该物品仍在掉落处，当前库存不能满足实际持握数量；请先拾回。";
        return "";
    }
    public static SheetLoadoutView View(Character c, string block = "", StandardDroppedItem[]? dropped = null)
    {
        var l = Read(c); string invalid = WithDropped(c, l, dropped); var options = new List<SheetLoadoutOption>();
        void Add(string key, string label, string slot = "", string id = "")
        {
            var next = Change(l, key); string reason = block != "" ? block : key == "grip:two" && PlayCatalog.Equipment(l.MeleeMainHandId)?.Properties.Contains("V") != true ? "当前近战主手不是两用武器。" : next == l ? "当前已是此配置。" : WithDropped(c, next, dropped);
            options.Add(new(key, label, slot, id, Seconds(c, next), reason == "", reason));
        }
        foreach (string slot in HandSlots)
        {
            foreach (var item in c.Inventory.Where(i => i.Quantity > 0 && PlayCatalog.Equipment(i.Id) is { } e && (e.WeaponCategory != "" || e.Kind == "S")))
                Add("assign:" + slot + ":" + item.Id, Label(slot) + " → " + item.Name, slot, item.Id);
            if (Id(l, slot) != "") Add("clear:" + slot, "清空" + Label(slot), slot);
        }
        Add("set:melee", "使用近战"); Add("set:ranged", "使用远程");
        if (PlayCatalog.Equipment(l.MeleeMainHandId)?.Properties.Contains("V") == true)
        { Add("grip:one", "单手握持"); Add("grip:two", "双手握持"); }
        var armor = c.Inventory.FirstOrDefault(i => i.Equipped && i.Quantity > 0 && PlayCatalog.Equipment(i.Id)?.Kind is "LA" or "MA" or "HA");
        var slots = new List<SheetEquipmentSlot> { new("armor", "护甲", armor?.Id ?? "", "", true) };
        foreach (string slot in HandSlots)
        {
            string set = slot.Split('-')[0]; string occupied = slot.EndsWith("-off", StringComparison.Ordinal) && TwoHands(l, set) ? Id(l, set + "-main") : "";
            slots.Add(new(slot, Label(slot), occupied == "" ? Id(l, slot) : "", occupied, invalid == "" && l.ActiveSet == set));
        }
        return new(l.ActiveSet, l.MeleeGrip, slots.ToArray(), options.ToArray(), invalid != "" ? invalid : "两套配置分别保留；仅当前组合持握。未自动执行双持额外攻击或远程攻击。");
    }
    private static string Label(string slot) => slot switch { "melee-main" => "近战主手", "melee-off" => "近战副手", "ranged-main" => "远程主手", _ => "远程副手" };
    public static (Character Character, int Seconds, string Summary) Apply(Character c, string key, string block = "", StandardDroppedItem[]? dropped = null)
    {
        var option = View(c, block, dropped).Options.SingleOrDefault(o => o.Key == key) ?? throw new GameException("invalid_character_command", "请选择服务端提供的装备选项。");
        if (!option.Available) throw new GameException("loadout_unavailable", option.Reason, 409);
        var next = Change(Read(c), key);
        return (Commit(c, next), option.Seconds, c.Name + "：" + option.Label + "；当前" + (next.ActiveSet == "melee" ? "近战" : "远程") + "组合，近战主手" + (next.MeleeMainHandId == "" ? "空置" : TwoHands(next, "melee") ? "双手握持" : "单手握持") + "；经过 " + option.Seconds + " 秒。未自动攻击。");
    }
    public static void RequireInventory(Character c)
    {
        if (c.PlayState?.Loadout is { } l && Validate(c, l) is { Length: > 0 } reason) throw new GameException("loadout_unavailable", reason, 409);
    }
}
