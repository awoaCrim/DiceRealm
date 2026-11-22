using System.Text;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// Text is always an unchanged source slice. Offsets/lengths count UTF-16 code units, as .NET
// strings do. Truncated is an explicit marker, not an ellipsis that could be mistaken for prose.
public sealed record HarnessWorkingMemoryText(string Text, int SourceOffset, int OriginalLength, bool Truncated);
public sealed record HarnessWorkingMemoryStep(int Version, string Status, string Kind, HarnessWorkingMemoryText Summary,
    string RollId, DiceCheck? Check);
public sealed record HarnessWorkingMemoryEntry(string IntentId, int OriginSequence, int ResultVersion,
    HarnessWorkingMemoryText Input, string NarrativeSource, bool Corrected, bool Recent, string Representation,
    int NarrativeCharacters, HarnessWorkingMemoryText? Narrative, NarrativeContinuityEntry[] Continuity,
    int TotalContinuityEntries, HarnessWorkingMemoryText[] QuotedText, int TotalQuotedTexts,
    HarnessWorkingMemoryStep[] Steps, int TotalSteps);
public sealed record HarnessWorkingMemoryArchive(string SelectionMethod, int TotalOlderActions, HarnessWorkingMemoryEntry[] Selected);
public sealed record HarnessWorkingMemoryCoverage(int TotalEligibleActions, int RecentWindowActions, int ArchiveCandidates,
    int OmittedActions, bool BudgetReduced);
public sealed record HarnessWorkingMemory(int Version, string ActorId, string Scope, string Method, string Notice,
    HarnessWorkingMemoryEntry[] Entries, HarnessWorkingMemoryCoverage Coverage)
{
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public HarnessWorkingMemoryArchive? Archive { get; init; }
}

// Captured inside the authorized campaign gate for a new provider slot only. This does not
// modify Campaign, old HarnessMemory/MemorySnapshot, SDK messages or any authority/reference.
public static class HarnessWorkingMemories
{
    public const int MaximumBytes = 24 * 1024;
    public const int MaximumEntries = 12;
    public const int RecentNarratives = 2;
    public const int MaximumNarrativeCharacters = 800;
    public const string Method = "source-excerpts-and-model-reported-continuity-v1";
    public const string Notice = "Own completed PUBLIC history, excluding this intent. Steps are authoritative; continuity is model-reported, not fulfilled promises or mechanical truth. Legacy prose/last four quote-context sentences are exact extracts, not semantic summaries; overlong quote contexts are omitted, never reduced to an isolated claim. Offsets/lengths use UTF-16; truncated and totals disclose omissions. memory_read(intentId) reads full evidence; memory searches find omitted actions. No private text or other seats.";
    private const int MaximumInputCharacters = 240;
    private const int MaximumLegacyCharacters = 480;
    private const int MaximumQuotedTexts = 4;
    private const int MaximumQuoteCharacters = 480;
    private const int MaximumStepCharacters = 240;
    private const int MaximumSteps = 4;
    private const int MaximumArchiveSteps = 2;
    private const string ArchiveSelectionMethod = "source-extracts-v1/" + HarnessLongMemory.Algorithm;

    private static int Bytes(HarnessWorkingMemory memory) => Encoding.UTF8.GetByteCount(HarnessProviderJson.Serialize(memory));

    private static HarnessWorkingMemoryText Extract(string source, int limit, int sourceOffset = 0)
    {
        string text = HarnessMemories.Clip(source, limit);
        return new(text, sourceOffset, source.Length, text.Length < source.Length);
    }

