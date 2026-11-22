using System;
using System.Collections.Generic;
using System.Linq;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// Every immutable publication has its own Id, including a new version of an older
// summary. Version is caller-owned content revision metadata, not a game version.
public sealed record HarnessHistorySummary(string Id, int Version, long Publication, string Scope,
    string Audience, HarnessHistorySource[] Sources, string Detailed, string Brief, string[] Replaces);

public sealed record HarnessHistorySummaryRange(string Scope, string Audience, HarnessHistorySource[] Sources);

public sealed record HarnessHistorySummaryRendered(string Id, int Version, long Publication, string Tier,
    HarnessHistorySource[] Sources, string Text);

public sealed record HarnessHistoryOriginalSupplement(string Kind, string SummaryId, int SummaryVersion,
    long SummaryPublication, HarnessHistoryFragment Original);

public sealed record HarnessHistorySummarySelection(string Scope, string Audience,
    HarnessHistorySummaryRendered[] Summaries, HarnessHistoryFragment[] Raw,
    HarnessHistoryOriginalSupplement[] RelatedOriginalSupplements);

// Pure source-set validation and selection, adopting layered baseline + delta history.
// The caller owns authorization, scope projection, closed-action eligibility, storage,
// model calls and token budgeting. No model text here becomes state or instructions.
public static class HarnessHistorySummaries
{
    public const string DetailedTier = "detailed";
    public const string BriefTier = "brief";
    public const string RelatedOriginalSupplementKind = "related_original_supplement";

    // Serialization/resource integrity limits only; none represent a model token budget.
    private const int MaximumIdentifierCharacters = 512;
    private const int MaximumTextCharacters = 2 * 1024 * 1024;
    private const int MaximumSourcesPerSummary = 65_536;
    private const int MaximumReplacements = 65_536;

    /// <summary>
    /// Freeze the exact selected source set before requesting a summary. This is not
    /// a min/max sequence interval: new sources may arrive and remain separate raw data.
    /// Current sources must already exclude every unfinished action/native chain.
    /// </summary>
    public static HarnessHistorySummaryRange Freeze(string scope, string audience,
        IReadOnlyCollection<HarnessHistoryFragment> currentSources,
        IReadOnlyCollection<HarnessHistorySource> sources)
    {
        RequireScopeAndAudience(scope, audience);
        ArgumentNullException.ThrowIfNull(sources);
        var selected = sources.ToArray();
        if (!ValidSources(selected))
            throw Invalid();

        var current = SourceIndex(currentSources, audience);
        if (selected.Any(source => !current.ContainsKey(source)))
            throw SourceUnavailable();

        return new(scope, audience, Order(selected));
    }

    /// <summary>
    /// Validate and copy a prospective publication; this method does not persist it.
    /// Supply the complete published catalog for this scope/audience, INCLUDING replaced
    /// versions. The caller must re-read sources/catalog, allocate Publication and append
    /// this result atomically. Never remove older records when adopting the result.
    /// </summary>
    public static HarnessHistorySummary PreparePublication(HarnessHistorySummary candidate,
        HarnessHistorySummaryRange frozen, IReadOnlyCollection<HarnessHistoryFragment> currentSources,
        IReadOnlyCollection<HarnessHistorySummary> published)
    {
        ArgumentNullException.ThrowIfNull(published);
        if (!WellFormed(candidate) || frozen is null || !ValidScope(frozen.Scope) ||
            !Identifier(frozen.Audience) || !ValidSources(frozen.Sources))
            throw Invalid();
        if (candidate.Scope != frozen.Scope || candidate.Audience != frozen.Audience)
            throw Invalid();
        if (!frozen.Sources.ToHashSet().SetEquals(candidate.Sources))
            throw Changed();

        var current = SourceIndex(currentSources, candidate.Audience);
        if (frozen.Sources.Any(source => !current.ContainsKey(source)))
            throw Changed();

        var catalog = published.ToArray();
        if (catalog.Any(summary => !WellFormed(summary)) ||
            ValidPublications(catalog).Count != catalog.Length)
            throw new GameException("harness_history_summary_catalog_invalid", "已发布摘要的身份或替换关系无效，保留现有记录。", 409);
        if (catalog.Any(summary => summary.Id == candidate.Id) ||
            catalog.Any(summary => summary.Scope == candidate.Scope && summary.Audience == candidate.Audience &&
                summary.Publication >= candidate.Publication))
            throw new GameException("harness_history_summary_conflict", "摘要身份或发布序号已使用，请重新读取发布记录。", 409);
        if (!CompleteReplacements(candidate, catalog))
            throw new GameException("harness_history_summary_replacement_invalid", "新摘要必须完整覆盖并明确替换所有重叠的旧摘要，不能跨范围或受众引用。", 409);

        return candidate with
        {
            Sources = Order(candidate.Sources),
            Replaces = candidate.Replaces.OrderBy(id => id, StringComparer.Ordinal).ToArray()
        };
    }

