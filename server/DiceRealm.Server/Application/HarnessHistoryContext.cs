using System.Text.RegularExpressions;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record HarnessHistoryContext(int Version, string ActorId, string Scope,
    HarnessHistorySummarySelection[] Audiences, HarnessHistorySource[] ProtectedOriginals, string Notice);
public sealed record HarnessHistoryCapture(string TimelineId, string Scope, HarnessHistoryFragment[] Sources,
    HarnessHistorySummary[] Published);

public static class HarnessHistoryContexts
{
    public const string Notice = HarnessHistorySources.Notice +
        " Published summaries are derived accounts, not independent evidence. Related original supplements refer to the same past occurrence; they are not repeated speech. ctx_search finds authorized full history and ctx_expand reads an exact source revision. Current input, unfinished native calls/results and latest state are not summarized.";
    public static string NoticeForVersion(int toolContractVersion) => toolContractVersion >= 51 ? Notice + HarnessHistorySources.HistoricalStatusNotice : Notice;
    public static string Scope(string? sessionId) => sessionId is null ? "exploration" : "combat:" + sessionId;

    public static HarnessHistoryContext Build(int version, string actor, HarnessHistoryCapture capture, string input,
        HarnessScenePerson[] people, bool brief = false, int toolContractVersion = 50)
    {
        var sources = capture.Sources;
        // Keep the latest exchange as a whole, including another seat's reply. Relevance
        // adds earlier original context, without certifying that a negotiation is closed.
        string latestGroup = sources.MaxBy(s => s.Version)?.Group ?? "";
        string recent = string.Join("\n", sources.Where(s => s.Group == latestGroup).Select(s => s.Text));
        var names = people.Where(p => input.Contains(p.Name, StringComparison.OrdinalIgnoreCase) ||
            recent.Contains(p.Name, StringComparison.OrdinalIgnoreCase)).Select(p => p.Name)
            .Concat(sources.Select(s => s.ActorName).Where(name => name.Length > 0 && input.Contains(name, StringComparison.OrdinalIgnoreCase)))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        // Explicit quotations and named historical speakers are stronger than corpus frequency.
        var quotes = Regex.Matches(input, "“([^”]+)”|「([^」]+)」|『([^』]+)』|\"([^\"]+)\"|‘([^’]+)’")
            .SelectMany(match => match.Groups.Cast<Group>().Skip(1).Where(group => group.Success).Select(group => group.Value)).ToArray();
        var relevance = HarnessLongMemory.Relevance(input, sources.GroupBy(s => s.Group)
            .Select(group => string.Join("\n", group.Select(s => s.Text))));
        var groups = sources.Where(s => !s.ClosedForSummary || s.Group == latestGroup || relevance(s.Text) > 0 ||
                names.Any(name => s.ActorName.Equals(name, StringComparison.OrdinalIgnoreCase) || s.Text.Contains(name, StringComparison.OrdinalIgnoreCase)) ||
                quotes.Any(quote => s.Text.Contains(quote, StringComparison.Ordinal)))
            .Select(s => s.Group).ToHashSet(StringComparer.Ordinal);
        var originals = sources.Where(s => groups.Contains(s.Group)).ToArray();
        var tiers = capture.Published.ToDictionary(s => s.Id, _ => brief ? HarnessHistorySummaries.BriefTier : HarnessHistorySummaries.DetailedTier);
        return new(version, actor, capture.Scope, new[] { "public", actor }.Distinct(StringComparer.Ordinal).Select(audience =>
            HarnessHistorySummaries.Select(capture.Scope, audience, sources, capture.Published,
                originals.Where(s => s.Audience == audience).Select(s => s.Source).ToArray(), tiers)).ToArray(),
            originals.Select(s => s.Source).Distinct().ToArray(), NoticeForVersion(toolContractVersion));
    }

