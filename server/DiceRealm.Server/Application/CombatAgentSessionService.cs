using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record CombatDelegateArgs(string EncounterId, string Reason, NarrativeContinuityEntry[] Continuity);
// Coordinator-only grants bound to saved associations. A null return identifies ONLY
// the delegated first input, never arbitrary actor impersonation or a public credential.
public sealed class CombatRunAuthority
{
    internal CombatRunAuthority(string sessionId, string runId, string? returnId)
    { SessionId = sessionId; RunId = runId; ReturnId = returnId; }
    internal string SessionId { get; }
    internal string RunId { get; }
    internal string? ReturnId { get; }
}

public sealed partial class GameService
{
    private Task<T> AccessHarness<T>(string id, string token, bool write, Func<Campaign, Task<T>> operation,
        CancellationToken ct, CombatRunAuthority? authority = null) => authority is null
        ? store.Access(id, token, write, operation, ct)
        : authority.ReturnId is null
            ? store.AccessCombatFirstInput(id, authority.SessionId, authority.RunId, write, operation, ct)
            : store.AccessCombatParent(id, authority.SessionId, authority.RunId, authority.ReturnId, write, operation, ct);

    internal Task<CombatAgentSession?> ReadCombatSession(string id, string token, CancellationToken ct, string? sessionId = null, CombatRunAuthority? authority = null) =>
        AccessHarness(id, token, false, c => Task.FromResult(sessionId is null ? CombatAgentSessions.Current(c) : CombatAgentSessions.Require(c, sessionId)), ct, authority);

    private (HarnessToolOutcome Outcome, Resolution Resolution) DelegateCombat(Campaign c, string token, string parentRunId,
        string intentId, string input, CombatDelegateArgs args, string? rulesCatalogVersion, CombatRunAuthority? authority, int contract)
    {
        if (!Guid.TryParseExact(parentRunId, "D", out _) || CombatAgentSessions.Current(c) is not null || CombatEngine.InCombat(c) && contract < 37)
            throw new GameException("combat_session_unavailable", "已有战斗主持或委派归属，不能另起一场。", 409);
        ContextualRolls.RequireNoPending(c);
        if (ActionUnderstanding.Current(c) is not null || c.PendingRulings.Any(r => r.ActorId == c.ActingActorId && r.Status is "pending" or "awaiting_roll"))
            throw new GameException("combat_session_unavailable", "先完成本人当前的确认或裁定。", 409);
        bool existingBattle = contract >= 37 && CombatEngine.InCombat(c);
        var encounter = CombatAgentSessions.DelegatableEncounter(c, includeActive: existingBattle);
        if (encounter is null || encounter.Id != args.EncounterId)
            throw new GameException("encounter_setup_unavailable", "只能委派当前已建立的真实遭遇，不能新增或重建敌人。", 409);
        string reason = WorldMemories.Text(args.Reason, 1000, multiline: true);
        NarrativeContinuities.Validate(args.Continuity);
        if (args.Continuity is null) throw new GameException("harness_invalid_payload", "需要明确的交接条目；无条目请传空数组。");
        string credentialHash = authority is null ? JsonFiles.Hash(token) : CombatAgentSessions.Require(c, authority.SessionId).ParentCredentialHash;
        if (authority is not null && (authority.ReturnId is null || authority.RunId != parentRunId))
            throw HarnessJson.Conflict("combat_session_owned");
        var activeProfile = workspaces.Get(c).Active;
        var preset = HarnessCombatPrompts.Resolve(activeProfile.Preset, contract)
            ?? throw new GameException("combat_prompt_required", "尚未采用独立的战斗主持提示词。", 409);
        // Exploration skills are not silently loaded into a battle session.
        var profile = new HarnessProfile(preset, HarnessJson.ProfileHash(preset, []), []);
        var (intent, root) = HarnessRoot(c, intentId, input);
        var resolution = new Resolution("delegated", "combat.delegate", existingBattle
            ? "由战斗主持接续当前交锋；保留原先攻、回合与已结算结果。"
            : "交锋交给战斗主持继续处理；尚未投掷先攻。", null, [], IntentId: intentId);
        RecordIntent(c, intent, resolution, root ? "intent.request" : resolution.Kind);
        intent.Status = "delegated";
        string firstId = Guid.NewGuid().ToString();
        var firstRequest = new HarnessInputRequest(firstId, c.Version, input);
        var session = new CombatAgentSession
        {
            Id = Guid.NewGuid().ToString(), SceneId = c.SceneId, EncounterId = encounter.Id,
            ParentActorId = c.ActingActorId, ParentRunId = parentRunId, ParentIntentId = intentId,
            ParentCredentialHash = credentialHash, Profile = profile, ToolContractVersion = contract,
            RulesCatalogVersion = rulesCatalogVersion, StartedVersion = c.Version,
            PriorBattleId = existingBattle ? null : c.Combat?.Id, BattleId = existingBattle ? c.Combat!.Id : null,
            Handoff = new(input, reason, args.Continuity, Math.Max(0, intent.RootSequence - 1), CombatHandoffProgress(c, intent)),
            Members = PartyEngine.Characters(c).Select(m => m.Id).ToArray(),
            Inputs = [new(c.ActingActorId, firstId, Guid.NewGuid().ToString(), HarnessJson.Fingerprint(HarnessJson.Element(firstRequest)), input, c.Version)]
        };
        (c.CombatAgentSessions ??= []).Add(session);
        if (contract >= 49) StandardCombatEngine.EnableNarration(c);
        return (new(c.Version, new(HarnessJson.Serialize(new { version = c.Version, battleSessionId = session.Id, status = "delegated", initiativeRolled = existingBattle }), Stop: true),
            DelegatedSessionId: session.Id), resolution);
    }