    /// <summary>
    /// Select one audience in one scope using the complete published catalog (including
    /// replaced versions). Unavailable/malformed summaries never consume sources: their
    /// original bodies remain raw, or another valid version may cover them.
    /// Missing tier entries mean detailed; the only explicit tiers are detailed/brief.
    /// The returned arrays and actual rendered text can be persisted as a slot snapshot.
    /// </summary>
    public static HarnessHistorySummarySelection Select(string scope, string audience,
        IReadOnlyCollection<HarnessHistoryFragment> currentSources,
        IReadOnlyCollection<HarnessHistorySummary> published,
        IReadOnlyCollection<HarnessHistorySource> originalSupplements,
        IReadOnlyDictionary<string, string> tiers)
    {
        RequireScopeAndAudience(scope, audience);
        ArgumentNullException.ThrowIfNull(published);
        ArgumentNullException.ThrowIfNull(originalSupplements);
        ArgumentNullException.ThrowIfNull(tiers);
        if (tiers.Any(pair => !Identifier(pair.Key) || pair.Value is not (DetailedTier or BriefTier)))
            throw Invalid();

        var current = SourceIndex(currentSources, audience);
        var requestedOriginals = new HashSet<HarnessHistorySource>();
        foreach (var source in originalSupplements)
        {
            if (!ValidSource(source) || !current.ContainsKey(source))
                throw SourceUnavailable();
            requestedOriginals.Add(source);
        }

        var eligible = ValidPublications(published)
            .Where(summary => summary.Scope == scope && summary.Audience == audience &&
                summary.Sources.All(current.ContainsKey))
            .OrderByDescending(summary => summary.Sources.Length)
            .ThenByDescending(summary => summary.Publication)
            .ThenBy(summary => summary.Id, StringComparer.Ordinal);
        var coverage = new Dictionary<HarnessHistorySource, HarnessHistorySummary>();
        var rendered = new List<HarnessHistorySummaryRendered>();
        foreach (var summary in eligible)
        {
            // A body cannot be sliced to remove overlaps. Prefer a complete merged
            // baseline, then only whole non-overlapping deltas; leave the rest raw.
            if (summary.Sources.Any(coverage.ContainsKey))
                continue;

            string tier = tiers.TryGetValue(summary.Id, out var requestedTier) ? requestedTier : DetailedTier;
            string text = tier == BriefTier ? summary.Brief : summary.Detailed;
            rendered.Add(new(summary.Id, summary.Version, summary.Publication, tier, Order(summary.Sources), text));
            foreach (var source in summary.Sources)
                coverage.Add(source, summary);
        }

        var ordered = Order(current.Keys);
        var raw = ordered.Where(source => !coverage.ContainsKey(source)).Select(source => current[source]).ToArray();
        var supplements = new List<HarnessHistoryOriginalSupplement>();
        foreach (var source in ordered)
        {
            if (requestedOriginals.Contains(source) && coverage.TryGetValue(source, out var summary))
                supplements.Add(new(RelatedOriginalSupplementKind, summary.Id, summary.Version,
                    summary.Publication, current[source]));
        }
        // An uncovered requested original is already in Raw, exactly once. A covered
        // original is emitted only as an explicitly related supplement, not a new event.
        return new(scope, audience, rendered.ToArray(), raw, supplements.ToArray());
    }

    private static Dictionary<HarnessHistorySource, HarnessHistoryFragment> SourceIndex(
        IReadOnlyCollection<HarnessHistoryFragment> currentSources, string audience)
    {
        ArgumentNullException.ThrowIfNull(currentSources);
        var current = new Dictionary<HarnessHistorySource, HarnessHistoryFragment>();
        var parts = new HashSet<(string Kind, string Id, int Sequence, string Part)>();
        foreach (var fragment in currentSources)
        {
            if (fragment is null || !Identifier(fragment.Audience) || !ValidSource(fragment.Source) ||
                fragment.ActorId is null || fragment.ActorName is null || fragment.Kind is null ||
                fragment.Text is null || fragment.Version < 0)
                throw Invalid();
            if (fragment.Audience != audience)
                continue;

            var source = fragment.Source;
            // Two revisions of one current part would make the authoritative body
            // ambiguous. Separate attributed corrections have their own source keys.
            if (!parts.Add((source.Kind, source.Id, source.Sequence, source.Part)) ||
                !current.TryAdd(source, fragment))
                throw Invalid();
        }
        return current;
    }

