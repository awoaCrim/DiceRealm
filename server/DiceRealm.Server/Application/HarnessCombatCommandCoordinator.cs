using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// These identities bind the already committed command, not a new natural-language action.
internal sealed record CombatCommandContext(CombatAgentSession Session, string ActorId, string? TimelineId,
    CombatCommandSource Source, string Fingerprint, string Input, Resolution Result, ActionOrigin? Origin,
    string[] IntentIds, string[] RollIds, string? RulingId);

internal static class HarnessCombatCommands
{
    internal const string Instruction = "这是已提交命令的自动叙事续接，不是新的玩家输入。原命令、事件和消耗已经保存，不再执行或复述玩家原话。只用world_record交付agent.narration.records，用combat_continue推进原持久队列；每个动作组保存后再继续。到正常玩家行动、实际反应/投掷或裁定边界即结束此运行，等待原端点由本人处理，不替任何席位选择行动或确认。world_record使用默认complete；服务器有原队列时会继续，无原队列时会结束。";

    internal static bool Allows(string tool) => tool is "context_read" or "actions_list" or "checks_result" or "world_record" or
        "narrative_commit" or "combat_continue" or "combat_history_read" or "ctx_search" or "ctx_expand" or "story_shared_read" or
        "rules_search" or "rules_read" or "rules_scope" or "map_state_read" or "token_read" or "encounter_read";

    // Request IDs in legacy command receipts retain their exact bytes. The run ID is a
    // separate stable namespace, scoped to the original seat and battle association.
    internal static string Id(string purpose, string session, string actor, string request) =>
        new Guid(Convert.FromHexString(JsonFiles.Hash(purpose + ":" + session + ":" + actor + ":" + request))[..16]).ToString();
}

public sealed partial class HarnessRunService
{
    // Caller holds the existing scheduling gate. A saved run is observation only here:
    // command replay must not reopen completed, interrupted or unknown generation.
    private async Task ScheduleCombatCommand(string campaign, string token, string requestId, int expectedVersion)
    {
        var command = await game.ReadCombatCommand(campaign, token, requestId, expectedVersion, CancellationToken.None);
        if (command is null) return;
        foreach (var input in command.Session.Inputs.Where(i => i.Command is null))
        {
            // A roll group or host ruling can finish on another seat. Resolve ownership
            // from the original IDs, never from whichever token submitted the last result.
            if (command.IntentIds.Contains(input.IntentId, StringComparer.Ordinal)) return;
            var owner = runs.Read(campaign, input.ActorId, input.RunId);
            if (owner?.Wait is { } wait && (wait.Kind == "roll" && command.RollIds.Contains(wait.Id, StringComparer.Ordinal) ||
                wait.Kind == "intent" && command.IntentIds.Contains(wait.Id, StringComparer.Ordinal) ||
                wait.Kind == "ruling" && wait.Id == command.RulingId)) return;
        }
        var reference = command.Session.Inputs.SingleOrDefault(i => i.ActorId == command.ActorId && i.Command?.RequestId == requestId);
        if (reference is not null && runs.Read(campaign, command.ActorId, reference.RunId) is not null) return;
        RequireEnabled(await game.AuthorizeHarness(campaign, token, CancellationToken.None));
        if (active.Count >= 4) throw HarnessJson.Conflict("harness_busy");
        var session = await game.AcceptCombatCommand(campaign, token, command, CancellationToken.None);
        reference = session.Inputs.Single(i => i.ActorId == command.ActorId && i.Command?.RequestId == requestId);
        var run = CreateCombatRun(campaign, session, reference, timelineId: command.TimelineId);
        if (run.Status == "running") Schedule(run, token);
    }
}

