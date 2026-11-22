using System.Text.Json;

namespace DiceRealm.Server.Domain;

// Display facts only. A matching identity grants no equipment effect or executable operation.
public sealed record ItemMetadata(string Id, decimal? WeightPounds = null, decimal? PriceCp = null, string Rarity = "")
{
    private static readonly Lazy<Dictionary<string, ItemMetadata>> catalog = new(() =>
    {
        using var stream = typeof(ItemMetadata).Assembly.GetManifestResourceStream("DiceRealm.ItemMetadata.json")!;
        return JsonSerializer.Deserialize<ItemMetadata[]>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))!
            .ToDictionary(i => i.Id, StringComparer.Ordinal);
    });

    public static ItemMetadata? Find(string itemId, string? rulesId)
    {
        // Explicit but unknown identities do not fall back to a misleading runtime ID or mutable name.
        string id = rulesId ?? (itemId is "gold-piece" or "silver-piece" or "copper-piece"
            ? "equipment:xphb:" + itemId
            : PlayCatalog.Equipment(itemId) is { } equipment ? "equipment:xphb:" + equipment.Id : "");
        if (id.StartsWith("xphb:", StringComparison.Ordinal)) id = "equipment:" + id;
        else if (id.StartsWith("xdmg:", StringComparison.Ordinal)) id = "magic_item:" + id;
        // XPHB p213: fifty coins weigh a pound; the three supported currencies have fixed denominations.
        decimal? coin = id switch
        {
            "equipment:xphb:gold-piece" => 100m,
            "equipment:xphb:silver-piece" => 10m,
            "equipment:xphb:copper-piece" => 1m,
            _ => null
        };
        if (coin is not null) return new(id, 0.02m, coin, "none");
        return catalog.Value.GetValueOrDefault(id);
    }
}
