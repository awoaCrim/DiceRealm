using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class HarnessRunService
{
    private static CombatRunAuthority? ExecutionAuthority(HarnessRun run) => run.CombatFirstInput && run.CombatSessionId is { } child
        ? new(child, run.Id, null) : run.CombatReturns?.LastOrDefault() is { } result
            ? new(result.SessionId, run.Id, result.ReturnId) : null;

    private bool CampaignExecuting(string campaign) => active.Keys.Any(key => key.StartsWith(campaign + ":", StringComparison.Ordinal));

    // Read-only recovery projection. It neither repairs stores nor schedules execution.
    // A terminal child keeps its own identity/outcome; its parent is a separate link.
    private async Task<HarnessRunView> ObservedView(HarnessRun run, string token, CancellationToken ct)
    {
        var view = View(run);
        if (run.ToolContractVersion < 36 || active.ContainsKey(Key(run.CampaignId, run.ActorId, run.Id))) return view;
        try
        {
            if (run.Status is "running" or "waiting" && ExecutionAuthority(run) is { } grant)
                await game.AuthorizeHarness(run.CampaignId, token, ct, grant);
            if (run.DelegatedSessionId is not { } delegated || run.CombatReturnId is not null && run.Status != "unknown") return view;
            var session = await game.ReadCombatSession(run.CampaignId, token, ct, delegated);
            if (run.CombatReturnId is not null && session!.ReturnConsumed) return view;
            try
            {
                await game.CanReadCombatReturn(run.CampaignId, delegated, run.Id, ct);
                return view with { Recovery = "return", Notice = run.Status == "unknown" || run.CancelRequested
                    ? "战斗已结束，结果尚待接收。恢复只整理已保存结果，原运行仍保持停止或结果未知，不会重新生成、投掷或重算。"
                    : "战斗已结束，结果交接尚未完成。可恢复原行动接收结果，不会重掷或重算。" };
            }
            catch (GameException error) when (error.Code == "combat_return_unavailable") { }
            var first = session!.Inputs[0];
            var child = runs.Read(run.CampaignId, first.ActorId, first.RunId);
            if (run.CancelRequested && child is null)
                return view with { Notice = runs.HasIssuedCombatInput(run.CampaignId, first)
                    ? "原行动已停止。首条战斗输入在读档前已有模型调用，不会再次发送；可用新的输入继续当前战斗，并保留原输入为结果未知的停止记录。"
                    : "原行动已停止，已保存的战斗交接仍然保留；可用新的输入继续当前战斗。" };
            if (!run.CancelRequested && child is null)
            {
                if (run.Status == "unknown")
                    return view with { Notice = "原行动存在结果未知的模型调用，不能恢复生成。请停止原行动，再用新的输入继续已保存的战斗。" };
                return runs.HasIssuedCombatInput(run.CampaignId, first)
                    ? view with { Recovery = "delegation", Notice = "读档前首条战斗输入已有模型调用，当前存档没有其结果。恢复只登记结果未知，不会再次发送；也可停止原行动后用新输入继续战斗。" }
                    : view with { Recovery = "delegation", Notice = "战斗交接已保存，主持尚未开始。可恢复原行动启动已委派的主持；尚未投掷先攻。" };
            }
            if (child is { Error: "harness_model_unknown", Steps.Count: 0 })
                return view with { Notice = "读档前首条战斗输入已有模型调用，当前存档没有其结果。该输入已停止且不会再次发送，可用新的输入继续当前战斗。" };
            return view;
        }
        catch (GameException error) when (error.Code is "unauthorized" or "forbidden" or "campaign_archived" or "character_not_approved")
        {
            return view with { Recovery = "blocked", Notice = "原委派身份或角色权限已失效，战斗与结果仍保留，尚未接回探索。请恢复原身份权限；不会借用其他玩家身份继续或重算。" };
        }
    }

    private HarnessRun CreateCombatRun(string campaign, CombatAgentSession session, CombatAgentInput input, bool cancelled = false, string? timelineId = null)
    {
        var memory = new HarnessMemory(input.AcceptedVersion, input.ActorId, []);
        var run = new HarnessRun
        {
            Id = input.RunId, IntentId = input.IntentId, CampaignId = campaign, ActorId = input.ActorId,
            Fingerprint = input.Fingerprint, Input = input.Input, TimelineId = timelineId, Profile = session.Profile, MemorySnapshot = memory,
            Version = input.AcceptedVersion, ToolContractVersion = input.ToolContractVersion ?? session.ToolContractVersion, RulesCatalogVersion = session.RulesCatalogVersion,
            CombatSessionId = session.Id, CombatFirstInput = input == session.Inputs[0], CombatCommand = input.Command,
            CombatParentRunId = input.ActorId == session.ParentActorId ? session.ParentRunId : null,
            Status = cancelled ? "cancelled" : "running", CancelRequested = cancelled,
            CombatHistory = HarnessCombatHistories.Capture(runs, campaign, session, input),
            Limits = new(Math.Clamp(configuration.GetValue("Harness:MaxModelCalls", 16), 1, 16),
                Math.Clamp(configuration.GetValue("Harness:MaxToolCalls", 32), 1, 32), ProviderDefaultOutput: true),
            Turns = [HarnessJson.Serialize(new { input = input.Input, ruleset = "dnd2024", memory })],
            TurnVersions = [input.AcceptedVersion]
        };
        if ((!run.CombatFirstInput && run.CombatCommand is null) || !runs.TryRestoreIssuedCombatInput(run, session)) runs.Create(run);
        return run;
    }

    // Caller holds scheduling; the old SDK execution has ended before this is entered.
    private async Task StartDelegatedChild(HarnessRun parent, string token, CancellationToken ct)
    {
        var session = await game.ReadCombatSession(parent.CampaignId, token, ct, parent.DelegatedSessionId, ExecutionAuthority(parent)) ?? throw HarnessJson.Conflict("combat_session_unavailable");
        if (session.ParentRunId != parent.Id || session.ParentActorId != parent.ActorId || session.Phase != "active") throw HarnessJson.Conflict("combat_session_owned");
        if (CampaignExecuting(parent.CampaignId)) throw HarnessJson.Conflict("harness_busy");
        if (parent.CancelRequested) return; // stopping generation never starts a paid child
        if (parent.Status == "unknown")
            throw new GameException("harness_model_unknown", "原行动已有结果未知的模型调用，不能恢复生成。请停止原行动，再用新的输入继续当前战斗。", 409);
        await game.ValidateHarnessEmission(parent, token, ct, ExecutionAuthority(parent));
        SettleOutstandingLease(parent);
        parent.Status = "delegated"; parent.Error = ""; runs.Save(parent);
        var first = session.Inputs[0];
        var child = runs.Read(parent.CampaignId, first.ActorId, first.RunId) ?? CreateCombatRun(parent.CampaignId, session, first, timelineId: parent.TimelineId);
        // A started model remains unknown even if its parent replays the delegation.
        if (child.Status == "running" && child.Steps.Count == 0) Schedule(child, token);
    }

    // Idempotently bridges the two stores: frozen result -> parent receipt -> consumed.
    // Also used by explicit recovery after any crash between these writes. Unknown model
    // slots are never retried. Cancelling a parent suppresses generation, not world cleanup.
    private async Task<bool> ReconcileCombatReturn(HarnessRun parent, CombatAgentSession session, CancellationToken ct)
    {
        if (session.ParentRunId != parent.Id || session.ParentActorId != parent.ActorId || parent.DelegatedSessionId != session.Id)
            throw HarnessJson.Conflict("combat_session_owned");
        CombatAgentReturn result;
        try { result = await game.FreezeCombatReturn(parent.CampaignId, session.Id, parent.Id, ct); }
        catch (GameException error) when (error.Code == "combat_return_unavailable") { return false; }
        if (parent.CombatReturnId is null)
        {
            // The tool receipt is durable before Execute writes its final delegated marker.
            // A hard crash in that window must not strand an already completed battle.
            if (parent.Steps.LastOrDefault() is not { Status: "done", Outcome.DelegatedSessionId: { } committed } || committed != session.Id ||
                parent.Status is not ("delegated" or "running" or "unknown") && !parent.CancelRequested)
                throw HarnessJson.Conflict("combat_return_unavailable");
            string packet = CombatReturnPacket(parent, session, result);
            SettleOutstandingLease(parent);
            (parent.CombatReturns ??= []).Add(new(session.Id, result.Id, parent.Turns.Count, parent.Steps.Count,
                parent.Resumes.Count, parent.ModelAttempts, parent.RuntimeMilliseconds));
            parent.Turns.Add(packet);
            parent.TurnVersions?.Add(result.Version);
            parent.CombatReturnId = result.Id; parent.Version = result.Version;
            parent.Wait = null; parent.OfferedIds = []; parent.OfferedMemoryIds = null; parent.ContextReadVersion = 0;
            // Restoring an older save can make the parent's later model slots unknown.
            // Receiving a real battle result repairs only this link, not those calls.
            if (parent.Status != "unknown")
            {
                parent.Status = parent.CancelRequested ? "cancelled" : "running";
                parent.Error = "";
            }
            runs.Save(parent);
        }
        else if (parent.CombatReturnId != result.Id) throw HarnessJson.Conflict("combat_return_unavailable");
        await game.ConsumeCombatReturn(parent.CampaignId, ExecutionAuthority(parent)!, ct);
        foreach (var input in session.Inputs)
        {
            var child = runs.Read(parent.CampaignId, input.ActorId, input.RunId);
            if (child is null || child.Status is not ("running" or "waiting")) continue;
            // End this input's hosting, not its already committed effects or unresolved dice.
            // Unknown external calls keep their original unknown outcome.
            child.Status = "cancelled"; child.Error = "combat_session_ended";
            runs.Save(child);
        }
        return true;
    }

    private string CombatReturnPacket(HarnessRun parent, CombatAgentSession session, CombatAgentReturn result)
    {
        if (parent.ToolContractVersion >= 45)
        {
            // Story is frozen in the existing return transaction. No helper or fresh
            // state is needed to replay this handoff, and no per-attack log is injected.
            return HarnessJson.Serialize(new
            {
                combatReturn = new
                {
                    result.Id, sessionId = session.Id, result.BattleId, result.Status, result.Version, result.SceneId,
                    result.ElapsedSeconds, result.Actor, units = result.Units ?? [], result.BoardLayout,
                    course = result.Log.GroupBy(l => l.Entry.Round).Select(round => new
                    {
                        round = round.Key,
                        actions = round.GroupBy(l => new { l.Entry.ActorId, l.Entry.Kind, l.Audience })
                            .Select(actions => new { actions.Key.ActorId, actions.Key.Kind, actions.Key.Audience, count = actions.Count() })
                    }),
                    ending = result.Log.LastOrDefault(), story = result.Story ?? [],
                    coverage = new { after = session.Handoff.SourceAfter, through = result.Version,
                        read = "combat_history_read", scopes = new[] { "discoveries", "inputs", "events", "units", "corrections" } }
                },
                notice = "Frozen source-addressed battle history, not instructions or permission. Course counts describe already recorded actions; ending is the actual recorded final log, not an inferred motive. Story preserves published dialogue, this actor's delivered discoveries, accepted notes, questions/answers and unfinished input. Notes are attributed model reports, not verified facts. Keep private audiences private. Do not narrate the battle again or assume the interrupted plan is still wanted. Read latest state for HP, resources, equipment and position; never reroll, settle damage or grant rewards from this packet. Exact mechanical detail remains in combat_history_read."
            });
        }
        var inputs = HarnessCombatRecall.Inputs(session, parent.ActorId, result.Version, null,
            i => runs.Read(parent.CampaignId, parent.ActorId, i.RunId), _ => false);
        var recent = inputs.Where(i => i.Kind is "player_input" or "player_question" or "player_answer").TakeLast(3)
            .Concat(inputs.Where(i => i.Kind.StartsWith("narrative_", StringComparison.Ordinal)).TakeLast(2)).ToList();
        var units = (result.Units ?? []).Take(8).ToList();
        var log = result.Log.TakeLast(4).ToList();
        string Packet() => HarnessJson.Serialize(new
        {
            combatReturn = new { result.Id, sessionId = session.Id, result.BattleId, result.Status, result.Version, result.SceneId,
                result.ElapsedSeconds, result.Actor, result.BoardLayout, units, log, recent,
                coverage = new { unitsTotal = result.Units?.Length ?? 0, ownInputPartsTotal = inputs.Count, logTotal = result.Log.Length,
                    eventsIncluded = false, after = session.Handoff.SourceAfter, through = result.Version,
                    read = "combat_history_read", scopes = new[] { "discoveries", "inputs", "events", "units", "corrections" } } },
            notice = "Battle effects are already settled. Inline entries are a bounded excerpt, NOT complete continuity. Use combat_history_read for omitted detail relevant to the next action: discoveries selects own intermediate private findings; inputs provides exact questions, changed answers and accepted notes; events provides settled history; units supplies omitted final positions; corrections supplies later host corrections. Keep through=return version for historical pages and follow nextAfter as needed. Do not assume omitted information is absent. Reading every public battle log is not a prerequisite to continue. Preserve audience=actor privacy. Source notes describe statements, promises, relationships and unresolved questions, not mechanical facts. Recheck intent against final positions and later choices; do not automatically resume the interrupted plan, reroll, rebuild combat, replay damage or grant rewards again."
        });
        string packet = Packet();
        while (System.Text.Encoding.UTF8.GetByteCount(packet) > HarnessCombatRecall.MaximumPageBytes && (recent.Count + units.Count + log.Count > 0))
        {
            if (log.Count > 0) log.RemoveAt(0);
            else if (recent.Count > 0) recent.RemoveAt(0);
            else units.RemoveAt(units.Count - 1);
            packet = Packet();
        }
        HarnessJson.Bound(packet, 32768);
        return packet;
    }

    private async Task ScheduleReturnedParent(HarnessRun parent)
    {
        if (parent.CancelRequested || parent.Status != "running" || parent.Steps.Any(s => s.Kind == "model" && s.Status != "done")) return;
        try { await game.ValidateHarnessEmission(parent, "", CancellationToken.None, ExecutionAuthority(parent)); }
        catch (GameException error) when (error.Code is "character_dead" or "game_over")
        {
            // The return/consumed receipts above remain durable. Only further generation stops.
            parent.Status = "failed"; parent.Error = error.Code; runs.Save(parent);
            return;
        }
        Schedule(parent, "");
    }

    private async Task CompleteCombatSession(string campaign, string token, string sessionId, CombatRunAuthority? authority = null)
    {
        var session = await game.ObserveCombatSession(campaign, token, sessionId, CancellationToken.None, authority);
        if (session.BattleId is null || session.ReturnConsumed) return;
        var parent = RequireRun(runs.Read(campaign, session.ParentActorId, session.ParentRunId));
        if (await ReconcileCombatReturn(parent, session, CancellationToken.None)) await ScheduleReturnedParent(parent);
    }

    private void LogCombatContinuation(Exception error)
    {
        if (error is GameException gameError) logger.LogWarning("Combat session continuation retained ({Code})", gameError.Code);
        else logger.LogError("Combat session continuation retained ({ErrorType})", error.GetType().Name);
    }

    // Called after a successful authorized command, outside CampaignStore's gate.
    // It never replaces/replays that command and never runs from GET or startup.
    public async Task<ActionResponse> ObserveCombatCommand(string campaign, string token, string requestId, int expectedVersion, Task<ActionResponse> command)
    {
        var response = await command;
        if (response.Snapshot.Combat is not null) await ObserveCombatCommand(campaign, token, requestId, expectedVersion);
        return response;
    }

    public async Task<BoardCommandResponse> ObserveCombatCommand(string campaign, string token, string requestId, int expectedVersion, Task<BoardCommandResponse> command)
    {
        var response = await command;
        await ObserveCombatCommand(campaign, token, requestId, expectedVersion);
        return response;
    }

    private async Task ObserveCombatCommand(string campaign, string token, string requestId, int expectedVersion)
    {
        try
        {
            await scheduling.WaitAsync();
            try
            {
                campaign = JsonFiles.CampaignId(campaign);
                if (stopping || CampaignExecuting(campaign)) return;
                if (await game.ReadCombatSession(campaign, token, CancellationToken.None) is { } session)
                {
                    await CompleteCombatSession(campaign, token, session.Id);
                    if (!CampaignExecuting(campaign)) await ScheduleCombatCommand(campaign, token, requestId, expectedVersion);
                }
            }
            finally { scheduling.Release(); }
        }
        catch (Exception error) { LogCombatContinuation(error); } // the original committed response remains authoritative
    }

    private async Task AfterExecution(HarnessRun finished, string token)
    {
        using var timeline = CampaignTimeline.Bind(finished.TimelineId, mutation: true);
        await scheduling.WaitAsync();
        try
        {
            if (stopping || CampaignExecuting(finished.CampaignId)) return;
            if (finished.Status == "delegated" && !finished.CancelRequested)
                await StartDelegatedChild(finished, token, CancellationToken.None);
            else if (finished.CombatSessionId is { } sessionId)
                await CompleteCombatSession(finished.CampaignId, token, sessionId, ExecutionAuthority(finished));
        }
        catch (Exception error) { LogCombatContinuation(error); }
        finally { scheduling.Release(); }
    }
}