    // Delimiter matching is deliberately not called a dialogue parser or a semantic summary.
    // Preserve quoted negations/attributions verbatim, including punctuation and source ranges.
    private static (HarnessWorkingMemoryText[] Entries, int Total) Quotes(string source)
    {
        var entries = new List<HarnessWorkingMemoryText>();
        int total = 0;
        bool Escaped(int offset)
        {
            int slashes = 0;
            for (int i = offset - 1; i >= 0 && source[i] == '\\'; i--) slashes++;
            return slashes % 2 != 0;
        }
        for (int start = 0; start < source.Length; start++)
        {
            char close = source[start] switch { '“' => '”', '「' => '」', '『' => '』', '‘' => '’', '"' => '"', _ => '\0' };
            if (close == '\0' || close == '"' && Escaped(start)) continue;
            int end = start + 1;
            while (end < source.Length && (source[end] != close || close == '"' && Escaped(end))) end++;
            if (end == source.Length) continue;
            // Keep outside attribution/negation: e.g. '没有说过“今晚出发”，只是猜测。'
            // must never become the bare positive quotation. Only emit complete bounded
            // sentence context; an overlong context is available via memory_read instead.
            static bool Boundary(char ch) => ch is '。' or '！' or '？' or '\n' or '\r' or '!' or '?';
            int begin = start;
            while (begin > 0 && !Boundary(source[begin - 1])) begin--;
            int finish = end + 1;
            while (finish < source.Length && !Boundary(source[finish])) finish++;
            if (finish < source.Length) finish++;
            total++;
            if (finish - begin <= MaximumQuoteCharacters && !entries.Any(e => e.SourceOffset == begin && e.OriginalLength == finish - begin))
                entries.Add(Extract(source[begin..finish], MaximumQuoteCharacters, begin));
            if (entries.Count > MaximumQuotedTexts) entries.RemoveAt(0);
            start = end;
        }
        return (entries.ToArray(), total);
    }

    private static HarnessWorkingMemoryStep Step(Campaign c, HarnessActionStep step)
    {
        // Detach the mutable dice arrays as well as the surrounding projection arrays.
        var check = step.Result.Check;
        if (check is not null) check = check with { Rolls = check.Rolls.ToArray(), BonusRolls = check.BonusRolls?.ToArray() };
        return new(step.Sequence, step.Result.Status, step.Result.Kind, Extract(HarnessMemories.PublicResult(c, step.Result).Summary, MaximumStepCharacters),
            step.Result.RollId, check);
    }

    private static HarnessWorkingMemoryEntry Project(Campaign c, PendingIntent intent, bool recent, bool archive)
    {
        var correction = c.AdventureCorrections.FirstOrDefault(value => value.OriginSequence == intent.RootSequence);
        string narrative = correction?.Text ?? HarnessMemories.Narrative(c, intent);
        // A correction supersedes ALL obsolete model notes, even when those notes would match
        // this input. Do not send the old prose, private text, correction reason or author.
        var continuity = correction is null ? (intent.Continuity ?? []).ToArray() : [];
        NarrativeContinuities.ValidateStored(continuity);
        string representation = correction is not null ? "host_correction" : recent ? "recent_original" :
            continuity.Length > 0 ? "model_reported_continuity" : "legacy_source_extract";
        var quoted = representation == "legacy_source_extract" ? Quotes(narrative) : (Entries: Array.Empty<HarnessWorkingMemoryText>(), Total: 0);
        var steps = (intent.HarnessSteps ?? []).Where(step => HarnessMemories.Settled(step.Result)).ToArray();
        return new(intent.Id, intent.RootSequence, HarnessMemories.ResultVersion(intent), Extract(intent.Text, MaximumInputCharacters),
            correction is null ? intent.NarrativeSource : "host_correction", correction is not null, recent, representation,
            narrative.Length, representation == "model_reported_continuity" ? null :
                Extract(narrative, representation == "legacy_source_extract"
                    ? (quoted.Entries.Length > 0 ? 120 : MaximumLegacyCharacters) : MaximumNarrativeCharacters),
            continuity, continuity.Length, quoted.Entries, quoted.Total,
            steps.TakeLast(archive ? MaximumArchiveSteps : MaximumSteps).Select(step => Step(c, step)).ToArray(), steps.Length);
    }

