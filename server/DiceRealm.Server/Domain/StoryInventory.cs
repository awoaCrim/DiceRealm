using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace DiceRealm.Server.Domain;

// A narrated acquisition is an explicit inventory operation, never parsed from prose.
// Catalog identities keep server-owned rules; custom story props have no implied mechanics.
public sealed record StoryItemSource(string Kind, string Id, string Detail);
public sealed record StoryItemGrant(string ItemId, string Name, int Quantity,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    StoryItemSource? Source = null);
public static class StoryInventory
{
    public static string[] CatalogIds(bool includeWearables = false) => BuildCatalog.Get().Equipment.Select(e => BuildCatalog.ItemId(e.Id))
        .Concat(["gold-piece", "silver-piece", "copper-piece"]).Concat(includeWearables ? WearableCatalog.Items.Select(i => i.Id) : [])
        .Distinct(StringComparer.Ordinal).ToArray();
    public static string InstancePrefix(string intentId, string catalogId) => "magic-item:" +
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(intentId + "\n" + catalogId)))[..24] + ":";

    public static Item[]? Plan(Campaign c, PendingIntent intent, StoryItemGrant[]? grants, bool includeWearables = false,
        bool requireSources = false, IReadOnlySet<string>? offeredMemoryIds = null, IReadOnlyList<StorySupply>? supplies = null)
    {
        if (grants is null || grants.Length == 0) return null;
        if (grants.Length > 16) throw Invalid();
        var inventory = c.ActingCharacter.Inventory.ToList();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var grant in grants)
        {
            if (grant is null || grant.ItemId is null || grant.Name is null || grant.Quantity is < 1 or > 9999) throw Invalid();
            if (requireSources && grant.Source?.Kind == "supply" && supplies is not null)
            {
                if (!supplies.Any(s => s.Id == grant.Source.Id && s.SceneId == c.SceneId && s.ItemId == grant.ItemId && s.Name == grant.Name.Trim())) throw Invalid();
            }
            else if (requireSources) ValidateSource(c, grant.Source, offeredMemoryIds);
            else if (grant.Source is not null) throw Invalid();
            string id = grant.ItemId, name;
            if (WearableCatalog.ById(id) is { } wearable)
            {
                if (!includeWearables || grant.Name != "" || !keys.Add(id)) throw Invalid();
                string prefix = InstancePrefix(intent.Id, id);
                int acquiredInstances = (intent.HarnessSteps ?? []).SelectMany(s => s.Origin?.Changes ?? [])
                    .Where(change => change.ActorId == c.ActingActorId && change.Operation == "inventory" && change.Key.StartsWith(prefix, StringComparison.Ordinal))
                    .Sum(Acquired);
                if (acquiredInstances > 0)
                {
                    if (acquiredInstances != grant.Quantity) throw new GameException("invalid_story_items", "本行动已经记录此物品，不能用不同数量重复领取。", 409);
                    continue;
                }
                if (inventory.Count + grant.Quantity > 400) throw Invalid();
                for (int ordinal = 0; ordinal < grant.Quantity; ordinal++)
                {
                    string instanceId = prefix + ordinal.ToString(CultureInfo.InvariantCulture);
                    if (inventory.Any(i => i.Id == instanceId)) throw Invalid();
                    inventory.Add(new(instanceId, wearable.Name, 1, false, wearable.RulesId));
                }
                continue;
            }
            if (id == "")
            {
                name = grant.Name.Trim();
                if (name.Length is < 1 or > 60 || name.Any(char.IsControl)) throw Invalid();
                id = "story-item:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(name)))[..16];
            }
            else
            {
                name = PlayCatalog.ItemName(id);
                if (name == "" || grant.Name != "") throw Invalid();
            }
            if (!keys.Add(id)) throw Invalid();
            // Quantity means the total acquired in this action. Original tool receipts
            // cover transport replay; saved action changes cover a new duplicate tool call.
            int acquired = (intent.HarnessSteps ?? []).SelectMany(s => s.Origin?.Changes ?? [])
                .Where(change => change.ActorId == c.ActingActorId && change.Operation == "inventory" && change.Key == id)
                .Sum(Acquired);
            if (acquired > 0)
            {
                if (acquired != grant.Quantity) throw new GameException("invalid_story_items", "本行动已经记录此物品，不能用不同数量重复领取。", 409);
                continue;
            }
            int index = inventory.FindIndex(item => item.Id == id);
            var previous = index < 0 ? null : inventory[index];
            if ((long)(previous?.Quantity ?? 0) + grant.Quantity > 9999) throw Invalid();
            var next = new Item(id, previous?.Name ?? name, (previous?.Quantity ?? 0) + grant.Quantity, previous?.Equipped == true, previous?.RulesId);
            if (index < 0) inventory.Add(next); else inventory[index] = next;
        }
        if (inventory.Count > 400) throw Invalid();
        return inventory.ToArray();
    }
    // A real current reference is checked here; the narrative detail remains a model
    // assertion, not proof of ownership or a new way to settle authored rewards.
    internal static void ValidateSource(Campaign c, StoryItemSource? source, IReadOnlySet<string>? offeredMemoryIds)
    {
        if (source is null || string.IsNullOrWhiteSpace(source.Detail) || source.Detail.Length > 240 || source.Detail.Any(char.IsControl))
            throw new GameException("invalid_story_items", "本次获物需要当前来源及交付依据；旧叙事核实不补发，数量不明先询问。");
        bool valid = source.Kind == "current_scene" && source.Id == c.SceneId && c.VisitedScenes.Contains(c.SceneId) ||
            source.Kind == "public_memory" && offeredMemoryIds?.Contains(source.Id) == true &&
            WorldMemories.Find(c, source.Id) is { } entry && WorldMemories.IsPublic(c, entry) && entry.SceneId == c.SceneId &&
            entry.Kind is "npc" or "place" or "clue";
        if (!valid) throw new GameException("invalid_story_items", "获物来源必须是当前已知场景或本轮读到的当地公开对象；历史记录、规则目录和未知对象不能作为当前领取依据。");
    }
    private static int Acquired(ActionChange change) => int.TryParse(change.Before, NumberStyles.Integer, CultureInfo.InvariantCulture, out int before) &&
        int.TryParse(change.After, NumberStyles.Integer, CultureInfo.InvariantCulture, out int after) ? Math.Max(0, after - before) : 0;
    private static GameException Invalid() => new("invalid_story_items", "物品名称、目录身份或数量无效；未发放任何物品。");
}