    public static HarnessHistoryContext RequiredOnly(HarnessHistoryContext history) => history with
    {
        Audiences = history.Audiences.Select(a => a with
        {
            Summaries = [], RelatedOriginalSupplements = [],
            Raw = a.Raw.Concat(a.RelatedOriginalSupplements.Select(s => s.Original))
                .Where(s => history.ProtectedOriginals.Contains(s.Source)).DistinctBy(s => s.Source).ToArray()
        }).ToArray()
    };

    public static void Validate(HarnessHistoryContext history, int version, string actor, string scope, int toolContractVersion = 50)
    {
        if (history.Version != version || history.ActorId != actor || history.Scope != scope || history.Notice != NoticeForVersion(toolContractVersion) ||
            history.ProtectedOriginals is null || history.ProtectedOriginals.Distinct().Count() != history.ProtectedOriginals.Length ||
            history.Audiences is null || !history.Audiences.Select(a => a.Audience).SequenceEqual(new[] { "public", actor }.Distinct(StringComparer.Ordinal)))
            throw new InvalidDataException("Invalid frozen historical context.");
        var originalSources = history.Audiences.SelectMany(a => a.Raw.Concat(a.RelatedOriginalSupplements.Select(s => s.Original)))
            .Select(f => f.Source).ToHashSet();
        if (history.ProtectedOriginals.Any(s => !originalSources.Contains(s)))
            throw new InvalidDataException("Protected original was omitted from historical context.");
        foreach (var audience in history.Audiences)
        {
            if (audience.Scope != scope || audience.Summaries is null || audience.Raw is null || audience.RelatedOriginalSupplements is null)
                throw new InvalidDataException("Invalid history selection.");
            var covered = new HashSet<HarnessHistorySource>();
            foreach (var summary in audience.Summaries)
            {
                if (string.IsNullOrEmpty(summary.Id) || summary.Version < 1 || summary.Publication < 1 ||
                    summary.Tier is not (HarnessHistorySummaries.DetailedTier or HarnessHistorySummaries.BriefTier) ||
                    string.IsNullOrWhiteSpace(summary.Text) || summary.Sources is not { Length: > 0 } || summary.Sources.Any(s => !covered.Add(s)))
                    throw new InvalidDataException("Invalid summary coverage.");
            }
            foreach (var source in audience.Raw)
            {
                Original(source);
                if (!covered.Add(source.Source)) throw new InvalidDataException("Repeated historical source.");
            }
            var supplements = new HashSet<HarnessHistorySource>();
            foreach (var supplement in audience.RelatedOriginalSupplements)
            {
                Original(supplement.Original);
                if (supplement.Kind != HarnessHistorySummaries.RelatedOriginalSupplementKind || !supplements.Add(supplement.Original.Source) ||
                    !audience.Summaries.Any(s => s.Id == supplement.SummaryId && s.Version == supplement.SummaryVersion &&
                        s.Publication == supplement.SummaryPublication && s.Sources.Contains(supplement.Original.Source)))
                    throw new InvalidDataException("Invalid historical original supplement.");
            }
            void Original(HarnessHistoryFragment f)
            {
                if (f.Audience != audience.Audience || f.Version < 0 || f.Version > version || f.Source is null ||
                    f.Text is null || f.Source.Revision != PrivateStories.Revision(f.Text))
                    throw new InvalidDataException("Invalid original historical source.");
            }
        }
    }
}

public sealed partial class GameService
{
    private HarnessHistoryCapture CaptureHistory(Campaign c, string intentId, string? sessionId, int toolContractVersion = 50) => new(
        c.TimelineId ?? "", HarnessHistoryContexts.Scope(sessionId), CaptureHistorySources(c, intentId, sessionId, toolContractVersion),
        store.ReadHistorySummaries(c, HarnessHistoryContexts.Scope(sessionId)));

    internal Task<HarnessHistoryCapture> ReadHarnessHistory(HarnessRun run, string token, CancellationToken ct, CombatRunAuthority? authority = null) =>
        AccessHarness(run.CampaignId, token, false, c =>
        {
            HarnessContext(c, run.ActorId, run.Version);
            RequireCombatOwner(c, run.Id, run.CombatSessionId);
            return Task.FromResult(CaptureHistory(c, run.IntentId, run.CombatSessionId, run.ToolContractVersion));
        }, ct, authority);

