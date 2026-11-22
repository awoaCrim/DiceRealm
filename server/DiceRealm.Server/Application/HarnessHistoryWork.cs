namespace DiceRealm.Server.Application;

// A durable outbound-attempt marker, not a game event or a second recovery engine.
// Started work is never resent after a restart; only an accepted publication replaces raw data.
public sealed record HarnessHistoryWork(string Id, string TimelineId, string ProviderIdentity,
    HarnessHistorySummaryRange Range, string Status, string Error = "");
