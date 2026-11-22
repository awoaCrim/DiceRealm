using System.Text;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record CombatHistoryReadArgs(string SessionId = "", string Scope = "sessions", int After = 0, int Through = 0, int Limit = 8);
public sealed record CombatHistoryItem(string SourceId, string ActorId, string Audience, string Kind, string Text,
    int Version, int Part = 0, CombatAgentUnitResult? Unit = null, string? ReplyTo = null);
public sealed record CombatHistoryPage(string SessionId, string Scope, int Through, int After, int NextAfter, bool HasMore,
    CombatHistoryItem[] Entries);

// Recall is data, never SDK replay. Only the current battle's own input journals and
// authorized world events are read; host privileges do not grant another seat's secrets.
internal static class HarnessCombatRecall
{
    internal const int MaximumPageBytes = 24 * 1024;

    internal static void Text(List<CombatHistoryItem> items, string source, string actor, string audience, string kind, string text, int version, string? replyTo = null)
    {
        for (int offset = 0; offset < text.Length;)
        {
            int count = Math.Min(1000, text.Length - offset);
            if (offset + count < text.Length && char.IsHighSurrogate(text[offset + count - 1])) count--;
            items.Add(new(source, actor, audience, kind, text.Substring(offset, count), version, offset, ReplyTo: replyTo));
            offset += count;
        }
    }

    internal static CombatHistoryPage Page(string session, string scope, int through, int after, int limit, IReadOnlyList<CombatHistoryItem> items)
    {
        if (after > items.Count) throw new GameException("harness_invalid_payload", "历史游标超出此范围。");
        var entries = new List<(CombatHistoryItem Item, int Index)>();
        int next = after;
        while (next < items.Count && entries.Count < limit)
        {
            if (items[next].Audience != "unavailable") entries.Add((items[next], next));
            next++;
        }
        CombatHistoryPage Result() => new(session, scope, through, after, next, next < items.Count, entries.Select(e => e.Item).ToArray());
        while (entries.Count > 1 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(Result())) > MaximumPageBytes)
        { next = entries[^1].Index; entries.RemoveAt(entries.Count - 1); }
        var page = Result(); HarnessJson.Bound(page, MaximumPageBytes); return page;
    }

    internal static List<CombatHistoryItem> Inputs(CombatAgentSession session, string actor, int through, string? currentRun,
        Func<CombatAgentInput, HarnessRun?> read, Func<string, bool> published, bool modelReportedNotes = false)
    {
        var items = new List<CombatHistoryItem>();
        foreach (var input in session.Inputs.TakeWhile(i => i.RunId != currentRun || i.ActorId != actor).Where(i => i.AcceptedVersion <= through))
        {
            bool own = input.ActorId == actor;
            string source = "run:" + input.RunId;
            // Reserve the same source slot before filtering. Later publication of a peer's
            // input must not shift the cursor of every following own answer.
            if (input.Command is null)
                Text(items, source + ":input", input.ActorId, own ? "actor" : published(input.IntentId) ? "public" : "unavailable", "player_input", input.Input, input.AcceptedVersion);
            // No peer journal is opened, even for a host acting as a player.
            if (!own) continue;
            var run = read(input);
            if (run is null) continue; // accepted but not yet created is not completed dialogue
            if (run.CombatSessionId != session.Id || run.ActorId != actor || run.IntentId != input.IntentId || run.Profile.Hash != session.Profile.Hash)
                throw HarnessJson.Conflict("harness_corrupt_run");
            for (int turn = 1; turn < run.Turns.Count; turn++)
            {
                using var json = JsonDocument.Parse(run.Turns[turn]);
                if (!json.RootElement.TryGetProperty("playerAnswer", out var answer)) continue;
                int answeredVersion = run.TurnVersions?[turn] ?? run.Steps.FirstOrDefault(s => s.Kind == "model" && s.Id.StartsWith(turn + ":", StringComparison.Ordinal))?.ExecutionFrame?.Version ?? 0;
                if (answeredVersion == 0 || answeredVersion > through) continue;
                var question = run.Steps.LastOrDefault(s => s.Id.StartsWith((turn - 1) + ":", StringComparison.Ordinal) &&
                    s.Status == "done" && s.ToolRequest?.Name == "ask_player" && s.Outcome?.Wait?.Kind == "player");
                string? questionSource = question is null ? null : source + ":step:" + question.Id;
                if (question is not null)
                    Text(items, questionSource!, actor, "actor", "player_question", HarnessJson.Read<QuestionHarnessArgs>(question.ToolRequest!.Arguments).Question, question.Outcome!.Version);
                Text(items, source + ":turn:" + turn, actor, "actor", "player_answer", answer.GetString()!, answeredVersion, questionSource);
            }
            foreach (var step in run.Steps.Where(s => s.Status == "done" && s.ToolRequest?.Name == "world_record" && s.Outcome?.Version <= through))
            {
                if (step.Outcome!.Reply.IsError) continue;
                using var receipt = JsonDocument.Parse(step.Outcome.Reply.Content);
                if (!receipt.RootElement.TryGetProperty("resolution", out var result) ||
                    result.GetProperty("kind").GetString() != "adventure.narrate" || result.GetProperty("status").GetString() != "narrated" ||
                    result.GetProperty("intentId").GetString() != run.IntentId) continue;
                var args = HarnessJson.Read<NarrativeHarnessArgs>(step.ToolRequest!.Arguments);
                var notes = args.Continuity ?? [];
                for (int index = 0; index < notes.Length; index++)
                    Text(items, source + ":step:" + step.Id + ":note:" + index, actor, modelReportedNotes ? "actor" : "public",
                        (modelReportedNotes ? "model_reported_" : "narrative_") + notes[index].Kind, notes[index].Text, step.Outcome!.Version);
            }
        }
        return items;
    }
}