    private CombatAgentProgress[] CombatHandoffProgress(Campaign c, PendingIntent intent)
    {
        var progress = new List<CombatAgentProgress>();
        int cursor = Math.Max(0, intent.RootSequence - 1);
        while (cursor < c.Version - 1)
        {
            var events = store.ReadEvents(c, cursor, 100, c.Version - 1);
            if (events.Length == 0) break;
            foreach (var e in events.Where(e => e.ActorId == c.ActingActorId && e.Resolution?.IntentId == intent.Id))
                progress.Add(new(e.Sequence, e.Resolution!.Status, e.Resolution.Kind,
                    IntentContexts.Bounded(HarnessMemories.PublicResult(c, e.Resolution).Summary, 240)));
            cursor = events[^1].Sequence;
        }
        return progress.TakeLast(8).ToArray();
    }

    internal Task<CombatAgentSession> AcceptCombatInput(string id, string token, string sessionId, HarnessInputRequest request,
        string fingerprint, CancellationToken ct, bool adoptNarration) => store.Access(id, token, true, c =>
        {
            var session = CombatAgentSessions.Require(c, sessionId);
            if (session.Inputs.FirstOrDefault(i => i.ActorId == c.ActingActorId && i.RunId == request.RequestId) is { } prior)
            {
                if (prior.Fingerprint != fingerprint) throw HarnessJson.Conflict("harness_run_conflict");
                return Task.FromResult(session);
            }
            GameLifecycle.RequireAction(c);
            HarnessContext(c, c.ActingActorId, request.ExpectedVersion);
            if (session.Phase != "active" || !session.Members.Contains(c.ActingActorId) || session.SceneId != c.SceneId)
                throw HarnessJson.Conflict("combat_session_unavailable");
            if (ActionUnderstanding.Current(c) is not null) throw HarnessJson.Conflict("intent_pending");
            ContextualRolls.RequireNoPending(c);
            // Only the immediately preceding contract adopts pacing. Older native-history
            // contracts and all saved runs/slots keep their established behavior.
            int? contract = adoptNarration ? HarnessTools.CurrentVersion : null;
            session.Inputs.Add(new(c.ActingActorId, request.RequestId, Guid.NewGuid().ToString(), fingerprint, request.Text, c.Version, contract));
            if ((contract ?? session.ToolContractVersion) >= 49) StandardCombatEngine.EnableNarration(c);
            return Task.FromResult(session);
        }, ct);