    public static HarnessWorkingMemory Build(Campaign c, string input, string currentIntentId, Func<PendingIntent, bool>? include = null)
    {
        var eligible = HarnessMemories.Eligible(c).Where(intent => intent.Id != currentIntentId && (include is null || include(intent)))
            .OrderBy(intent => intent.RootSequence).ThenBy(intent => intent.Id, StringComparer.Ordinal).ToArray();
        var window = eligible.TakeLast(MaximumEntries).ToArray();
        var recent = window.TakeLast(RecentNarratives).Select(intent => intent.Id).ToHashSet(StringComparer.Ordinal);
        var entries = window.Select(intent => Project(c, intent, recent.Contains(intent.Id), archive: false)).ToList();
        int totalOlder = eligible.Length - window.Length;
        var archive = new List<HarnessWorkingMemoryEntry>();
        if (totalOlder > 0)
        {
            // Reuse the existing query-relevant + cross-time selection (up to six anchors),
            // not a second heuristic relevance model. Only the presentation is new.
            var selected = HarnessLongMemory.ForRun(c, input).Archive?.Selected.Select(entry => entry.IntentId).ToHashSet(StringComparer.Ordinal)
                ?? [];
            archive.AddRange(eligible.Take(totalOlder).Where(intent => selected.Contains(intent.Id))
                .Select(intent => Project(c, intent, recent: false, archive: true)));
            if (archive.Count == 0 && include is not null) archive.Add(Project(c, eligible[totalOlder - 1], recent: false, archive: true));
        }
        int archiveCandidates = archive.Count;
        bool budgetReduced = false;
        HarnessWorkingMemory Result() => new(c.Version, c.ActingActorId, HarnessRecall.Scope, Method, Notice, entries.ToArray(),
            new(eligible.Length, window.Length, archiveCandidates, eligible.Length - entries.Count - archive.Count, budgetReduced))
        {
            Archive = archive.Count == 0 ? null : new(ArchiveSelectionMethod, totalOlder, archive.ToArray())
        };
        while (Bytes(Result()) > MaximumBytes)
        {
            // Preserve the two latest original previews and at least one old source anchor.
            // Detail reduction is explicit in source lengths/totals; never fabricate a summary.
            if (entries.Count > RecentNarratives) entries.RemoveAt(0);
            else if (Reduce(archive, FewerNotes) || Reduce(entries, FewerNotes)) { }
            else if (Reduce(archive, FewerQuotes)) { }
            else if (Reduce(archive, ShorterExtract) || Reduce(entries, ShorterExtract)) { }
            else if (Reduce(archive, FewerSteps) || Reduce(entries, FewerSteps)) { }
            else if (archive.Count > 1) archive.RemoveAt(archive.Count - 1);
            else throw new GameException("harness_context_limit", "历史片段无法在限制内保留必要来源与结果；不会外发或改写原历史。", 409);
            budgetReduced = true;
        }
        var result = Result();
        Validate(result);
        return result;
    }

    private static bool Reduce(List<HarnessWorkingMemoryEntry> entries, Func<HarnessWorkingMemoryEntry, HarnessWorkingMemoryEntry?> reduce)
    {
        for (int i = 0; i < entries.Count; i++)
        {
            var reduced = reduce(entries[i]);
            if (reduced is null) continue;
            entries[i] = reduced;
            return true;
        }
        return false;
    }
    private static HarnessWorkingMemoryEntry? FewerNotes(HarnessWorkingMemoryEntry entry) => entry.Continuity.Length > 1
        ? entry with { Continuity = entry.Continuity.Skip(1).ToArray() } : null;
    private static HarnessWorkingMemoryEntry? FewerQuotes(HarnessWorkingMemoryEntry entry) => entry.QuotedText.Length > 1
        ? entry with { QuotedText = entry.QuotedText.Skip(1).ToArray() } : null;
    private static HarnessWorkingMemoryEntry? FewerSteps(HarnessWorkingMemoryEntry entry) => entry.Steps.Length > 1
        ? entry with { Steps = entry.Steps.Skip(1).ToArray() } : null;
    private static HarnessWorkingMemoryText? Shorter(HarnessWorkingMemoryText text, int minimum)
    {
        if (text.Text.Length <= minimum) return null;
        string clipped = HarnessMemories.Clip(text.Text, Math.Max(minimum, text.Text.Length / 2));
        return text with { Text = clipped, Truncated = clipped.Length < text.OriginalLength };
    }
    private static HarnessWorkingMemoryEntry? ShorterExtract(HarnessWorkingMemoryEntry entry)
    {
        if (Shorter(entry.Input, 80) is { } input) return entry with { Input = input };
        if (!entry.Recent && entry.Narrative is { } narrative && Shorter(narrative, 160) is { } shorterNarrative)
            return entry with { Narrative = shorterNarrative };
        for (int i = 0; i < entry.QuotedText.Length; i++)
            if (Shorter(entry.QuotedText[i], 80) is { } quote)
            {
                var quotes = entry.QuotedText.ToArray();
                quotes[i] = quote;
                return entry with { QuotedText = quotes };
            }
        for (int i = 0; i < entry.Steps.Length; i++)
            if (Shorter(entry.Steps[i].Summary, 80) is { } summary)
            {
                var steps = entry.Steps.ToArray();
                steps[i] = steps[i] with { Summary = summary };
                return entry with { Steps = steps };
            }
        return null;
    }