public sealed partial class GameService
{
    internal Task<HarnessToolOutcome> ReadCombatHistory(string id, string token, string actor, int version, string runId,
        string? childSessionId, CombatRunAuthority? authority, CombatHistoryReadArgs args, HarnessRunStore runs, CancellationToken ct, int toolContractVersion = 36) =>
        AccessHarness(id, token, false, c =>
        {
            HarnessContext(c, actor, version);
            RequireCombatOwner(c, runId, childSessionId);
            if (args.Scope != "sessions" && !Guid.TryParseExact(args.SessionId, "D", out _) || args.Scope is not ("sessions" or "events" or "discoveries" or "inputs" or "units" or "people" or "corrections") ||
                args.After < 0 || args.Through < 0 || args.Limit is < 1 or > 8)
                throw new GameException("harness_invalid_payload", "战斗历史查询参数不符合合同。");
            if (args.Scope == "sessions")
            {
                if (childSessionId is not null) throw HarnessJson.Conflict("combat_session_owned");
                int listingThrough = args.Through == 0 ? c.Version : args.Through;
                if (listingThrough < 1 || listingThrough > c.Version) throw new GameException("harness_invalid_payload", "战斗历史范围无效。");
                var sessions = (c.CombatAgentSessions ?? []).Where(s => s.ReturnConsumed && s.Members.Contains(actor) && s.Return!.Version <= listingThrough)
                    .Select(s => new CombatHistoryItem(s.Id, actor, "actor", "completed_session", s.EncounterId, s.Return!.Version)).ToArray();
                return Task.FromResult(ToolOutcome(c, HarnessCombatRecall.Page("", "sessions", listingThrough, args.After, args.Limit, sessions)));
            }
            var session = CombatAgentSessions.Require(c, args.SessionId);
            bool child = childSessionId == session.Id;
            if (!child && !(session.ReturnConsumed && session.Members.Contains(actor)) &&
                (session.ParentRunId != runId || session.ParentActorId != actor || session.Return is null))
                throw HarnessJson.Conflict("combat_session_owned");
            int end = session.Return?.Version ?? c.Version;
            int through = args.Through == 0 ? end : args.Through;
            if (through < session.StartedVersion || through > end) throw new GameException("harness_invalid_payload", "战斗历史范围无效。");
            var items = new List<CombatHistoryItem>();
            if (args.Scope == "inputs")
                items = HarnessCombatRecall.Inputs(session, actor, through, child ? runId : null,
                    i => runs.Read(c.Id, actor, i.RunId), intent => c.PendingIntents.Any(i => i.Id == intent && i.Published && !i.PrivateRoot),
                    modelReportedNotes: toolContractVersion >= 45);
            else if (args.Scope is "events" or "discoveries")
            {
                int cursor = session.Handoff.SourceAfter;
                while (cursor < through)
                {
                    var events = store.ReadEvents(c, cursor, 100, through);
                    if (events.Length == 0) break;
                    foreach (var e in events)
                    {
                        bool readable = !e.HostOnly && e.ReviewActorId.Length == 0 && ActionUnderstanding.RootVisibleTo(c, e) && !ActionUnderstanding.PrivateDelivery(e);
                        bool belongs = e.Resolution?.IntentId == session.ParentIntentId && e.ActorId == session.ParentActorId ||
                            session.Inputs.Any(i => i.IntentId == e.Resolution?.IntentId && i.ActorId == e.ActorId) ||
                            e.Sequence >= session.StartedVersion && e.Resolution?.Kind.StartsWith("combat.", StringComparison.Ordinal) == true;
                        if (!belongs) continue;
                        string source = "event:" + e.Sequence;
                        bool rulingRequest = e.Resolution is { Status: "needs_adjudication", Kind: "adjudicate" };
                        var visible = e.Resolution is null ? null : HarnessMemories.PublicResult(c, e.Resolution);
                        string narrative = CombatVisibility.ProjectGeneratedText(c, e.Narrative, e.Resolution, publicOnly: true);
                        string summary = rulingRequest ? ActionUnderstanding.RulingRequestSummary : visible?.Summary ?? e.Text;
                        // A visible private combat log stays actor-scoped, not relabeled public.
                        string audience = !readable ? "unavailable" : e.Resolution?.CombatLog?.Any(l => l.Audience?.Contains(actor) == true) == true ? "actor" : "public";
                        if (args.Scope == "events") HarnessCombatRecall.Text(items, source, e.ActorId, audience, "result", summary, e.Sequence);
                        if (args.Scope == "events" && narrative.Length > 0 && narrative != summary)
                            HarnessCombatRecall.Text(items, source, e.ActorId, audience, "narrative", narrative, e.Sequence);
                        if (e.ActorId == actor)
                            HarnessCombatRecall.Text(items, source, actor, readable || toolContractVersion >= 43 && !e.HostOnly && e.ReviewActorId.Length == 0 ? "actor" : "unavailable", "private_discovery", e.PrivateText, e.Sequence);
                        if (toolContractVersion >= 43)
                            foreach (var part in PrivateStories.Parts(c, e, actorOnly: true).Where(p => p.Source.PartId is not null))
                                HarnessCombatRecall.Text(items, source + ":part:" + part.Source.PartId, actor, "actor", "private_discovery", part.Text, e.Sequence);
                    }
                    cursor = events[^1].Sequence;
                }
            }
            else if (args.Scope == "units")
            {
                if (session.Return is null || actor != session.ParentActorId) throw HarnessJson.Conflict("combat_return_unavailable");
                items.AddRange((session.Return.Units ?? []).Select(u => new CombatHistoryItem("return:" + session.Return.Id,
                    actor, "actor", "settled_unit", "", session.Return.Version, Unit: u)));
            }
            else if (args.Scope == "corrections")
                foreach (var correction in c.AdventureCorrections.Where(x => x.OriginSequence > session.Handoff.SourceAfter && x.OriginSequence <= end))
                {
                    var origin = store.ReadEvents(c, correction.OriginSequence - 1, 1, correction.OriginSequence).SingleOrDefault();
                    if (origin is null || origin.HostOnly || !ActionUnderstanding.RootVisibleTo(c, origin)) continue;
                    HarnessCombatRecall.Text(items, "correction:" + correction.Sequence + ":event:" + correction.OriginSequence, origin.ActorId, "public", "current_correction", correction.Text, correction.Sequence);
                }
            else
                foreach (var npc in StoryEngine.Snapshot(c).Npcs.Where(n => n.SceneId == session.SceneId))
                    HarnessCombatRecall.Text(items, "npc:" + npc.Id, "", "public", "known_person", npc.Name + "\n" + npc.Summary, c.Version);
            var page = HarnessCombatRecall.Page(session.Id, args.Scope, through, args.After, args.Limit, items);
            return Task.FromResult(ToolOutcome(c, page));
        }, ct, authority);
}
