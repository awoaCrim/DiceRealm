using System.Text;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessProfileRequest(HarnessPreset Preset, HarnessSkill[] Skills);
public sealed record SaveHarnessDraftRequest(string RequestId, int ExpectedWorkspaceVersion, HarnessPreset Preset, HarnessSkill[] Skills);
public sealed record PublishHarnessRequest(string RequestId, int ExpectedWorkspaceVersion);
public sealed record ActivateHarnessRequest(string RequestId, int ExpectedWorkspaceVersion, int Revision);
public sealed record HarnessWorkspace(int Version, int ActiveRevision, int LatestRevision, HarnessProfile Draft, HarnessProfile Active);
public sealed record HarnessWorkspaceResult(HarnessWorkspace Workspace, bool Replayed);
public sealed record HarnessRevision(int Revision, string Hash, string PresetId, int PresetVersion, DateTimeOffset CreatedAt);
public sealed record HarnessRevisionPage(HarnessRevision[] Items, int? NextBefore);
public sealed record HarnessRevisionContent(HarnessRevision Revision, HarnessProfile Profile);
public sealed record HarnessMemoryStep(int Version, string Status, string Kind, string Summary, string RollId);
public sealed record HarnessMemoryEntry(string IntentId, int OriginSequence, int ResultVersion, string Input, string Narrative,
    string NarrativeSource, bool Corrected, HarnessMemoryStep[] Steps);
public sealed record HarnessMemory(int Version, string ActorId, HarnessMemoryEntry[] Entries)
{
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessArchiveMemory? Archive { get; init; }
}
public sealed record HarnessStartContext(HarnessProfile Profile, HarnessMemory Memory, string? RulesCatalogVersion = null);

// Derived only from the same seat's already-published outcomes. Never another writable state
// store, a full transcript, host visibility bypass, or a source of future mechanical effects.
public static class HarnessMemories
{
    public const int MaximumBytes = 24576;
    internal static string Clip(string value, int limit)
    {
        if (value.Length <= limit) return value;
        return value[..(char.IsHighSurrogate(value[limit - 1]) ? limit - 1 : limit)];
    }
    public static void Validate(HarnessMemory memory)
    {
        if (memory.Version < 1 || string.IsNullOrEmpty(memory.ActorId) || memory.Entries is null || memory.Entries.Length > 12 ||
            memory.Entries.Any(e => e is null || !Guid.TryParseExact(e.IntentId, "D", out _) || e.OriginSequence < 1 ||
                e.ResultVersion < e.OriginSequence || e.ResultVersion > memory.Version || e.Input is not { Length: > 0 and <= 240 } ||
                e.Narrative is null || e.Narrative.Length > 800 || e.NarrativeSource is not { Length: > 0 and <= 80 } || e.Steps is null || e.Steps.Length > 4 ||
                e.Steps.Any(s => s is null || s.Version < e.OriginSequence || s.Version > e.ResultVersion || s.Status is not { Length: > 0 and <= 80 } ||
                    s.Kind is not { Length: > 0 and <= 80 } || s.Summary is null || s.Summary.Length > 240 || s.RollId is null ||
                    s.RollId.Length > 0 && !Guid.TryParseExact(s.RollId, "D", out _))) ||
            memory.Entries.Select(e => e.IntentId).Distinct().Count() != memory.Entries.Length) throw new InvalidDataException();
        if (memory.Archive is not null) HarnessLongMemory.ValidateArchive(memory.Archive, memory.Version);
        HarnessJson.Bound(memory, MaximumBytes);
    }
    internal static Resolution PublicResult(Campaign c, Resolution result) => CombatVisibility.ForViewer(c, result, publicOnly: true);
    internal static string Narrative(Campaign c, PendingIntent intent)
    {
        string text = intent.Narrative;
        foreach (var step in intent.HarnessSteps ?? []) text = CombatVisibility.ProjectGeneratedText(c, text, step.Result, publicOnly: true);
        return text;
    }
    internal static bool Settled(Resolution result) => result.Status is not ("awaiting_roll" or "awaiting_confirmation" or "needs_adjudication" or "cancelled");
    internal static IEnumerable<PendingIntent> Eligible(Campaign c) => c.PendingIntents.Where(i =>
        i.ActorId == c.ActingActorId && i.Source == "harness" && i.Published && i.Status == "completed" && i.Result is not null && Settled(i.Result));
    // Older multi-step executions could leave the marker at the preceding intent event.
    // Derive from saved evidence without rewriting history, receipts or frozen run memories.
    // Do not clamp to the campaign version: future/corrupt steps must still fail validation.
    internal static int ResultVersion(PendingIntent intent) =>
        Math.Max(intent.Version, (intent.HarnessSteps ?? []).Select(step => step.Sequence).DefaultIfEmpty(intent.Version).Max());

    internal static HarnessMemoryEntry Project(Campaign c, PendingIntent intent)
    {
        var correction = c.AdventureCorrections.FirstOrDefault(x => x.OriginSequence == intent.RootSequence);
        var steps = (intent.HarnessSteps ?? []).Where(s => Settled(s.Result)).TakeLast(4)
            .Select(s => new HarnessMemoryStep(s.Sequence, s.Result.Status, s.Result.Kind, Clip(PublicResult(c, s.Result).Summary, 240), s.Result.RollId)).ToArray();
        return new(intent.Id, intent.RootSequence, ResultVersion(intent), Clip(intent.Text, 240), Clip(correction?.Text ?? Narrative(c, intent), 800),
            correction is null ? intent.NarrativeSource : "host_correction", correction is not null, steps);
    }
    public static HarnessMemory Build(Campaign c)
    {
        var entries = Eligible(c).OrderBy(i => i.RootSequence).TakeLast(12).Select(i => Project(c, i)).ToList();
        HarnessMemory Snapshot() => new(c.Version, c.ActingActorId, entries.ToArray());
        while (entries.Count > 0 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(Snapshot())) > MaximumBytes) entries.RemoveAt(0);
        return Snapshot();
    }
}
