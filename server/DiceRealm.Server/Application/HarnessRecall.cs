using System.Text;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessMemorySearchArgs(string Query, int Before = 0, int Limit = 6);
public sealed record HarnessMemoryReadArgs(string IntentId);
public sealed record HarnessMemorySearchResult(int Version, string Scope, HarnessMemoryEntry[] Entries, int? NextBefore);
public sealed record HarnessRecallStep(int Version, string Status, string Kind, string Summary, string RollId, DiceCheck? Check);
public sealed record HarnessRecallEntry(string IntentId, int OriginSequence, int ResultVersion, string Input, string Narrative,
    string NarrativeSource, bool Corrected, int TotalSteps, HarnessRecallStep[] Steps,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    NarrativeContinuityEntry[]? Continuity = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    StoryItemGrant[]? Acquisitions = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessRecallExtrasCoverage? ExtrasCoverage = null);
public sealed record HarnessRecallExtrasCoverage(int ContinuityTotal, int AcquisitionsTotal);
public sealed record HarnessMemoryReadResult(int Version, string Scope, HarnessRecallEntry Entry);

// Derived inside the authorized campaign gate. No separate index, model summary or private
// run transcript: persisted public action outcomes remain the only source of recall.
public static class HarnessRecall
{
    public const string Scope = "own_completed_public_actions";
    public const int MaximumReadBytes = 49152;
    private static GameException Invalid() => new("harness_invalid_payload", "历史查询参数不符合合同。");
    private static int Bytes<T>(T value) => Encoding.UTF8.GetByteCount(HarnessJson.Serialize(value));

    public static HarnessMemorySearchResult Search(Campaign c, HarnessMemorySearchArgs args)
    {
        if (args.Query is null || args.Query.Length > 120 || args.Query.Any(char.IsControl) ||
            args.Before < 0 || args.Before > c.Version || args.Limit is < 1 or > 6) throw Invalid();
        var words = args.Query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 8) throw Invalid();
        bool Matches(PendingIntent intent)
        {
            var narrative = c.AdventureCorrections.FirstOrDefault(x => x.OriginSequence == intent.RootSequence)?.Text ?? HarnessMemories.Narrative(c, intent);
            return words.All(word => intent.Text.Contains(word, StringComparison.OrdinalIgnoreCase) ||
                narrative.Contains(word, StringComparison.OrdinalIgnoreCase) ||
                (intent.HarnessSteps ?? []).Any(step => HarnessMemories.Settled(step.Result) && HarnessMemories.PublicResult(c, step.Result).Summary.Contains(word, StringComparison.OrdinalIgnoreCase)));
        }
        var matches = HarnessMemories.Eligible(c).Where(i => args.Before == 0 || i.RootSequence < args.Before)
            .OrderByDescending(i => i.RootSequence).Where(Matches).Take(args.Limit + 1).ToArray();
        var entries = matches.Take(args.Limit).Select(i => HarnessMemories.Project(c, i)).ToList();
        HarnessMemorySearchResult Result() => new(c.Version, Scope, entries.ToArray(),
            matches.Length > entries.Count ? entries[^1].OriginSequence : null);
        // A page shortened by the byte budget still exposes the next authorized root cursor.
        // Never return an empty page with an unadvanceable cursor.
        while (entries.Count > 1 && Bytes(Result()) > HarnessMemories.MaximumBytes) entries.RemoveAt(entries.Count - 1);
        var result = Result(); HarnessJson.Bound(result, HarnessMemories.MaximumBytes); return result;
    }

    public static HarnessMemoryReadResult Read(Campaign c, HarnessMemoryReadArgs args, int toolContractVersion = 22)
    {
        if (!Guid.TryParseExact(args.IntentId, "D", out var parsed)) throw Invalid();
        string id = parsed.ToString();
        var intent = HarnessMemories.Eligible(c).FirstOrDefault(i => i.Id == id) ??
            throw new GameException("harness_memory_unavailable", "没有当前席位可读取的这条已公开历史。", 404);
        var correction = c.AdventureCorrections.FirstOrDefault(x => x.OriginSequence == intent.RootSequence);
        var settled = (intent.HarnessSteps ?? []).Where(step => HarnessMemories.Settled(step.Result)).ToArray();
        var steps = settled.TakeLast(8).Select(step => new HarnessRecallStep(step.Sequence, step.Result.Status, step.Result.Kind,
            HarnessMemories.Clip(HarnessMemories.PublicResult(c, step.Result).Summary, 240), step.Result.RollId, step.Result.Check)).ToList();
        var continuity = toolContractVersion >= 23 && correction is null ? intent.Continuity?.ToList() : null;
        var acquisitions = toolContractVersion >= 23 ? intent.StoryAcquisitions?.ToList() : null;
        var coverage = continuity is not null || acquisitions is not null
            ? new HarnessRecallExtrasCoverage(continuity?.Count ?? 0, acquisitions?.Count ?? 0) : null;
        HarnessMemoryReadResult Result() => new(c.Version, Scope, new(intent.Id, intent.RootSequence, HarnessMemories.ResultVersion(intent),
            intent.Text, correction?.Text ?? HarnessMemories.Narrative(c, intent), correction is null ? intent.NarrativeSource : "host_correction",
            correction is not null, settled.Length, steps.ToArray(),
            continuity?.ToArray(), acquisitions?.ToArray(), coverage));
        // Optional model notes/source assertions cannot crowd out the full public
        // narrative or original authoritative steps. Totals make omissions explicit.
        while (acquisitions is { Count: > 0 } && Bytes(Result()) > MaximumReadBytes) acquisitions.RemoveAt(acquisitions.Count - 1);
        while (continuity is { Count: > 0 } && Bytes(Result()) > MaximumReadBytes) continuity.RemoveAt(continuity.Count - 1);
        while (steps.Count > 0 && Bytes(Result()) > MaximumReadBytes) steps.RemoveAt(0);
        var result = Result(); HarnessJson.Bound(result, MaximumReadBytes); return result;
    }
}