    internal Task<HarnessHistorySummary> PublishHarnessHistory(HarnessRun run, string token,
        HarnessHistoryCapture capture, HarnessHistorySummaryRange frozen, HarnessHistorySummary draft, CancellationToken ct, CombatRunAuthority? authority = null) =>
        AccessHarness(run.CampaignId, token, false, c =>
        {
            ValidateHistoryAccess(c, run, capture, frozen);
            var sources = CaptureHistorySources(c, run.IntentId, run.CombatSessionId, run.ToolContractVersion).Where(s => s.ClosedForSummary).ToArray();
            return Task.FromResult(store.PublishHistorySummary(c, draft, frozen, sources));
        }, ct, authority);

    internal Task<HarnessHistoryWork?> BeginHarnessHistory(HarnessRun run, string token, HarnessHistoryCapture capture,
        HarnessHistorySummaryRange range, string providerIdentity, CancellationToken ct, CombatRunAuthority? authority) =>
        AccessHarness(run.CampaignId, token, false, c =>
        {
            ValidateHistoryAccess(c, run, capture, range);
            _ = HarnessHistorySummaries.Freeze(range.Scope, range.Audience,
                CaptureHistorySources(c, run.IntentId, run.CombatSessionId, run.ToolContractVersion).Where(s => s.ClosedForSummary).ToArray(), range.Sources);
            // Re-read before issuing work: a slot can carry a capture from before a
            // background publication. This manager only publishes deltas (Replaces=[]).
            if (run.ToolContractVersion >= 51 && store.ReadHistorySummaries(c, range.Scope).Any(summary =>
                summary.Audience == range.Audience && summary.Sources.Any(range.Sources.Contains)))
                return Task.FromResult<HarnessHistoryWork?>(null);
            return Task.FromResult(store.BeginHistoryWork(c, providerIdentity, range));
        }, ct, authority);

    internal Task AuthorizeHarnessHistory(HarnessRun run, string token, HarnessHistoryCapture capture,
        HarnessHistorySummaryRange range, CancellationToken ct, CombatRunAuthority? authority) =>
        AccessHarness(run.CampaignId, token, false, c =>
        {
            ValidateHistoryAccess(c, run, capture, range);
            _ = HarnessHistorySummaries.Freeze(range.Scope, range.Audience,
                CaptureHistorySources(c, run.IntentId, run.CombatSessionId, run.ToolContractVersion).Where(s => s.ClosedForSummary).ToArray(), range.Sources);
            return Task.FromResult(true);
        }, ct, authority);

    internal Task FinishHarnessHistory(HarnessRun run, string token, HarnessHistoryCapture capture,
        HarnessHistoryWork work, bool published, string error, CancellationToken ct, CombatRunAuthority? authority) =>
        AccessHarness(run.CampaignId, token, false, c =>
        {
            ValidateHistoryAccess(c, run, capture, work.Range);
            store.FinishHistoryWork(c, work, published, error);
            return Task.FromResult(true);
        }, ct, authority);

    private static void ValidateHistoryAccess(Campaign c, HarnessRun run, HarnessHistoryCapture capture, HarnessHistorySummaryRange range)
    {
        if ((c.TimelineId ?? "") != capture.TimelineId || c.ActingActorId != run.ActorId ||
            range.Scope != capture.Scope || range.Scope != HarnessHistoryContexts.Scope(run.CombatSessionId) ||
            range.Audience != "public" && range.Audience != c.ActingActorId ||
            run.CombatSessionId is { } session && !CombatAgentSessions.Require(c, session).Members.Contains(c.ActingActorId))
            throw new GameException("harness_history_summary_changed", "历史分支、受众或摘要范围已变化，保留原文。", 409);
        if (c.Harness is null || c.OfflineTrial || c.Archived) throw HarnessJson.Conflict("harness_unavailable");
    }
}
