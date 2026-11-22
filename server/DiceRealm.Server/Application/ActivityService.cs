using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<ActivityPage> Activity(string id, string token, int after, int? through, int limit, CancellationToken ct)
    {
        if (after < 0 || through is < 1 || limit is < 1 or > 100) throw new GameException("invalid_pagination", "after >= 0，through >= 1，limit 在 1..100 之间。");
        return store.Access(id, token, false, c =>
        {
            int horizon = through ?? c.Version;
            if (horizon > c.Version || after > horizon) throw new GameException("invalid_pagination", "分页游标超出已保存的历史范围。");
            // Page over immutable event sequences, not a mutable filtered list. Empty root pages
            // still advance over host-only events; linked ruling state is current at Version.
            var events = store.ReadEvents(c, after, limit, horizon);
            // An exhausted stored range can precede the first retained event after a reset.
            // Advance to the frozen horizon, not the unchanged cursor; filter only afterwards.
            int next = events.Length < limit ? horizon : events[^1].Sequence;
            return Task.FromResult(new ActivityPage(c.Id, c.Version, horizon, after, next, next < horizon,
                ProjectActivity(c, events)));
        }, ct);
    }
    public Task<ActivityEntry> ActivityDetail(string id, string token, int sequence, CancellationToken ct)
    {
        if (sequence < 1) throw new GameException("invalid_pagination", "sequence >= 1。");
        return store.Access(id, token, false, c =>
        {
            var e = store.ReadEvents(c, sequence - 1, 1).FirstOrDefault();
            var entry = e?.Sequence == sequence ? ProjectActivity(c, [e]).SingleOrDefault() : null;
            return Task.FromResult(entry ?? throw new GameException("activity_not_found", "找不到该玩家行动。", 404));
        }, ct);
    }
    // A returned parent is still the same action, but its new replies belong AFTER
    // the battle. Derive segments from durable handoff boundaries and original events;
    // neither rewrite the intent nor depend on the in-memory latest-event tail.
    private ActivityEntry[] ProjectActivity(Campaign c, GameEvent[] events)
    {
        var result = new List<ActivityEntry>();
        var parents = new Dictionary<string, ActivityEntry[]>();
        foreach (var e in events)
        {
            if (!ActionUnderstanding.VisibleTo(c, e)) continue;
            if (!ActionUnderstanding.RootVisibleTo(c, e) || ActionUnderstanding.PrivateDelivery(e))
            {
                if (PrivateStories.Parts(c, e).Length > 0) result.Add(PrivateMessageActivity(c, e));
                continue;
            }
            string intentId = e.Resolution?.IntentId ?? "";
            if (c.PendingIntents.Any(i => i.Id == intentId && i.PrivateRoot))
            {
                // Public continuations stand on their own event sequence. Aggregating them
                // onto the private root would reveal its input or duplicate a later reply.
                result.Add(WithPrivateStories(c, ActivityRecords.Project(c, e), [e]));
                continue;
            }
            var pacedSession = (c.CombatAgentSessions ?? []).FirstOrDefault(s => s.Inputs.Any(i => i.IntentId == intentId &&
                i.ActorId == e.ActorId && (i.ToolContractVersion ?? s.ToolContractVersion) >= 49));
            if (pacedSession is not null)
            {
                if (!parents.TryGetValue(intentId, out var beats))
                    parents[intentId] = beats = CombatActivitySegments(c, intentId, pacedSession);
                if (beats.FirstOrDefault(beat => beat.Sequence == e.Sequence) is { } beat) result.Add(beat);
                continue;
            }
            var sessions = (c.CombatAgentSessions ?? []).Where(s => s.ParentIntentId == intentId && s.ParentActorId == e.ActorId)
                .OrderBy(s => s.StartedVersion).ToArray();
            if (sessions.Length > 0)
            {
                if (!parents.TryGetValue(intentId, out var segments))
                    parents[intentId] = segments = ParentActivitySegments(c, intentId, sessions);
                if (segments.FirstOrDefault(s => s.Sequence == e.Sequence) is { } segment) result.Add(segment);
                continue;
            }
            var delegated = (c.CombatAgentSessions ?? []).FirstOrDefault(s =>
                s.Inputs[0].IntentId == intentId && s.Inputs[0].ActorId == e.ActorId);
            // A narration followed by a check or another narration is several beats of one action.
            // The intent keeps only its latest narration, so a single entry would lose the earlier prose.
            if (delegated is null && c.PendingIntents.FirstOrDefault(i => i.Id == intentId && i.HarnessSteps is { Count: > 0 }) is { } stepped)
            {
                if (!parents.TryGetValue(intentId, out var steps))
                    parents[intentId] = steps = BeatSegments(c, stepped, stepped.RootSequence, false);
                if (steps.Length > 1)
                {
                    if (steps.FirstOrDefault(s => s.Sequence == e.Sequence) is { } step) result.Add(step);
                    continue;
                }
            }
            if (!ActivityRecords.IsRoot(c, e)) continue;
            var entry = ActivityRecords.Project(c, e);
            if (delegated is not null)
                entry = entry with { ContinuationOf = c.PendingIntents.First(i => i.Id == delegated.ParentIntentId).RootSequence };
            result.Add(WithPrivateStories(c, entry, PrivateStoryEvents(c, entry)));
        }
        return result.ToArray();
    }

    private ActivityEntry[] CombatActivitySegments(Campaign c, string intentId, CombatAgentSession session)
    {
        var intent = c.PendingIntents.First(i => i.Id == intentId);
        bool delegated = session.Inputs[0].IntentId == intentId;
        var command = session.Inputs.Single(i => i.IntentId == intentId).Command;
        int continuation = command?.RootSequence ?? (delegated ? c.PendingIntents.First(i => i.Id == session.ParentIntentId).RootSequence : intent.RootSequence);
        return BeatSegments(c, intent, continuation, command is not null || delegated);
    }

    // Each accepted world_record closes one action beat. Later writes never replace its
    // prose, and each beat retains only its own exact mechanical records/private parts.
    private ActivityEntry[] BeatSegments(Campaign c, PendingIntent intent, int continuation, bool continued)
    {
        var entries = new List<ActivityEntry>();
        var history = new List<GameEvent>();
        int cursor = intent.RootSequence - 1;
        void Add()
        {
            if (history.Count == 0) return;
            var first = history[0]; var last = history[^1];
            var narrative = history.LastOrDefault(e => e.NarrativeSource == "harness");
            var segment = new PendingIntent
            {
                Id = intent.Id, ActorId = intent.ActorId, Text = intent.Text, RootSequence = first.Sequence,
                Version = last.Sequence, Status = last.Sequence == intent.Version ? intent.Status : "completed",
                Result = last.Resolution, ResultOrigin = last.Origin ?? first.Origin,
                Narrative = narrative?.Narrative ?? "", NarrativeSource = narrative?.NarrativeSource ?? "system", PrivateText = narrative?.PrivateText ?? "",
                // The player's answers belong to the input, shown once with the first beat.
                Clarifications = entries.Count == 0 ? intent.Clarifications : [],
                HarnessSteps = intent.HarnessSteps?.Where(s => s.Sequence >= first.Sequence && s.Sequence <= last.Sequence).ToList()
            };
            entries.Add(WithPrivateStories(c, ActivityRecords.Project(c, first, segment) with
            { ContinuationOf = continued || entries.Count > 0 ? continuation : 0 }, history));
            history.Clear();
        }
        while (cursor < intent.Version)
        {
            var page = store.ReadEvents(c, cursor, 100, intent.Version);
            if (page.Length == 0) break;
            foreach (var e in page.Where(e => e.ActorId == intent.ActorId && e.Resolution?.IntentId == intent.Id))
            {
                if (!ActionUnderstanding.PrivateDelivery(e)) history.Add(e);
                if (e.NarrativeSource == "harness" && e.Resolution?.Status == "narrated") Add();
            }
            cursor = page[^1].Sequence;
        }
        Add();
        return entries.ToArray();
    }

    private ActivityEntry[] ParentActivitySegments(Campaign c, string intentId, CombatAgentSession[] sessions)
    {
        var intent = c.PendingIntents.First(i => i.Id == intentId);
        var entries = new List<ActivityEntry>();
        void Add(int after, int through, bool continuation)
        {
            var history = new List<GameEvent>();
            int cursor = after;
            while (cursor < through)
            {
                var page = store.ReadEvents(c, cursor, 100, through);
                if (page.Length == 0) break;
                history.AddRange(page.Where(e => e.ActorId == intent.ActorId && e.Resolution?.IntentId == intentId && !ActionUnderstanding.PrivateDelivery(e)));
                cursor = page[^1].Sequence;
            }
            if (history.Count == 0) return; // returned, but the parent has not written anything yet
            var first = history[0]; var last = history[^1];
            var narrative = history.LastOrDefault(e => e.NarrativeSource == "harness");
            var segment = new PendingIntent
            {
                Id = intent.Id, ActorId = intent.ActorId, Text = intent.Text, RootSequence = first.Sequence,
                Version = last.Sequence, Status = through == c.Version ? intent.Status : "completed",
                Result = last.Resolution, ResultOrigin = last.Origin ?? first.Origin,
                Narrative = narrative?.Narrative ?? "", NarrativeSource = "harness", PrivateText = narrative?.PrivateText ?? "",
                HarnessSteps = intent.HarnessSteps?.Where(s => s.Sequence > after && s.Sequence <= through).ToList()
            };
            entries.Add(WithPrivateStories(c, ActivityRecords.Project(c, first, segment) with { ContinuationOf = continuation ? intent.RootSequence : 0 }, history));
        }
        Add(intent.RootSequence - 1, sessions[0].StartedVersion, false);
        for (int i = 0; i < sessions.Length; i++)
            if (sessions[i].Return is { } returned)
                Add(returned.Version, i + 1 < sessions.Length ? sessions[i + 1].StartedVersion : c.Version, true);
        return entries.ToArray();
    }

    public Task<StoryOptions> StoryOptions(string id, string token, string rulingId, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            return Task.FromResult(StoryConsequences.Options(c, rulingId, RulingOrigin(c, rulingId)));
        }, ct);
    public Task<StoryPreview> PreviewStory(string id, string token, StoryRequest request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        return store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            return Task.FromResult(StoryConsequences.Preview(c, request, RulingOrigin(c, request.RulingId)));
        }, ct);
    }
    public Task<ActionResponse> ApplyStory(string id, string token, StoryRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "ruling.story", request,
            c => StoryConsequences.Apply(c, request, RulingOrigin(c, request.RulingId)), ct);
    private GameEvent? RulingOrigin(Campaign c, string rulingId)
    {
        var r = c.PendingRulings.FirstOrDefault(x => x.Id == rulingId);
        if (r is null) return null;
        if (r.OriginSequence > 0) return store.ReadEvents(c, r.OriginSequence - 1, 1).FirstOrDefault(e => e.Sequence == r.OriginSequence && ActivityRecords.IsRoot(c, e));
        // Legacy records have no sequence link. Read bounded indexed pages without inventing
        // original input/cost data, including roots older than the in-memory latest 100.
        int after = 0;
        while (after < c.Version)
        {
            var page = store.ReadEvents(c, after, 100);
            if (page.Length == 0) break;
            var match = page.FirstOrDefault(e => e.Resolution?.RulingId == rulingId && ActivityRecords.IsRoot(c, e));
            if (match is not null) return match;
            after = page[^1].Sequence;
        }
        return null;
    }
}
