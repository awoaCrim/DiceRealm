using System.Text;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessWorldSearchArgs(string Query, string Kind = "", int Offset = 0, int Limit = 6);
public sealed record HarnessWorldSearchResult(int Version, string Scope, WorldMemoryEntry[] Entries, int? NextOffset,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? Coverage = null);

// The world is shared, but only PUBLIC knowledge may enter an ordinary player's model context.
// The authorized index never supplies host-only records to a model, even for a host run.
public static class HarnessWorldSearch
{
    public const int MaximumBytes = 24576;
    public static HarnessWorldSearchResult Search(Campaign c, HarnessWorldSearchArgs args, int contractVersion = 6)
    {
        if (args.Query is null || args.Query.Length > 120 || args.Query.Any(char.IsControl) ||
            args.Kind is not ("" or "npc" or "quest" or "place" or "clue") || (args.Offset < 0 || args.Offset > (contractVersion >= 7 ? WorldMemories.MaximumEntries : 256)) || args.Limit is < 1 or > 6)
            throw Invalid();
        var words = args.Query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 8) throw Invalid();
        int maximum = contractVersion >= 7 ? WorldMemories.MaximumEntries : 256;
        var matches = WorldMemories.Read(c, words, args.Kind, args.Offset, Math.Min(args.Limit + 1, maximum - args.Offset)).Entries;
        var entries = matches.Take(args.Limit).ToList();
        HarnessWorldSearchResult Result() => new(c.Version, "shared_public_world", entries.ToArray(),
            matches.Length > entries.Count ? args.Offset + entries.Count : null, contractVersion >= 23
                ? "Keyword matches in indexed public world records only; host/hidden/unrevealed knowledge and unrecorded people/places are excluded. No match means unknown here, not nonexistent; travel/recruitment/mechanics are separate capabilities." : null);
        while (entries.Count > 1 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(Result())) > MaximumBytes)
            entries.RemoveAt(entries.Count - 1);
        var result = Result(); HarnessJson.Bound(result, MaximumBytes); return result;
    }
    private static GameException Invalid() => new("harness_invalid_payload", "公开世界查询参数不符合合同。");
}
