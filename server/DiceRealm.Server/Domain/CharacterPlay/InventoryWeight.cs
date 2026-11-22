namespace DiceRealm.Server.Domain;

// Carried inventory only: equipped items are already in it, and pack weights include their contents.
public static class InventoryWeight
{
    public static SheetWeightView Project(Character character, ContentItem[]? contentItems = null)
    {
        decimal totalPounds = 0;
        long unknownCount = 0;
        foreach (var item in character.Inventory.Where(i => i.Quantity > 0))
        {
            string? rulesId = item.RulesId ?? contentItems?.FirstOrDefault(i => i.Id == item.Id)?.RulesId;
            decimal? weight = ItemMetadata.Find(item.Id, rulesId)?.WeightPounds;
            if (weight is { } pounds) totalPounds += pounds * item.Quantity;
            else unknownCount += item.Quantity;
        }
        var strength = character.Abilities.FirstOrDefault(a => a.Name == "strength");
        string[] sizes = ["T", "S", "M", "L", "H", "G"];
        int size = Array.IndexOf(sizes, character.BuildMechanics?.Size);
        if (strength is null || strength.Score < 1 || size < 0)
            return new(totalPounds, unknownCount, CapacityNotice: "缺少有效力量或体型，负重上限未记录。");
        // dnd2024 / XPHB p362; Powerful Build counts as one size larger, not a universal multiplier.
        bool powerful = character.Features.Contains("Powerful Build", StringComparer.Ordinal);
        if (powerful) size++;
        if (size >= sizes.Length)
            return new(totalPounds, unknownCount, CapacityNotice: "该有效体型超出已核负重表，负重上限未记录。");
        decimal[] factors = [7.5m, 15m, 15m, 30m, 60m, 120m];
        string notice = powerful ? "按当前力量和体型计算；强健体魄按大一级体型。" : "按当前力量和体型计算。";
        return new(totalPounds, unknownCount, HasCapacity: true, CapacityPounds: strength.Score * factors[size],
            CapacityNotice: notice + "仅显示携带上限，不自动施加超重惩罚。");
    }
}
