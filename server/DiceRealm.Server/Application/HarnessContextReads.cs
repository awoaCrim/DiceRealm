using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record HarnessContextReadArgs(string Scope = "context", string Query = "", int Offset = 0, int Limit = 12);
public sealed record HarnessCatalogItem(string ItemId, string Name, string CanonicalName, string[] Aliases);

// Optional detail reads use existing authoritative projections/IDs, never a second item registry.
public static class HarnessContextReads
{
    public static void Validate(HarnessContextReadArgs args, int contract = 23)
    {
        if (!(args.Scope is "context" or "character" or "items" || contract >= 25 && args.Scope is "scene" or "supplies") ||
            args.Query is null || args.Query.Length > 120 || args.Query.Any(char.IsControl) || args.Offset < 0 || args.Limit is < 1 or > 24 ||
            args.Scope != "items" && args.Query != "" ||
            args.Scope is not ("items" or "supplies") && (args.Offset != 0 || args.Limit != 12))
            throw new GameException("harness_invalid_payload", "上下文范围或物品目录查询参数无效。");
    }
    public static object Items(int version, HarnessContextReadArgs args, LocalRulesPackage? package = null, int toolContractVersion = 23)
    {
        if (toolContractVersion >= 26) return HarnessItemSearch.Read(version, args, package);
        Validate(args);
        var words = args.Query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var entries = Catalog(package).Select(source => source.Item).Where(item => words.All(word => item.ItemId.Contains(word, StringComparison.OrdinalIgnoreCase) ||
            item.Name.Contains(word, StringComparison.OrdinalIgnoreCase) || item.CanonicalName.Contains(word, StringComparison.OrdinalIgnoreCase) ||
            item.Aliases.Any(alias => alias.Contains(word, StringComparison.OrdinalIgnoreCase)))).ToArray();
        if (args.Offset > entries.Length) throw new GameException("harness_invalid_payload", "物品目录游标超出结果范围。");
        return new
        {
            version, scope = "supported_acquisition_catalog", total = entries.Length, chineseNamesAvailable = package is not null,
            entries = entries.Skip(args.Offset).Take(args.Limit).ToArray(),
            nextOffset = args.Offset + args.Limit < entries.Length ? (int?)(args.Offset + args.Limit) : null,
            coverage = "Supported catalog identities only, not possessions or permission to acquire. Search Chinese name or exact ID; missing matches do not prove an object does not exist. Unique non-mechanical props may use empty itemId plus name."
        };
    }
    internal static (HarnessCatalogItem Item, LocalRuleEntry? Rule)[] Catalog(LocalRulesPackage? package) => StoryInventory.CatalogIds(includeWearables: true).Select(id =>
        {
            string canonical = WearableCatalog.ById(id)?.Name ?? PlayCatalog.ItemName(id);
            string? identity = WearableCatalog.ById(id)?.RulesId ?? ItemMetadata.Find(id, null)?.Id;
            var matches = package?.Entries.Where(e => e.Category is "equipment" or "magic_item" &&
                (e.Id == identity || e.Id == e.Category + ":" + identity)).ToArray() ?? [];
            var rule = matches.Length == 1 ? matches[0] : null;
            return (new HarnessCatalogItem(id, rule?.Name ?? canonical, canonical, rule?.Aliases ?? []), rule);
        }).ToArray();

    public static void RejectCatalogProps(IEnumerable<(string ItemId, string Name)> items, LocalRulesPackage? package)
    {
        var custom = items.Where(i => i.ItemId == "" && i.Name is not null).ToArray();
        if (custom.Length == 0) return;
        var catalog = Catalog(package).Select(source => source.Item).ToArray();
        foreach (var item in custom)
            if (catalog.FirstOrDefault(c => c.Name.Equals(item.Name.Trim(), StringComparison.OrdinalIgnoreCase) ||
                c.CanonicalName.Equals(item.Name.Trim(), StringComparison.OrdinalIgnoreCase) ||
                c.Aliases.Contains(item.Name.Trim(), StringComparer.OrdinalIgnoreCase)) is { } match)
                throw new GameException("invalid_story_items", $"{item.Name}对应标准物品{match.ItemId}；使用该itemId和空name，不能创建同名无规则道具。");
    }
}
