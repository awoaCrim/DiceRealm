using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessSupplyContext(int Version, string SceneId, StorySupply[] Entries, int Total, int? NextOffset, string Notice)
{
    public static HarnessSupplyContext Read(Campaign c, int offset = 0, int limit = 12)
    {
        var all = StorySupplies.Current(c);
        if (offset < 0 || offset > all.Length || limit is < 1 or > 24)
            throw new GameException("harness_invalid_payload", "当地物资游标无效。");
        return new(c.Version, c.SceneId, all.Skip(offset).Take(limit).ToArray(), all.Length,
            offset + limit < all.Length ? offset + limit : null,
            "Recorded local supplies only, not a survey of all objects. Permission/source are narrated assertions; remaining is server stock. Claim items with source.kind=supply and its id. Unit is one catalog inventory unit, not a rules conversion. context_read scope=supplies pages further entries. No match means unrecorded, not absent.");
    }
    public static void Validate(HarnessSupplyContext value, int version, string sceneId)
    {
        if (value.Version != version || value.SceneId != sceneId || value.Entries is null || value.Entries.Length > 24 ||
            value.Total < value.Entries.Length || value.NextOffset is { } next && (next < 1 || next >= value.Total) ||
            value.Notice is null || value.Notice.Length > 800 || value.Entries.Any(s => s is null ||
                s.SceneId != sceneId || string.IsNullOrEmpty(s.Id) || s.Id.Length > 160 || s.ItemId is null || s.ItemId.Length > 160 ||
                s.Name is null || s.Name.Length > 60 || s.Quantity is < 0 or > 9999 || s.Claimed < 0 || s.Claimed > s.Quantity ||
                string.IsNullOrWhiteSpace(s.Unit) || s.Unit.Length > 24 || s.Permission is not ("allowed" or "ask" or "unavailable") ||
                s.Source is null || s.Source.Kind is not ("current_scene" or "public_memory") || string.IsNullOrEmpty(s.Source.Id) ||
                s.Source.Id.Length > 160 || string.IsNullOrWhiteSpace(s.Source.Detail) || s.Source.Detail.Length > 240) ||
            value.Entries.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() != value.Entries.Length)
            throw new InvalidDataException("Invalid local supplies frame.");
    }
}
