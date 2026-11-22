using System.Text.Json;

namespace DiceRealm.Server.Domain;

// Only source-verified named packs have an unpack operation. Runtime inventory IDs remain opaque.
public static class EquipmentPacks
{
    private sealed record EquipmentPack(string RulesId, string Name, SheetPackContent[] Contents);
    private sealed record PackPlan(SheetPackOption Option, Item[]? Inventory);
    private static readonly Lazy<Dictionary<string, EquipmentPack>> catalog = new(() =>
    {
        using var stream = typeof(EquipmentPacks).Assembly.GetManifestResourceStream("DiceRealm.EquipmentPacks.json")
            ?? throw new InvalidOperationException("Equipment packs resource missing.");
        return (JsonSerializer.Deserialize<EquipmentPack[]>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidOperationException("Equipment packs resource invalid."))
            .ToDictionary(p => p.RulesId, StringComparer.Ordinal);
    });

    public static SheetPackOption[] View(Campaign c) => Plans(c).Select(p => p.Option).ToArray();

    public static (Character Character, string Summary) Apply(Campaign c, string key)
    {
        var plan = Plans(c).SingleOrDefault(p => p.Option.Key == key)
            ?? throw new GameException("invalid_character_command", "请选择已持有的服务端套装选项。");
        if (!plan.Option.Available) throw new GameException("pack_unavailable", plan.Option.Reason, 409);
        var item = c.ActingCharacter.Inventory.Single(i => i.Id == plan.Option.ItemId);
        // Return acquisition state, not the sheet's temporary equipment/effect projection.
        var character = PlayResources.Ensure(c.ActingCharacter) with { Inventory = plan.Inventory! };
        return (character, character.Name + " 拆开 " + item.Name + " ×1；全部内容物已放入背包。");
    }

    private static IEnumerable<PackPlan> Plans(Campaign c)
    {
        string block = CharacterPlayEngine.Block(c);
        if (block == "" && CharacterPlayEngine.Unable(c.ActingCharacter)) block = "当前角色无法自行拆开套装。";
        foreach (var item in c.ActingCharacter.Inventory.Where(i => i.Quantity > 0).DistinctBy(i => i.Id, StringComparer.Ordinal))
        {
            string? identity = Identity(c, item);
            if (identity is not null && catalog.Value.TryGetValue(identity, out var pack))
                yield return Plan(c, item, pack, block);
        }
    }

    private static string? Identity(Campaign c, Item item) => ItemMetadata.Find(item.Id,
        item.RulesId ?? c.Adventure?.Items.FirstOrDefault(i => i.Id == item.Id)?.RulesId)?.Id;

    private static PackPlan Plan(Campaign c, Item item, EquipmentPack pack, string block)
    {
        var option = new SheetPackOption("unpack:" + item.Id, item.Id, pack.Contents.ToArray(), true);
        PackPlan Unavailable(string reason) => new(option with { Available = false, Reason = reason }, null);
        if (block != "") return Unavailable(block);

        var inventory = c.ActingCharacter.Inventory.ToList();
        if (inventory.Select(i => i.Id).Distinct(StringComparer.Ordinal).Count() != inventory.Count)
            return Unavailable("背包中存在重复物品 ID，无法确定拆包目标；请先修正库存。");
        if (inventory.FirstOrDefault(i => i.Quantity is < 1 or > 9999) is { } invalid)
            return Unavailable("背包中 " + invalid.Name + " 的数量不合法（须为 1–9999）；请先修正库存。");

        int packIndex = inventory.FindIndex(i => i.Id == item.Id);
        if (item.Quantity == 1) inventory.RemoveAt(packIndex);
        else inventory[packIndex] = item with { Quantity = item.Quantity - 1 };
        foreach (var content in pack.Contents)
        {
            string id = BuildCatalog.ItemId(content.Id);
            int index = inventory.FindIndex(i => i.Id == id);
            if (index < 0)
            {
                inventory.Add(new(id, content.Name, content.Quantity, false, content.RulesId));
                continue;
            }
            var previous = inventory[index];
            // The same runtime ID alone is not enough: never replace a custom or instance identity.
            if (Identity(c, previous) != content.RulesId)
                return Unavailable("背包中 " + previous.Name + " 与套装内容 " + content.Name + " 的物品 ID 相同，但规则身份不同；未拆开套装。");
            long quantity = (long)previous.Quantity + content.Quantity;
            if (quantity > 9999)
                return Unavailable("拆开后 " + content.Name + " 的数量会超过 9999；请先整理背包。");
            inventory[index] = previous with { Quantity = (int)quantity };
        }
        if (inventory.Count > 400)
            return Unavailable("拆开后背包会超过 400 项库存；请先整理背包。");
        var next = c.ActingCharacter with { Inventory = inventory.ToArray() };
        if (next.PlayState?.Loadout is { } loadout && EquipmentLoadout.Validate(next, loadout) is { Length: > 0 } reason)
            return Unavailable(reason);
        return new(option, next.Inventory);
    }
}