    public static void Validate(HarnessWorkingMemory memory)
    {
        if (memory is null || memory.Version < 1 || string.IsNullOrEmpty(memory.ActorId) || memory.Scope != HarnessRecall.Scope ||
            memory.Method != Method || memory.Notice != Notice || memory.Entries is null || memory.Entries.Length > MaximumEntries ||
            memory.Coverage is null || memory.Coverage.TotalEligibleActions < 0 ||
            memory.Coverage.RecentWindowActions != Math.Min(MaximumEntries, memory.Coverage.TotalEligibleActions) ||
            memory.Entries.Length > memory.Coverage.RecentWindowActions ||
            memory.Entries.Length < Math.Min(RecentNarratives, memory.Coverage.TotalEligibleActions)) throw Invalid();
        var coverage = memory.Coverage;
        int older = coverage.TotalEligibleActions - coverage.RecentWindowActions;
        var archive = memory.Archive;
        if (coverage.ArchiveCandidates < 0 || coverage.ArchiveCandidates > Math.Min(6, older) ||
            (older > 0) != (archive is not null) ||
            archive is not null && (archive.SelectionMethod != ArchiveSelectionMethod || archive.TotalOlderActions != older ||
                archive.Selected is null || archive.Selected.Length < 1 || archive.Selected.Length > coverage.ArchiveCandidates)) throw Invalid();
        var selected = archive?.Selected ?? [];
        if (coverage.OmittedActions != coverage.TotalEligibleActions - memory.Entries.Length - selected.Length || coverage.OmittedActions < 0 ||
            !coverage.BudgetReduced && (memory.Entries.Length != coverage.RecentWindowActions || selected.Length != coverage.ArchiveCandidates)) throw Invalid();
        var all = memory.Entries.Concat(selected).ToArray();
        if (all.Any(entry => entry is null) || all.Select(entry => entry.IntentId).Distinct(StringComparer.Ordinal).Count() != all.Length ||
            !memory.Entries.Select(entry => entry.OriginSequence).SequenceEqual(memory.Entries.Select(entry => entry.OriginSequence).Order()) ||
            !selected.Select(entry => entry.OriginSequence).SequenceEqual(selected.Select(entry => entry.OriginSequence).Order()) ||
            selected.Length > 0 && selected[^1].OriginSequence > memory.Entries[0].OriginSequence) throw Invalid();
        for (int i = 0; i < memory.Entries.Length; i++)
            ValidateEntry(memory.Entries[i], memory.Version, recent: i >= memory.Entries.Length - RecentNarratives, archive: false);
        foreach (var entry in selected) ValidateEntry(entry, memory.Version, recent: false, archive: true);
        if (Bytes(memory) > MaximumBytes) throw Invalid();
    }