public sealed partial class GameService
{
    internal Task<CombatCommandContext?> ReadCombatCommand(string id, string token, string requestId, int expectedVersion, CancellationToken ct) =>
        store.Access<CombatCommandContext?>(id, token, false, c =>
        {
            if (c.Harness is null || CombatAgentSessions.Current(c) is not { Phase: "active", BattleId: { } battleId } session ||
                c.Combat?.Id != battleId || !session.Members.Contains(c.ActingActorId)) return Task.FromResult<CombatCommandContext?>(null);
            var receipt = store.FindReceipt(c, requestId);
            if (receipt is null) return Task.FromResult<CombatCommandContext?>(null);
            // Each of these command endpoints appends its result immediately after the
            // frozen expectedVersion. Read the indexed original event, not the latest tail
            // or a similarly worded later result returned by a replay's current snapshot.
            var original = store.ReadEvents(c, expectedVersion, 1).SingleOrDefault();
            if (original is null || original.Sequence != expectedVersion + 1 || original.Sequence < session.StartedVersion || original.Resolution is not { } result ||
                HarnessJson.Fingerprint(HarnessJson.Element(result)) != HarnessJson.Fingerprint(HarnessJson.Element(receipt.Resolution)))
                return Task.FromResult<CombatCommandContext?>(null);
            var prior = session.Inputs.SingleOrDefault(i => i.ActorId == c.ActingActorId && i.Command?.RequestId == requestId);
            if (prior is null && (c.Version != original.Sequence || result.Status != "resolved" || !HasCombatNarrationWork(c)))
                return Task.FromResult<CombatCommandContext?>(null);
            var roll = c.PendingRolls.FirstOrDefault(r => r.Id == result.RollId);
            var leader = roll?.GroupId is { Length: > 0 } group ? c.PendingRolls.FirstOrDefault(r => r.Id == group) : roll;
            string rulingId = result.RulingId.Length > 0 ? result.RulingId : roll?.Ruling?.RulingId ?? "";
            var ruling = c.PendingRulings.FirstOrDefault(r => r.Id == rulingId);
            if (prior is null && result.CombatLog is null && !result.Kind.StartsWith("combat.", StringComparison.Ordinal) && ruling?.CombatId != battleId)
                return Task.FromResult<CombatCommandContext?>(null);
            var intent = c.PendingIntents.FirstOrDefault(i => i.Id == result.IntentId ||
                leader is not null && i.Id == leader.IntentId || ruling is { OriginSequence: > 0 } && i.RootSequence == ruling.OriginSequence);
            int root = intent?.RootSequence ?? (ruling is { OriginSequence: > 0 } ? ruling.OriginSequence :
                leader?.Action is { } action ? action.ExpectedVersion + 1 : original.Sequence);
            var source = new CombatCommandSource(requestId, battleId, original.Sequence, root);
            if (!source.Valid(c.Version) || prior is not null && prior.Command != source) throw HarnessJson.Conflict("harness_run_conflict");
            string fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(new { source, receipt.Fingerprint, actor = c.ActingActorId, sessionId = session.Id }));
            // Never import another seat's unpublished natural input into this model's run.
            bool canReadInput = intent is null ? original.ActorId == c.ActingActorId :
                intent.ActorId == c.ActingActorId || intent is { Published: true, PrivateRoot: false };
            var origin = canReadInput ? CombatVisibility.ProjectOrigin(c, original.Origin, result, publicOnly: true) : null;
            string text = canReadInput ? intent?.Text ?? origin?.Input ?? "" : "";
            if (string.IsNullOrWhiteSpace(text)) text = origin?.Label is { Length: > 0 } label ? label : result.Kind;
            var intents = new[] { result.IntentId, leader?.IntentId, intent?.Id }.OfType<string>().Where(s => s.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
            var rolls = c.PendingRolls.Where(r => r.Id == result.RollId || leader is not null && (r.Id == leader.Id || r.GroupId == leader.Id) ||
                rulingId.Length > 0 && r.Ruling?.RulingId == rulingId).Select(r => r.Id).ToArray();
            return Task.FromResult<CombatCommandContext?>(new(session, c.ActingActorId, c.TimelineId, source, fingerprint, text,
                result, origin, intents, rolls, rulingId.Length == 0 ? null : rulingId));
        }, ct);

    internal Task<CombatAgentSession> AcceptCombatCommand(string id, string token, CombatCommandContext command, CancellationToken ct) =>
        store.Access(id, token, true, c =>
        {
            CampaignTimeline.Require(c, command.TimelineId);
            var session = CombatAgentSessions.Require(c, command.Session.Id);
            if (c.ActingActorId != command.ActorId || session.BattleId != command.Source.BattleId || c.Combat?.Id != session.BattleId)
                throw HarnessJson.Conflict("combat_session_changed");
            if (session.Inputs.SingleOrDefault(i => i.ActorId == command.ActorId && i.Command?.RequestId == command.Source.RequestId) is { } prior)
            {
                if (prior.Command != command.Source || prior.Fingerprint != command.Fingerprint) throw HarnessJson.Conflict("harness_run_conflict");
                return Task.FromResult(session);
            }
            HarnessContext(c, command.ActorId, command.Source.Sequence);
            if (session.Phase != "active" || session.SceneId != c.SceneId || !session.Members.Contains(c.ActingActorId) || !HasCombatNarrationWork(c))
                throw HarnessJson.Conflict("combat_session_unavailable");
            ContextualRolls.RequireNoPending(c);
            if (ActionUnderstanding.Current(c) is not null) throw HarnessJson.Conflict("intent_pending");
            string run = HarnessCombatCommands.Id("combat-command", session.Id, command.ActorId, command.Source.RequestId);
            string intent = HarnessCombatCommands.Id("combat-command-intent", session.Id, command.ActorId, command.Source.RequestId);
            // Establish current-intent progress without emitting intent.request or repeating
            // the original player utterance. The immutable source event remains untouched.
            var narrationResult = command.Result with { IntentId = intent };
            c.PendingIntents.Add(new PendingIntent
            {
                Id = intent, ActorId = command.ActorId, Text = command.Input, RootSequence = command.Source.RootSequence,
                Version = c.Version, Status = "completed", Published = true, Source = "combat_command",
                Result = narrationResult, ResultOrigin = command.Origin,
                HarnessSteps = [new(command.Source.Sequence, narrationResult, command.Origin)]
            });
            session.Inputs.Add(new(command.ActorId, run, intent, command.Fingerprint, command.Input, c.Version,
                HarnessTools.CurrentVersion, command.Source));
            return Task.FromResult(session);
        }, ct);
}