    private static List<HarnessHistorySummary> ValidPublications(IReadOnlyCollection<HarnessHistorySummary> published)
    {
        // Duplicate identities or publication numbers are not resolved by input order.
        // Ignore unusable records, but retain valid ancestors for fallback and replay.
        var catalog = published.Where(summary => summary is not null)
            .GroupBy(summary => summary.Id ?? "", StringComparer.Ordinal)
            .Where(group => group.Count() == 1 && WellFormed(group.First()))
            .Select(group => group.First()).ToArray();
        var duplicatePublications = catalog.GroupBy(summary => (summary.Scope, summary.Audience, summary.Publication))
            .Where(group => group.Count() > 1).Select(group => group.Key).ToHashSet();
        var valid = new List<HarnessHistorySummary>();
        var validIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var summary in catalog.OrderBy(summary => summary.Publication).ThenBy(summary => summary.Id, StringComparer.Ordinal))
        {
            if (duplicatePublications.Contains((summary.Scope, summary.Audience, summary.Publication)) ||
                !CompleteReplacements(summary, catalog) || summary.Replaces.Any(id => !validIds.Contains(id)))
                continue;
            valid.Add(summary);
            validIds.Add(summary.Id);
        }
        return valid;
    }

    private static bool CompleteReplacements(HarnessHistorySummary summary, IReadOnlyCollection<HarnessHistorySummary> catalog)
    {
        var sources = summary.Sources.ToHashSet();
        var overlapping = catalog.Where(old => old.Scope == summary.Scope && old.Audience == summary.Audience &&
            old.Publication < summary.Publication && old.Sources.Any(sources.Contains)).ToArray();
        // Include every overlapping published ancestor, even if a later version already
        // replaced it. This makes the exact coverage contract explicit and replayable.
        return overlapping.All(old => old.Sources.All(sources.Contains)) &&
            summary.Replaces.ToHashSet(StringComparer.Ordinal).SetEquals(overlapping.Select(old => old.Id));
    }

    private static bool WellFormed(HarnessHistorySummary? summary) =>
        summary is not null && Identifier(summary.Id) && summary.Version > 0 && summary.Publication > 0 &&
        ValidScope(summary.Scope) && Identifier(summary.Audience) && ValidSources(summary.Sources) &&
        Body(summary.Detailed) && Body(summary.Brief) && summary.Replaces is not null &&
        summary.Replaces.Length <= MaximumReplacements && summary.Replaces.All(Identifier) &&
        !summary.Replaces.Contains(summary.Id, StringComparer.Ordinal) &&
        summary.Replaces.Distinct(StringComparer.Ordinal).Count() == summary.Replaces.Length;

    private static bool ValidSources(HarnessHistorySource[]? sources) =>
        sources is { Length: > 0 and <= MaximumSourcesPerSummary } && sources.All(ValidSource) &&
        sources.Distinct().Count() == sources.Length &&
        sources.Select(source => (source.Kind, source.Id, source.Sequence, source.Part)).Distinct().Count() == sources.Length;

    private static bool ValidSource(HarnessHistorySource? source) => source is not null &&
        Identifier(source.Kind) && Identifier(source.Id) && source.Sequence >= 0 &&
        Identifier(source.Part) && Identifier(source.Revision);

    private static bool Identifier(string? value) => value is { Length: > 0 and <= MaximumIdentifierCharacters } &&
        !value.Any(character => char.IsWhiteSpace(character) || char.IsControl(character));

    private static bool Body(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= MaximumTextCharacters;

    private static bool ValidScope(string? scope) => scope == "exploration" ||
        scope is not null && scope.StartsWith("combat:", StringComparison.Ordinal) && Identifier(scope["combat:".Length..]);

    private static void RequireScopeAndAudience(string scope, string audience)
    {
        if (!ValidScope(scope) || !Identifier(audience))
            throw Invalid();
    }

    private static HarnessHistorySource[] Order(IEnumerable<HarnessHistorySource> sources) =>
        sources.OrderBy(source => source.Sequence).ThenBy(source => source.Kind, StringComparer.Ordinal)
            .ThenBy(source => source.Id, StringComparer.Ordinal).ThenBy(source => source.Part, StringComparer.Ordinal)
            .ThenBy(source => source.Revision, StringComparer.Ordinal).ToArray();

    private static GameException Invalid() => new("harness_history_summary_invalid", "历史摘要标识、正文、来源或渲染层级无效。");
    private static GameException Changed() => new("harness_history_summary_changed", "冻结的历史来源、受众或修订已变化，请保留原文并重新准备摘要。", 409);
    private static GameException SourceUnavailable() => new("harness_history_summary_source_unavailable", "历史原文或修订不在当前受众允许使用的来源集合。", 404);
}