    private static void ValidateEntry(HarnessWorkingMemoryEntry entry, int version, bool recent, bool archive)
    {
        if (!Guid.TryParseExact(entry.IntentId, "D", out _) || entry.OriginSequence < 1 || entry.ResultVersion < entry.OriginSequence ||
            entry.ResultVersion > version || entry.Recent != recent || entry.NarrativeSource is not { Length: > 0 and <= 80 } ||
            entry.NarrativeCharacters < 0 || entry.Continuity is null || entry.TotalContinuityEntries < entry.Continuity.Length ||
            entry.TotalContinuityEntries > NarrativeContinuities.MaximumStoredEntries || entry.QuotedText is null ||
            entry.QuotedText.Length > MaximumQuotedTexts || entry.TotalQuotedTexts < entry.QuotedText.Length ||
            entry.Steps is null ||
            entry.Steps.Length > (archive ? MaximumArchiveSteps : MaximumSteps) || entry.TotalSteps < entry.Steps.Length ||
            entry.TotalSteps > 0 && entry.Steps.Length == 0) throw Invalid();
        ValidateText(entry.Input, MaximumInputCharacters, startAtZero: true);
        if (entry.Input.OriginalLength == 0) throw Invalid();
        try { NarrativeContinuities.ValidateStored(entry.Continuity); }
        catch (GameException error) { throw new InvalidDataException("Invalid working memory continuity.", error); }
        string representation = entry.Corrected ? "host_correction" : recent ? "recent_original" :
            entry.TotalContinuityEntries > 0 ? "model_reported_continuity" : "legacy_source_extract";
        if (entry.Representation != representation || entry.Corrected != (entry.NarrativeSource == "host_correction") ||
            entry.Corrected && entry.TotalContinuityEntries != 0 ||
            representation == "model_reported_continuity" && (entry.Continuity.Length == 0 || entry.Narrative is not null) ||
            representation != "model_reported_continuity" && entry.Narrative is null ||
            representation != "legacy_source_extract" && entry.TotalQuotedTexts != 0) throw Invalid();
        if (entry.Narrative is { } narrative)
        {
            ValidateText(narrative, representation == "legacy_source_extract" ? MaximumLegacyCharacters : MaximumNarrativeCharacters, startAtZero: true);
            if (narrative.OriginalLength != entry.NarrativeCharacters) throw Invalid();
        }
        foreach (var quote in entry.QuotedText)
        {
            ValidateText(quote, MaximumQuoteCharacters);
            if (quote.OriginalLength < 2 || (long)quote.SourceOffset + quote.OriginalLength > entry.NarrativeCharacters) throw Invalid();
        }
        foreach (var step in entry.Steps)
        {
            if (step is null || step.Version < entry.OriginSequence || step.Version > entry.ResultVersion ||
                step.Status is not { Length: > 0 and <= 80 } || step.Kind is not { Length: > 0 and <= 80 } || step.RollId is null ||
                step.RollId.Length > 0 && !Guid.TryParseExact(step.RollId, "D", out _) ||
                step.Status is "awaiting_roll" or "awaiting_confirmation" or "needs_adjudication" or "cancelled") throw Invalid();
            ValidateText(step.Summary, MaximumStepCharacters, startAtZero: true);
            if (step.Check is { } check && (check.Rolls is null || check.Ability is null || check.Skill is null || check.Mode is null ||
                check.Ruleset is null || check.Source is null || check.BonusSource is null || check.TestKind is null)) throw Invalid();
        }
        if (!entry.Steps.Select(step => step.Version).SequenceEqual(entry.Steps.Select(step => step.Version).Order())) throw Invalid();
    }
    private static void ValidateText(HarnessWorkingMemoryText text, int maximum, bool startAtZero = false)
    {
        if (text is null || text.Text is null || text.Text.Length > maximum || text.SourceOffset < 0 ||
            startAtZero && text.SourceOffset != 0 || text.OriginalLength < text.Text.Length ||
            text.Truncated != (text.Text.Length < text.OriginalLength)) throw Invalid();
    }
    private static InvalidDataException Invalid() => new("Invalid working memory.");
}
