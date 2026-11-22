using System.Text.Json;

namespace DiceRealm.Server.Domain;

public static class PlayCatalog
{
    private static readonly Lazy<PlaySpellInfo[]> spells = new(() =>
    {
        using var stream=typeof(PlayCatalog).Assembly.GetManifestResourceStream("DiceRealm.Play.spells.json")!;
        return JsonSerializer.Deserialize<PlaySpellInfo[]>(stream,new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    });
    public static PlaySpellInfo[] Spells => spells.Value;
    public static string SpellDetails(string id)
    {
        var s=Spells.Single(x=>x.Id==id);
        return $"{s.Name} · {(s.Level==0?"戏法":s.Level+" 环")} · dnd2024 / XPHB p{s.Page}\n施法：{s.Casting}\n距离：{s.Range}\n持续：{s.Duration}{(s.Concentration?" · 专注":"")}\n成分：{s.Components}{(s.Ritual?"\n可仪式施放":"")}\n{s.Summary}\n速查字段不是完整效果说明。材料、触发、目标、专注和持续效果须按来源确认；记录使用不自动结算这些效果。";
    }
    public static BuildEquipment? Equipment(string id) => BuildCatalog.Get().Equipment.FirstOrDefault(e=>BuildCatalog.ItemId(e.Id)==id);
    public static Item? ActiveWeapon(Character c) => EquipmentLoadout.Held(c).FirstOrDefault(h => h.Slot.EndsWith("-main", StringComparison.Ordinal)).Item;
    public static Item[] HeldItems(Character c) => EquipmentLoadout.Held(c).Select(h => h.Item).ToArray();
    public static Character SetEquipment(Character c, string id, bool equip)
    {
        c = PlayResources.Ensure(c);
        var e = Equipment(id);
        if (e is not null && (e.WeaponCategory != "" || e.Kind == "S"))
        {
            var ready = c.Inventory.Where(i => i.Equipped).Select(i => i.Id).ToHashSet();
            c = EquipmentLoadout.Commit(c, EquipmentLoadout.Legacy(c, id, equip));
            if (equip) c = c with { Inventory = c.Inventory.Select(i => ready.Contains(i.Id) ? i with { Equipped = true } : i).ToArray() };
            // Unreferenced old prepared spares may still be explicitly put away.
            if (!equip) c = c with { Inventory = c.Inventory.Select(i => i.Id == id ? i with { Equipped = false } : i).ToArray() };
            return c;
        }
        return c with { Inventory = c.Inventory.Select(i => i.Id == id ? i with { Equipped = equip } : i).ToArray() };
    }
    public static string ItemName(string id) => id switch
    {
        "gold-piece"=>"Gold Piece", "silver-piece"=>"Silver Piece", "copper-piece"=>"Copper Piece",
        _=>Equipment(id)?.Name??""
    };
    public static readonly string[] Conditions = ["Blinded","Charmed","Deafened","Frightened","Grappled","Incapacitated","Invisible","Paralyzed","Petrified","Poisoned","Prone","Restrained","Stunned","Unconscious"];
    public static string[] ArmorTraining(Character c) => c.BuildMechanics?.ArmorTraining ?? (c.ClassName=="Fighter"?["light","medium","heavy","shield"]:[]);
    public static int EquipSeconds(BuildEquipment e, bool equip) => e.Kind switch
    { "LA"=>60, "MA"=>equip?300:60, "HA"=>equip?600:300, "S"=>6, _=>0 };
    public static string EquipmentBlock(Character c, BuildEquipment e, bool equip)
    {
        if(!equip)return "";
        string training=e.Kind switch {"LA"=>"light","MA"=>"medium","HA"=>"heavy","S"=>"shield",_=>""};
        if(training!=""&&!ArmorTraining(c).Contains(training))return "缺少所需护甲训练；未受训穿戴留给主持裁定。";
        var other=c.Inventory.Where(i=>i.Equipped&&i.Quantity>0&&i.Id!=BuildCatalog.ItemId(e.Id)).Select(i=>Equipment(i.Id)).Where(x=>x is not null).ToArray();
        if(e.Kind is "LA" or "MA" or "HA" && other.Any(x=>x!.Kind is "LA" or "MA" or "HA"))return "先卸下当前护甲，再穿戴另一件。";
        if (e.Kind == "S" || e.WeaponCategory != "") return EquipmentLoadout.Validate(c, EquipmentLoadout.Legacy(c, BuildCatalog.ItemId(e.Id), true));
        return "";
    }
}
