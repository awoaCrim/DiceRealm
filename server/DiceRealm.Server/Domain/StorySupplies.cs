using System.Security.Cryptography;
using System.Text;

namespace DiceRealm.Server.Domain;

public sealed record StorySupplyProposal(string Id, string ItemId, string Name, int Quantity, string Unit,
    string Permission, StoryItemSource Source);
public sealed record StorySupply(string Id, string SceneId, string ItemId, string Name, int Quantity, int Claimed,
    string Unit, string Permission, StoryItemSource Source)
{
    public int Remaining => Quantity - Claimed;
}

// Local narrated stock only; authored rewards, shops and mechanical effects keep their own owners.
public static class StorySupplies
{
    public static StorySupply[] Current(Campaign c) => c.VisitedScenes.Contains(c.SceneId)
        ? (c.StorySupplies ?? []).Where(s => IsCurrent(c, s)).ToArray() : [];

    private static bool IsCurrent(Campaign c, StorySupply s) => s.SceneId == c.SceneId && c.VisitedScenes.Contains(c.SceneId) &&
        (s.Source.Kind == "current_scene" && s.Source.Id == c.SceneId || s.Source.Kind == "public_memory" &&
            WorldMemories.Find(c, s.Source.Id) is { } source && WorldMemories.IsPublic(c, source) &&
            source.SceneId == c.SceneId && source.Kind is "npc" or "place" or "clue");

    public static (List<StorySupply> Supplies, StoryItemGrant[]? Grants) Plan(Campaign c, PendingIntent intent,
        StorySupplyProposal[]? proposals, StoryItemGrant[]? grants, IReadOnlySet<string> memoryIds)
    {
        var supplies = (c.StorySupplies ?? []).ToList();
        var created = new HashSet<string>(StringComparer.Ordinal);
        if (proposals is { Length: > 16 }) throw Invalid("一次最多记录16种当地物资。");
        foreach (var p in proposals ?? [])
        {
            if (p is null || p.Id is null || p.ItemId is null || p.Name is null || p.Quantity is < 0 or > 9999 ||
                string.IsNullOrWhiteSpace(p.Unit) || p.Unit.Length > 24 || p.Unit.Any(char.IsControl) ||
                p.Permission is not ("allowed" or "ask" or "unavailable")) throw Invalid("物资身份、数量、单位或领取许可无效。");
            StoryInventory.ValidateSource(c, p.Source, memoryIds);
            ValidateIdentity(p.ItemId, p.Name);
            string identity = p.ItemId == "" ? p.Name.Trim() : p.ItemId;
            string id = "supply:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
                c.SceneId + "\n" + p.Source.Kind + "\n" + p.Source.Id + "\n" + identity)))[..24];
            if (!created.Add(id) || p.Id != "" && p.Id != id) throw Invalid("物资引用无效或重复；更新需使用当前条目的原ID。");
            int index = supplies.FindIndex(s => s.Id == id);
            var old = index < 0 ? null : supplies[index];
            if (p.Id != "" && old is null || old is not null &&
                (old.ItemId != p.ItemId || old.Name != p.Name.Trim() || old.Unit != p.Unit || p.Quantity < old.Claimed))
                throw Invalid("不能更换已记录物资的身份或单位，也不能把总量改为低于已领取量。");
            if (old is not null && p.Id == "" && (old.Quantity != p.Quantity || old.Permission != p.Permission))
                throw Invalid("该来源的物资已记录；变化请使用原ID更新，不能重新创建来补满库存。");
            var next = new StorySupply(id, c.SceneId, p.ItemId, p.Name.Trim(), p.Quantity, old?.Claimed ?? 0, p.Unit, p.Permission, p.Source);
            if (index < 0) supplies.Add(next); else supplies[index] = next;
        }
        var normalized = grants?.ToArray();
        for (int i = 0; i < (normalized?.Length ?? 0); i++)
        {
            var grant = normalized![i];
            if (grant is null || grant.ItemId is null || grant.Name is null || grant.Quantity is < 1 or > 9999)
                throw Invalid("领取身份或数量无效。");
            if (grant.ItemId == "") grant = grant with { Name = grant.Name.Trim() };
            normalized[i] = grant;
            var previous = (intent.StoryAcquisitions ?? []).FirstOrDefault(g => g.ItemId == grant.ItemId && g.Name.Trim() == grant.Name);
            var matches = supplies.Where(s => IsCurrent(c, s) && s.ItemId == grant.ItemId && s.Name == grant.Name.Trim()).ToArray();
            if (grant.Source?.Kind != "supply")
            {
                if (matches.Length > 0) throw Invalid("该物品已有当地物资记录；领取必须引用其supply ID，不能绕过剩余量。");
                continue;
            }
            if (string.IsNullOrWhiteSpace(grant.Source.Detail) || grant.Source.Detail.Length > 240 || grant.Source.Detail.Any(char.IsControl))
                throw Invalid("领取需要当前交付依据。");
            // Empty reference is allowed only for an unambiguous matching declaration in this same transaction.
            var supply = grant.Source.Id == ""
                ? matches.Where(s => created.Contains(s.Id)).SingleOrDefaultSafe()
                : matches.FirstOrDefault(s => s.Id == grant.Source.Id);
            if (supply is null) throw Invalid("领取需引用当前场景同一物品的物资ID；新声明引用为空时必须唯一匹配。");
            grant = grant with { Source = grant.Source with { Id = supply.Id } };
            normalized[i] = grant;
            if (previous is not null)
            {
                if (previous.Quantity != grant.Quantity || previous.Source?.Kind != "supply" || previous.Source.Id != supply.Id)
                    throw Invalid("本行动已记录领取；不能更换来源或数量重复领取。");
                continue;
            }
            if (supply.Permission != "allowed" || supply.Remaining < grant.Quantity)
                throw Invalid("尚无领取许可或剩余量不足；未保存叙事、物资或背包变化。");
            int index = supplies.FindIndex(s => s.Id == supply.Id);
            supplies[index] = supply with { Claimed = supply.Claimed + grant.Quantity };
        }
        return (supplies, normalized);
    }

    private static StorySupply? SingleOrDefaultSafe(this IEnumerable<StorySupply> source)
    {
        var matches = source.Take(2).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }
    private static void ValidateIdentity(string itemId, string name)
    {
        if (itemId == "")
        {
            if (name.Trim().Length is < 1 or > 60 || name.Any(char.IsControl)) throw Invalid("自定义物资名称无效。");
        }
        else if (name != "" || !StoryInventory.CatalogIds(includeWearables: true).Contains(itemId, StringComparer.Ordinal))
            throw Invalid("标准物资必须使用支持的目录ID及空名称。");
    }
    private static GameException Invalid(string message) => new("invalid_story_items", message);
}