    // Called only after an explicit execution/confirmation, never by GET or startup.
    // It records identity only; no dice, rule resolution or model request is performed.
    internal Task<CombatAgentSession> ObserveCombatSession(string id, string token, string sessionId, CancellationToken ct, CombatRunAuthority? authority = null) =>
        AccessHarness(id, token, true, c =>
        {
            var session = CombatAgentSessions.Require(c, sessionId);
            if (session.Phase == "active" && c.Combat is { } battle && battle.Id != session.PriorBattleId && battle.DefinitionId == session.EncounterId)
            {
                if (session.BattleId is not null && session.BattleId != battle.Id) throw HarnessJson.Conflict("combat_session_changed");
                session.BattleId = battle.Id;
            }
            return Task.FromResult(session);
        }, ct, authority);

    internal Task<bool> CanReadCombatReturn(string id, string sessionId, string parentRunId, CancellationToken ct) =>
        store.AccessCombatParent(id, sessionId, parentRunId, null, false, _ => Task.FromResult(true), ct);

    internal Task<CombatAgentReturn> FreezeCombatReturn(string id, string sessionId, string parentRunId, CancellationToken ct) =>
        store.AccessCombatParent(id, sessionId, parentRunId, null, true, c =>
        {
            var session = CombatAgentSessions.Require(c, sessionId);
            if (session.Return is { } existing) return Task.FromResult(existing);
            var battle = c.Combat!;
            var actor = c.ActingCharacter ?? throw HarnessJson.Conflict("combat_session_unavailable");
            var visible = CombatVisibility.Project(c, publicOnly: true)!;
            var units = visible.Units.Select(u => new CombatAgentUnitResult(u.Id, u.Name, u.Team, u.HitPoints,
                u.Standard?.TemporaryHitPoints ?? u.BoardBody?.TemporaryHitPoints ?? 0,
                u.Standard?.Conditions ?? u.BoardBody?.Conditions ?? [], u.Withdrawn, u.X, u.Y, u.BoardEntityId, u.BoardPosition,
                session.ToolContractVersion >= 37 ? u.BoardEntityId is { } entityId &&
                    c.Board?.Entities.FirstOrDefault(e => e.Id == entityId)?.Appearance.Visibility == "gm" ? "actor" : "public" : null)).ToArray();
            var result = new CombatAgentReturn(Guid.NewGuid().ToString(), battle.Id, battle.Status, c.Version, c.SceneId, c.ElapsedSeconds,
                new(c.ActingActorId, actor.HitPoints, actor.TemporaryHitPoints, actor.Conditions, actor.Resources, actor.Effects, actor.Concentration),
                battle.Log.Where(e => e.Audience is null || e.Audience.Contains(c.ActingActorId)).Select(e =>
                    new CombatAgentLog(CombatVisibility.ProjectLog(c, [e], publicOnly: true).Single(), e.Audience is null ? "public" : "actor")).ToArray(),
                session.Inputs.ToArray(), units, visible.BoardLayout,
                session.ToolContractVersion >= 45 ? CombatReturnStory(c, session) : null);
            session.Return = result; session.Phase = "return_pending";
            return Task.FromResult(result);
        }, ct);

    private CombatAgentStory[] CombatReturnStory(Campaign c, CombatAgentSession session)
    {
        var events = new List<GameEvent>();
        int cursor = session.Handoff.SourceAfter;
        while (cursor < c.Version)
        {
            var page = store.ReadEvents(c, cursor, 100, c.Version);
            if (page.Length == 0) break;
            events.AddRange(page); cursor = page[^1].Sequence;
        }
        var stored = events.ToArray();
        var story = HarnessHistorySources.Capture(c, stored, sessionId: session.Id, closingCombat: true, toolContractVersion: session.ToolContractVersion)
            .Where(f => HarnessHistorySources.Story(f, stored)).Select(f => new CombatAgentStory(
                f.Source.Kind + ":" + f.Source.Id, f.Source.Sequence, f.Source.Part, f.Source.Revision,
                f.ActorId, f.Audience, f.Kind, f.Text)).ToList();
        // Full accepted notes and question/answer links, never rejected tools or peer Runs.
        var own = HarnessCombatRecall.Inputs(session, c.ActingActorId, c.Version, null,
            i => historyRuns.Read(c.Id, c.ActingActorId, i.RunId), _ => false, modelReportedNotes: true);
        foreach (var part in own.Where(p => p.Kind != "player_input" && p.Audience != "unavailable"))
        {
            if (part.Kind.StartsWith("model_reported_", StringComparison.Ordinal))
            {
                var input = session.Inputs.Single(i => part.SourceId.StartsWith("run:" + i.RunId + ":", StringComparison.Ordinal));
                // Merged notes have canonical intent sources. Keep earlier accepted notes
                // absent from that bounded list, without duplicating this intent's same note.
                if (story.Any(s => s.SourceId == "intent:" + input.IntentId && s.Kind == part.Kind && s.Text == part.Text)) continue;
            }
            Add(part.SourceId, part.Version, part.Part.ToString(System.Globalization.CultureInfo.InvariantCulture),
                part.Kind, part.Text, part.Audience == "public" ? "public" : c.ActingActorId);
        }
        foreach (var input in session.Inputs.Where(i => i.ActorId == c.ActingActorId))
        {
            var run = historyRuns.Read(c.Id, c.ActingActorId, input.RunId);
            if (input.Command is null && run?.Status is not ("completed" or "cancelled"))
                Add("run:" + input.RunId, input.AcceptedVersion, "unfinished_input", "unfinished_input", input.Input, c.ActingActorId);
            if (run?.Wait is { Kind: "player" } && run.Steps.LastOrDefault(s => s.Status == "done" && s.ToolRequest?.Name == "ask_player") is { } question)
                Add("run:" + input.RunId + ":step:" + question.Id, question.Outcome!.Version,
                    "open_question", "unanswered_question", HarnessJson.Read<QuestionHarnessArgs>(question.ToolRequest!.Arguments).Question, c.ActingActorId);
        }
        return story.ToArray();

        void Add(string source, int version, string part, string kind, string text, string audience) => story.Add(new(
            source, version, part, PrivateStories.Revision(text), c.ActingActorId, audience, kind, text));
    }

    internal Task ConsumeCombatReturn(string id, CombatRunAuthority authority, CancellationToken ct) =>
        AccessHarness(id, "", true, c =>
        {
            var session = CombatAgentSessions.Require(c, authority.SessionId);
            session.ReturnConsumed = true; session.Phase = "returned";
            return Task.FromResult(true);
        }, ct, authority);

    private bool CombatContinuationAllowed(Campaign c, string? sessionId, int cursor)
    {
        if (sessionId is null) return false;
        var session = CombatAgentSessions.Require(c, sessionId);
        if (session.Phase != "active" || c.SceneId != session.SceneId || cursor < session.StartedVersion ||
            session.BattleId is not null && c.Combat?.Id != session.BattleId) return false;
        while (cursor < c.Version)
        {
            var events = store.ReadEvents(c, cursor, 100);
            if (events.Length == 0) return false;
            foreach (var e in events)
            {
                if (e.Sequence != ++cursor || e.Resolution is not { } result) return false;
                if (session.Inputs.Any(i => i.IntentId == result.IntentId && i.ActorId == e.ActorId)) continue;
                if (session.BattleId is not null && result.Kind.StartsWith("combat.", StringComparison.Ordinal)) continue;
                var roll = c.PendingRolls.FirstOrDefault(r => r.Id == result.RollId && r.ActorId == e.ActorId);
                string intent = roll?.GroupId is { Length: > 0 } group ? c.PendingRolls.FirstOrDefault(r => r.Id == group)?.IntentId ?? "" : roll?.IntentId ?? "";
                if (session.Inputs.Any(i => i.IntentId == intent)) continue;
                return false;
            }
        }
        return cursor == c.Version;
    }

    private static void RequireCombatOwner(Campaign c, string? runId, string? sessionId)
    {
        var current = CombatAgentSessions.Current(c);
        if (sessionId is null)
        {
            if (current is not null) throw HarnessJson.Conflict("combat_session_owned");
            return;
        }
        var session = CombatAgentSessions.Require(c, sessionId);
        if (session.Phase != "active" || !session.Inputs.Any(i => i.RunId == runId && i.ActorId == c.ActingActorId))
            throw HarnessJson.Conflict("combat_session_owned");
    }
}
