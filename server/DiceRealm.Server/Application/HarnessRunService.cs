using System.Diagnostics;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class HarnessRunService(GameService game, HarnessRunStore runs, IHarnessRuntime runtime,
    IHarnessModel model, IConfiguration configuration, ILogger<HarnessRunService> logger, HarnessHistoryManager historyManager) : IHostedService, IDisposable
{
    private readonly SemaphoreSlim scheduling = new(1, 1);
    private readonly Dictionary<string, ActiveRun> active = [];
    private bool stopping;
    private sealed class ActiveRun(CancellationTokenSource cancellation)
    {
        public CancellationTokenSource Cancellation { get; } = cancellation;
        public Task Task { get; set; } = Task.CompletedTask;
    }
    // Associate trusted adapter evidence with exactly the callback it rejected. A wire error
    // or another unfinished model slot cannot acquire this evidence by matching an error code.
    private sealed class RejectedModelStep(string id, HarnessModelNotSentException rejection) : Exception
    {
        public string Id { get; } = id;
        public string Code { get; } = rejection.Code;
    }
    private static string Key(string campaign, string actor, string id) => campaign + ":" + actor + ":" + id;
    private static void ValidateId(string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new GameException("invalid_input", "需要合法的 requestId。");
    }
    private void RequireEnabled(HarnessAuthorization auth)
    {
        if (!configuration.GetValue("Harness:Enabled", false) || !model.Enabled || auth.OfflineTrial || stopping)
            throw HarnessJson.Conflict("harness_disabled");
    }
    private static HarnessRun RequireRun(HarnessRun? run) => run ?? throw new GameException("harness_not_found", "没有当前席位的此运行。", 404);
    private HarnessRunView View(HarnessRun run, bool replayed = false)
    {
        string status = run.Status;
        if (status == "running" && !active.ContainsKey(Key(run.CampaignId, run.ActorId, run.Id))) status = "interrupted";
        if (run.CancelRequested && status is "running" or "waiting") status = "cancelling";
        string notice = run.CancelRequested || status == "cancelled"
            ? run.Wait?.Kind switch
            {
                "roll" => "已停止此运行的后续生成，但没有撤销关联投掷。请读取当前快照，用 rolls/respond、原 rollId 和 decision=cancel 明确放弃；原本人确认仍然有效。",
                "intent" => "已停止此运行的后续生成，但没有撤销关联候选。请读取当前快照，用 intents/respond、原 intentId 和 decision=cancel 明确放弃；原本人确认仍然有效。",
                "ruling" => "已停止此运行的后续生成。已提交的主持裁定请求保留，请在原裁定入口处理。",
                _ => "已停止后续生成；已经提交的游戏效果和可能发生的供应商调用不会撤回。"
            } : status == "delegated" ? "战斗子会话正在主持；请继续使用原行动输入框，探索将在战斗结束后接回结果。" : "";
        if (status == "failed") notice = AdventureSessions.ContextFailureNotice(run.Error);
        if (run.CombatFirstInput && run.Error == "harness_model_unknown" && run.Steps.Count == 0)
            notice = "读档前此战斗输入已有模型调用，当前存档没有其结果。该输入已停止且不会再次发送，可用新的输入继续当前战斗。";
        else if (status == "unknown" && run.CombatReturnId is not null)
            notice = "已保存战斗回传记录；原行动的模型结果仍未知，不会恢复生成。交接完成后可用新的输入继续探索。";
        // Explicit metadata projection only: never serialize Result/Reply, model messages,
        // tool arguments or preset/Skill bodies as "progress". Old steps have no tool label.
        var progress = run.Steps.Select((step, index) => new HarnessProgressStep(index + 1,
            step.Kind, step.Status, step.ToolName ?? "", step.Outcome?.Version, step.Outcome?.Wait?.Kind ?? "")).ToArray();
        var binding = new HarnessRunBinding(run.Profile.Preset.Id, run.Profile.Preset.Version,
            run.Profile.Hash, run.Profile.Skills.Select(skill => skill.Id).ToArray());
        return new(run.Id, status, run.Version, run.Wait, run.Text, run.Error, run.ModelAttempts,
            run.Steps.Count(s => s.Kind == "tool"), replayed, notice, run.Opening || run.CombatCommand is not null ? "" : run.Input, run.Opening ? "" : run.IntentId, binding, progress, run.CombatSessionId ?? run.DelegatedSessionId,
            run.ToolContractVersion < 36 ? null : run.CombatSessionId is null ? "exploration" : "combat", run.CombatParentRunId, Opening: run.Opening, FirstCombatInput: run.CombatFirstInput);
    }
    public async Task<HarnessActiveRuns> ListActive(string campaign, string token, CancellationToken ct)
    {
        campaign = JsonFiles.CampaignId(campaign);
        var auth = await game.AuthorizeHarness(campaign, token, ct);
        await scheduling.WaitAsync(ct);
        try
        {
            // Discovery is read-only, including after a restart or when execution is disabled.
            // Legacy terminal records can remain in the hot directory; do not migrate on GET.
            var unfinished = runs.ListActive(campaign, auth.ActorId)
                .Where(run => run.Status is "running" or "waiting" or "delegated").ToList();
            // A stopped parent can still own a pending battle return. Include its exact
            // durable reference even when its journal has moved to closed storage.
            var battle = await game.ReadCombatSession(campaign, token, ct);
            if (battle?.ParentActorId == auth.ActorId && unfinished.All(r => r.Id != battle.ParentRunId))
                unfinished.Add(RequireRun(runs.Read(campaign, auth.ActorId, battle.ParentRunId)));
            if (auth.OpeningNeeded)
                foreach (var entry in runs.ListRecent(campaign, auth.ActorId).Where(r => r.Opening))
                    if (unfinished.All(r => r.Id != entry.Id)) unfinished.Add(entry);
            var views = new List<HarnessRunView>();
            foreach (var run in unfinished.OrderBy(r => r.Id, StringComparer.Ordinal)) views.Add(await ObservedView(run, token, ct));
            var others = active.Keys.Where(key => key.StartsWith(campaign + ":", StringComparison.Ordinal)).Select(key => key.Split(':')[1])
                .Where(actor => actor != auth.ActorId).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
            return new(views.ToArray()) { OthersActing = others };
        }
        finally { scheduling.Release(); }
    }
    public async Task<AdventureProgress> HostProgress(string campaign, string token, CancellationToken ct, string? actorId = null, string? actionId = null)
    {
        campaign = JsonFiles.CampaignId(campaign);
        var actors = await game.AuthorizeHarnessProgress(campaign, token, ct, includeRevoked: actionId is not null);
        if ((actorId is null) != (actionId is null)) throw new GameException("invalid_input", "需要同时提供行动与席位标识。");
        if (actionId is not null) { ValidateId(actionId); actionId = JsonFiles.CampaignId(actionId); }
        await scheduling.WaitAsync(ct);
        try
        {
            if (actionId is not null)
            {
                var actor = actors.FirstOrDefault(a => a.Id == actorId);
                if (actor is null) throw new GameException("harness_not_found", "没有本战役的此行动记录。", 404);
                var saved = runs.ReadAction(campaign, actor.Id, actionId);
                return new(saved is null ? [] : [await Progress(saved, actor)]);
            }
            var progress = new List<AdventureRunProgress>();
            foreach (var actor in actors)
                foreach (var saved in runs.ListRecent(campaign, actor.Id)) progress.Add(await Progress(saved, actor));
            return new(progress.ToArray());
            async Task<AdventureRunProgress> Progress(HarnessRun saved, AdventureProgressActor actor)
            {
                var run = await ObservedView(saved, token, ct);
                return new AdventureRunProgress(run.Id, actor.Id, actor.Name, run.Status,
                    run.Status == "completed" && (saved.Opening || saved.ToolContractVersion >= 43 && saved.Steps.LastOrDefault()?.Outcome?.CompletedNarrative is not null || !string.IsNullOrWhiteSpace(run.Text)), run.Progress ?? [], saved.Opening ? "" : saved.IntentId, saved.Version, saved.Opening || saved.CombatFirstInput || saved.CombatCommand is not null ? "" : saved.Input, run.Recovery, run.Recovery is not null ? run.Notice : run.Status == "failed" ? AdventureSessions.Notice(run) : null);
            }
        }
        finally { scheduling.Release(); }
    }
    public async Task<AdventureStepDetail> HostStep(string campaign, string token, string actorId, string actionId, int number, CancellationToken ct)
    {
        campaign = JsonFiles.CampaignId(campaign);
        var actors = await game.AuthorizeHarnessProgress(campaign, token, ct, includeRevoked: true);
        ValidateId(actionId); actionId = JsonFiles.CampaignId(actionId);
        if (number < 1) throw new GameException("invalid_input", "执行步骤编号无效。");
        if (!actors.Any(actor => actor.Id == actorId)) throw new GameException("harness_not_found", "没有本战役的此行动记录。", 404);
        await scheduling.WaitAsync(ct);
        try
        {
            var run = RequireRun(runs.ReadAction(campaign, actorId, actionId));
            if (number > run.Steps.Count) throw new GameException("harness_not_found", "没有此执行步骤。", 404);
            var step = run.Steps[number - 1];
            var request = step.ToolRequest;
            // Older journals kept arguments only in the preceding model reply. Match the
            // complete saved callback fingerprint, never tool names or nearest timestamps.
            if (request is null && step.Kind == "tool")
                foreach (var modelStep in run.Steps.Take(number - 1).Where(s => s.Kind == "model" && s.Status == "done"))
                    foreach (var call in HarnessJson.Read<HarnessModelReply>(modelStep.Result!.Value).ToolCalls)
                    {
                        var candidate = new HarnessToolRequest(call.Name, call.Arguments, call.Id);
                        if (step.Fingerprint == HarnessJson.Fingerprint(HarnessJson.Element(new { runId = run.Id, stepId = step.Id, step.Kind, Payload = candidate })))
                            request = candidate;
                    }
            JsonElement? response = step.Status != "done" ? null : step.Kind == "model"
                ? HarnessJson.Element(HarnessJson.Read<HarnessModelReply>(step.Result!.Value))
                : HarnessJson.Element(HarnessJson.Read<HarnessToolReply>(step.Result!.Value));
            return new(run.Id, run.IntentId, run.ActorId, number, step.Kind, step.Status,
                request?.Name ?? step.ToolName ?? "", request?.Arguments, response);
        }
        finally { scheduling.Release(); }
    }
    public async Task<HarnessRunView> Get(string campaign, string token, string id, CancellationToken ct)
    {
        ValidateId(id); id = JsonFiles.CampaignId(id); campaign = JsonFiles.CampaignId(campaign);
        var auth = await game.AuthorizeHarness(campaign, token, ct);
        await scheduling.WaitAsync(ct);
        try { return await ObservedView(RequireRun(runs.Read(campaign, auth.ActorId, id)), token, ct); }
        finally { scheduling.Release(); }
    }
    // The player's answers to this run's DM questions, in order (HarnessGameService.HarnessContinue).
    private static string[] PlayerAnswers(HarnessRun run) => run.Turns.Skip(1).Select(turn =>
    {
        using var json = System.Text.Json.JsonDocument.Parse(turn);
        return json.RootElement.TryGetProperty("playerAnswer", out var answer) ? answer.GetString() : null;
    }).OfType<string>().ToArray();
    public async Task<HarnessRunView> Start(string campaign, string token, HarnessInputRequest request, CancellationToken ct, bool opening = false)
    {
        ValidateId(request.RequestId); GameService.Text(request.Text, 1000, "text");
        request = request with { RequestId = JsonFiles.CampaignId(request.RequestId) }; campaign = JsonFiles.CampaignId(campaign);
        if (request.ExpectedVersion < 1) throw new GameException("invalid_input", "需要 expectedVersion。");
        string fingerprint = opening ? HarnessJson.Fingerprint(HarnessJson.Element(new { purpose = "opening", request }))
            : HarnessJson.Fingerprint(HarnessJson.Element(request));
        await scheduling.WaitAsync(ct);
        try
        {
            // Restore uses this same scheduling gate. Authorize only after acquiring it,
            // so a request queued on the previous timeline cannot touch restored journals.
            var auth = await game.AuthorizeHarness(campaign, token, ct);
            if (runs.Read(campaign, auth.ActorId, request.RequestId) is { } saved)
            {
                if (saved.Fingerprint != fingerprint) throw HarnessJson.Conflict("harness_run_conflict");
                return View(saved, true); // never schedules another execution on request replay
            }
            RequireEnabled(auth);
            if (active.Count >= 4 || CampaignExecuting(campaign)) throw HarnessJson.Conflict("harness_busy");
            if (runs.ListActive(campaign, auth.ActorId).Any(r => r.Status is "running" or "waiting" && !r.CancelRequested))
                throw HarnessJson.Conflict("harness_run_pending");
            var combatSession = await game.ReadCombatSession(campaign, token, ct);
            if (opening && combatSession is not null) throw HarnessJson.Conflict("opening_context_changed");
            if (combatSession is not null)
            {
                if (active.Keys.Any(key => key.StartsWith(campaign + ":", StringComparison.Ordinal))) throw HarnessJson.Conflict("harness_busy");
                if (runs.Read(campaign, combatSession.Inputs[0].ActorId, combatSession.Inputs[0].RunId) is null)
                {
                    var parent = RequireRun(runs.Read(campaign, combatSession.ParentActorId, combatSession.ParentRunId));
                    if (!parent.CancelRequested) throw HarnessJson.Conflict("combat_delegation_recovery_required");
                    // A fresh explicit input may replace stopped generation, not erase the
                    // committed delegation. Record the abandoned first input without a call.
                    CreateCombatRun(campaign, combatSession, combatSession.Inputs[0], cancelled: true, timelineId: auth.TimelineId);
                }
                // Do not activate campaign-wide pacing while another saved legacy input
                // can still resume with its frozen tool set. It adopts automatically on
                // the next fresh input once those live legacy inputs have settled.
                bool adoptNarration = combatSession.ToolContractVersion >= 48 && combatSession.Inputs.All(i =>
                    runs.Read(campaign, i.ActorId, i.RunId) is { } prior &&
                    (prior.ToolContractVersion >= 49 || prior.Status is not ("running" or "waiting")));
                combatSession = await game.AcceptCombatInput(campaign, token, combatSession.Id, request, fingerprint, ct, adoptNarration);
                var reference = combatSession.Inputs.Single(i => i.ActorId == auth.ActorId && i.RunId == request.RequestId);
                var combatRun = CreateCombatRun(campaign, combatSession, reference, timelineId: auth.TimelineId);
                Schedule(combatRun, token);
                return View(RequireRun(runs.Read(campaign, auth.ActorId, combatRun.Id)));
            }
            var context = await game.ValidateHarnessStart(campaign, token, request.ExpectedVersion, ct, request.Text, opening);
            var run = new HarnessRun
            {
                Id = request.RequestId, IntentId = Guid.NewGuid().ToString(), CampaignId = campaign, ActorId = auth.ActorId, Fingerprint = fingerprint,
                Input = request.Text, TimelineId = auth.TimelineId, Opening = opening, Profile = context.Profile, MemorySnapshot = context.Memory, Version = request.ExpectedVersion,
                ToolContractVersion = HarnessTools.CurrentVersion, RulesCatalogVersion = context.RulesCatalogVersion,
                Limits = new(Math.Clamp(configuration.GetValue("Harness:MaxModelCalls", 16), 1, 16),
                    Math.Clamp(configuration.GetValue("Harness:MaxToolCalls", 32), 1, 32), ProviderDefaultOutput: true),
                Turns = [HarnessJson.Serialize(new { input = request.Text, ruleset = "dnd2024", memory = context.Memory })],
            TurnVersions = [request.ExpectedVersion]
            };
            runs.Create(run);
            Schedule(run, token);
            // The executor owns the mutable instance after scheduling. Project an atomic
            // persisted copy rather than enumerating Steps while its callback appends.
            return View(RequireRun(runs.Read(campaign, auth.ActorId, run.Id)));
        }
        finally { scheduling.Release(); }
    }
    public async Task<HarnessRunView> Resume(string campaign, string token, string id, HarnessResumeRequest request, CancellationToken ct)
    {
        ValidateId(id); ValidateId(request.RequestId);
        id = JsonFiles.CampaignId(id); campaign = JsonFiles.CampaignId(campaign);
        request = request with { RequestId = JsonFiles.CampaignId(request.RequestId) };
        if (request.ExpectedVersion < 1 || request.Text is null || request.Text.Length > 1000 || request.Text.Any(char.IsControl))
            throw new GameException("invalid_input", "续接内容无效。");
        string fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(request));
        await scheduling.WaitAsync(ct);
        try
        {
            var auth = await game.AuthorizeHarness(campaign, token, ct);
            var run = RequireRun(runs.Read(campaign, auth.ActorId, id));
            if (run.Resumes.FirstOrDefault(r => r.Id == request.RequestId) is { } receipt)
            {
                if (receipt.Fingerprint != fingerprint) throw HarnessJson.Conflict("harness_run_conflict");
                return View(run, true);
            }
            if (ExecutionAuthority(run) is { } returnAuthority)
                await game.AuthorizeHarness(campaign, token, ct, returnAuthority);
            if (run.ToolContractVersion >= 23 && run.Status == "running" && !run.CancelRequested &&
                !active.ContainsKey(Key(campaign, auth.ActorId, id)) && run.Steps.LastOrDefault()?.Outcome?.CompletedNarrative is { } accepted)
            {
                // The game and completed tool slot are already durable. Finishing this
                // journal marker is a replay, not new work; unrelated later versions or
                // disabled providers must not strand an accepted final response.
                if (request.Text.Length > 0) throw HarnessJson.Conflict("harness_not_resumable");
                run.Text = accepted; run.Status = "completed"; run.Error = ""; run.Wait = null;
                if (run.ExecutionStartedAt is { } started) run.RuntimeMilliseconds += Math.Max(0, (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds);
                run.ExecutionStartedAt = null;
                run.Resumes.Add(new(request.RequestId, fingerprint));
                runs.Save(run);
                return View(run);
            }
            // An unknown parent can receive/consume a saved battle return even with the
            // provider disabled. It must never become runnable through this recovery path.
            if (run.Status != "unknown") RequireEnabled(auth);
            if (CampaignExecuting(campaign)) throw HarnessJson.Conflict("harness_busy");
            if (run.DelegatedSessionId is { } delegated)
            {
                var session = await game.ObserveCombatSession(campaign, token, delegated, ct);
                if (run.Status == "delegated" || !session.ReturnConsumed || run.CombatReturnId is not null && run.Status == "running" &&
                    !run.Steps.Any(s => s.Id.StartsWith((run.Turns.Count - 1) + ":", StringComparison.Ordinal)))
                {
                    if (request.Text.Length > 0) throw HarnessJson.Conflict("harness_not_resumable");
                    if (await ReconcileCombatReturn(run, session, ct))
                    {
                        if (run.Status != "unknown" && run.Steps.Any(s => s.Kind == "model" && s.Status != "done")) throw HarnessJson.Conflict("harness_model_unknown");
                        run.Resumes.Add(new(request.RequestId, fingerprint)); runs.Save(run);
                        await ScheduleReturnedParent(run);
                    }
                    else
                    {
                        await StartDelegatedChild(run, token, ct);
                        run.Resumes.Add(new(request.RequestId, fingerprint)); runs.Save(run);
                    }
                    return await ObservedView(RequireRun(runs.Read(campaign, auth.ActorId, id)), token, ct);
                }
            }
            if (active.Count >= 4 || active.ContainsKey(Key(campaign, auth.ActorId, id))) throw HarnessJson.Conflict("harness_busy");
            if (run.CancelRequested || run.Status is not ("waiting" or "running")) throw HarnessJson.Conflict("harness_not_resumable");
            if (run.Steps.Any(s => s.Kind == "model" && s.Status != "done")) throw HarnessJson.Conflict("harness_model_unknown");
            if (run.Resumes.Count >= HarnessGeneration.ResumeLimit(run) || run.Turns.Count >= HarnessGeneration.TurnLimit(run)) throw HarnessJson.Conflict("harness_turn_limit");
            var pendingTool = run.Steps.LastOrDefault(s => s.Kind is "tool" or "final" && s.Status != "done");
            var continuation = await game.HarnessContinue(campaign, token, auth.ActorId, run.IntentId, run.Version, run.Wait, request, ct,
                pendingTool?.CommandId, pendingTool?.Fingerprint, ExecutionAuthority(run), run.CombatSessionId, run.Id);
            run.Version = continuation.Version;
            if (run.Wait is not null) { run.OfferedIds = []; run.ContextReadVersion = 0; run.OfferedMemoryIds = null; }
            run.Resumes.Add(new(request.RequestId, fingerprint));
            if (continuation.Cancelled) { run.Status = "cancelled"; run.Error = "harness_consent_cancelled"; run.Wait = null; }
            else if (continuation.Wait is { } wait) { run.Wait = wait; run.Status = "waiting"; }
            else
            {
                if (continuation.Text != "") { run.Turns.Add(continuation.Text); run.TurnVersions?.Add(continuation.Version); }
                run.Wait = null; run.Status = "running"; run.Error = "";
            }
            runs.Save(run);
            if (run.Status == "running") Schedule(run, token);
            return View(RequireRun(runs.Read(campaign, auth.ActorId, id)));
        }
        finally { scheduling.Release(); }
    }
    public async Task<HarnessRunView> Cancel(string campaign, string token, string id, CancellationToken ct)
    {
        ValidateId(id); id = JsonFiles.CampaignId(id); campaign = JsonFiles.CampaignId(campaign);
        await scheduling.WaitAsync(ct);
        try
        {
            var auth = await game.AuthorizeHarness(campaign, token, ct);
            string key = Key(campaign, auth.ActorId, id);
            active.TryGetValue(key, out var execution);
            var run = runs.Cancel(campaign, auth.ActorId, id, execution is not null);
            execution?.Cancellation.Cancel();
            if (execution is null && run.DelegatedSessionId is { } delegated && (run.CombatReturnId is null || run.Status == "unknown"))
            {
                try
                {
                    var battle = await game.ObserveCombatSession(campaign, token, delegated, ct);
                    await ReconcileCombatReturn(run, battle, ct); // bookkeeping only; cancelled generation stays stopped
                }
                catch (Exception error) { LogCombatContinuation(error); }
            }
            return await ObservedView(run, token, ct);
        }
        finally { scheduling.Release(); }
    }
    private void Schedule(HarnessRun run, string token)
    {
        var entry = new ActiveRun(new CancellationTokenSource());
        string key = Key(run.CampaignId, run.ActorId, run.Id);
        active.Add(key, entry);
        entry.Task = Task.Run(async () =>
        {
            try { await Execute(run, token, entry.Cancellation.Token); }
            finally
            {
                await scheduling.WaitAsync();
                try { active.Remove(key); entry.Cancellation.Dispose(); }
                finally { scheduling.Release(); }
            }
            await AfterExecution(run, token);
        });
    }
    private static void SettleOutstandingLease(HarnessRun run)
    {
        if (run.ExecutionStartedAt is not { } started) return;
        run.RuntimeMilliseconds += Math.Max(0, (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds);
        run.ExecutionStartedAt = null;
    }
    private async Task Execute(HarnessRun run, string token, CancellationToken cancel)
    {
        using var timeline = CampaignTimeline.Bind(run.TimelineId, mutation: true);
        long maximum = Math.Clamp(configuration.GetValue("Harness:TimeoutSeconds", 750), 1, 1800) * 1000L;
        // A crash conservatively counts the entire elapsed outstanding lease, never resets it.
        SettleOutstandingLease(run);
        var stopwatch = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(Math.Max(1, maximum - HarnessGeneration.RuntimeUsed(run))));
        run.ExecutionStartedAt = DateTimeOffset.UtcNow;
        try
        {
            runs.Save(run);
            if (HarnessGeneration.RuntimeUsed(run) >= maximum) throw HarnessJson.Conflict("harness_time_limit");
            while (true)
            {
            var completed = await runtime.Execute(new(Guid.NewGuid().ToString(), run.Profile.Preset.SystemPrompt, run.Turns.ToArray(), HarnessTools.ForVersion(run.ToolContractVersion), HarnessGeneration.ReplayLimits(run),
                    run.ToolContractVersion >= HarnessContextCompactor.HistoryToolVersion ? HarnessContextCompactor.HistoryPolicy :
                        run.ToolContractVersion >= 5 ? HarnessContextCompactor.Policy : null),
                (call, ct) => Callback(run, token, call, ct), timeout.Token);
            CheckCancellation(run, timeout.Token);
            if (completed.Stopped)
            {
                var accepted = run.Steps.LastOrDefault()?.Outcome?.CompletedNarrative;
                if (run.Steps.LastOrDefault()?.Outcome?.DelegatedSessionId is { } delegated)
                {
                    run.DelegatedSessionId = delegated; run.Status = "delegated";
                }
                else if (accepted is not null)
                {
                    if (run.Wait is not null || run.ToolContractVersion < 23)
                        throw HarnessJson.Conflict("harness_invalid_stop");
                    // The narrative and this completion evidence were accepted together in
                    // the original game transaction. Do not generate or save it a second time.
                    run.Text = accepted;
                    run.Status = "completed";
                }
                else
                {
                    if (run.Wait is null) throw HarnessJson.Conflict("harness_invalid_stop");
                    run.Status = "waiting";
                }
            }
            else
            {
                if (run.Wait is not null) throw HarnessJson.Conflict("harness_invalid_stop");
                if (run.Opening) throw HarnessJson.Conflict("opening_commit_required");
                string text = WorldMemories.Text(completed.Text, 4096, multiline: true);
                var call = new HarnessCallback((run.Turns.Count - 1) + ":final:0", "final", run.Turns.Count - 1, 0,
                    HarnessJson.Element(new HarnessToolRequest("narrative_commit", HarnessJson.Element(new NarrativeHarnessArgs(text, [])), "final")));
                await Callback(run, token, call, timeout.Token);
                if (run.Steps.LastOrDefault()?.Outcome?.ContinueCombat == true)
                {
                    // The plain-text reply has been saved as the current beat, not as
                    // completion of the remaining authoritative queue. Preserve its
                    // receipt, then resume the same runtime with a fresh execution frame.
                    run.Turns.Add(HarnessJson.Serialize(new { combatContinuation = run.CombatCommand is not null
                        ? "The preceding command story beat is saved. Continue ONLY the remaining authoritative combat queue using the current execution frame; stop at the next player boundary. Do not repeat that story or perform a new player action."
                        : "The preceding story beat is saved. Continue the original player input and any remaining combat queue using the current execution frame; do not repeat that story or any settled action." }));
                    run.TurnVersions?.Add(run.Version);
                    runs.Save(run);
                    continue;
                }
                run.Text = text; run.Status = "completed";
            }
            break;
            }
        }
        catch (Exception ex)
        {
            var rejected = ex as RejectedModelStep;
            bool unknown = run.Steps.Any(s => s.Kind == "model" && s.Status != "done" && s.Id != rejected?.Id);
            bool recoverableTransport = ex is IOException || ex is GameException { Code: "harness_runtime_failed" or "harness_runtime_eof" };
            run.Status = unknown ? "unknown" : cancel.IsCancellationRequested || run.CancelRequested ? "cancelled" :
                recoverableTransport ? run.Wait is null ? "running" : "waiting" : "failed";
            run.Error = unknown ? "harness_model_unknown" : rejected is not null ? rejected.Code : ex is GameException gameError ? gameError.Code :
                ex is OperationCanceledException ? cancel.IsCancellationRequested ? "harness_cancelled" : "harness_time_limit" : "harness_runtime_failed";
            logger.LogWarning("Harness stopped ({Code}); run {RunId}, error {ErrorType}, last step {StepId}, tool {ToolName}",
                run.Error, run.Id, ex.GetType().Name, run.Steps.LastOrDefault()?.Id ?? "", run.Steps.LastOrDefault()?.ToolName ?? "");
        }
        finally
        {
            run.RuntimeMilliseconds += stopwatch.ElapsedMilliseconds; run.ExecutionStartedAt = null;
            try { runs.Save(run); }
            catch (Exception ex) { logger.LogError("Harness journal finalization failed ({ErrorType})", ex.GetType().Name); }
        }
    }
    private void CheckCancellation(HarnessRun run, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (run.CancelRequested || runs.Read(run.CampaignId, run.ActorId, run.Id)?.CancelRequested == true)
        { run.CancelRequested = true; throw new OperationCanceledException(); }
    }
    private async Task<JsonElement> Callback(HarnessRun run, string token, HarnessCallback call, CancellationToken ct)
    {
        CheckCancellation(run, ct);
        var authority = ExecutionAuthority(run);
        var auth = await game.AuthorizeHarness(run.CampaignId, token, ct, authority); // including every replay
        RequireEnabled(auth);
        if (auth.ActorId != run.ActorId) throw HarnessJson.Conflict("harness_profile_changed");
        if (call.Turn < 0 || call.Turn >= run.Turns.Count || call.Sequence < 0 || call.Sequence > 64 ||
            call.Kind is not ("model" or "tool" or "final") || call.Id != $"{call.Turn}:{call.Kind}:{call.Sequence}")
            throw HarnessJson.Conflict("harness_invalid_callback");
        BoundCallback(run, call.Payload, call.Kind == "model");
        HarnessPreparedContext? prepared = null;
        IHarnessModel? capturedModel = null;
        HarnessExecutionFrame? executionFrame = null;
        HarnessToolRequest? toolRequest = null;
        if (call.Kind is "tool" or "final")
        {
            toolRequest = HarnessJson.Read<HarnessToolRequest>(call.Payload);
            if (call.Kind == "tool" && !HarnessTools.ForVersion(run.ToolContractVersion).Any(tool => tool.Name == toolRequest.Name) ||
                call.Kind == "final" && toolRequest.Name != "narrative_commit")
                throw HarnessJson.Conflict("harness_tool_unavailable");
        }
        string fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(new { runId = run.Id, stepId = call.Id, call.Kind, call.Payload }));
        var step = run.Steps.FirstOrDefault(s => s.Id == call.Id);
        if (step is not null)
        {
            if (step.Fingerprint != fingerprint) throw HarnessJson.Conflict("harness_replay_mismatch");
            if (step.Status == "done") return step.Result!.Value;
            if (step.Kind == "model") throw HarnessJson.Conflict("harness_model_unknown");
        }
        else
        {
            if (run.Wait is not null || call.Turn != run.Turns.Count - 1) throw HarnessJson.Conflict("harness_replay_mismatch");
            if (run.DelegatedSessionId is not null && run.CombatReturnId is null) throw HarnessJson.Conflict("combat_session_owned");
            if (run.Steps.Any(s => s.Outcome?.CompletedNarrative is not null))
                throw HarnessJson.Conflict("harness_completed");
            if (run.Steps.Count >= HarnessGeneration.StepLimit(run)) throw HarnessJson.Conflict("harness_step_limit");
            if (call.Kind == "model")
            {
                await game.ValidateHarnessEmission(run, token, ct, authority);
                runs.RequireNewModel(run, call.Id);
                if (auth.Version != run.Version) throw HarnessJson.Conflict("stale_version");
                if (run.ModelAttempts >= HarnessGeneration.ModelLimit(run)) throw HarnessJson.Conflict("harness_model_limit");
                capturedModel = run.ToolContractVersion >= HarnessContextCompactor.HistoryToolVersion ? model.Capture() : model;
                var request = HarnessJson.Read<HarnessModelRequest>(call.Payload);
                ValidateModelRequest(run, request);
                var history = run.Steps.Where(s => s.Kind == "model" && s.Status == "done")
                    .Select(s => new HarnessModelExchange(HarnessJson.Read<HarnessModelReply>(s.Result!.Value), s.ProviderContinuation)).ToArray();
                request = request with
                {
                    ProviderHistory = history,
                    PriorProviderIdentities = history.Where(h => h.Continuation is not null).Select(h => h.Continuation!.Identity)
                        .Concat(run.Steps.Where(s => s.ProviderIdentity is not null).Select(s => s.ProviderIdentity!)).Distinct().ToArray()
                };
                if (run.ToolContractVersion < HarnessContextCompactor.HistoryToolVersion)
                    request = HarnessCombatHistories.Project(request, run.CombatHistory);
                else if (run.CombatHistory is { } combatHistory)
                    request = request with { PriorProviderIdentities = request.PriorProviderIdentities.Concat(combatHistory.ProviderIdentities).Distinct().ToArray() };
                if (run.ToolContractVersion >= HarnessExecutionProtocol.Version)
                {
                    executionFrame = await game.ReadHarnessExecution(run.CampaignId, token, run.ActorId, run.IntentId, run.Input, run.Version, ct, run.ToolContractVersion, run.Profile.Skills.Length > 0, run.Id, run.CombatSessionId, authority, run.Opening, run.RulesCatalogVersion);
                    if (executionFrame.DmChecklist is { } checklist)
                        executionFrame = executionFrame with { DmChecklist = checklist.WithReceipts(run.Steps) };
                    if (run.ToolContractVersion >= HarnessContextCompactor.HistoryToolVersion)
                        (executionFrame, prepared) = PrepareHistoryTransport(run, request, executionFrame);
                    else request = HarnessExecutionProtocol.Project(request, executionFrame, run.ToolContractVersion);
                }
                prepared ??= run.ToolContractVersion >= HarnessContextCompactor.HistoryToolVersion
                    ? HarnessContextCompactor.PreserveCurrent(request)
                    : run.ToolContractVersion >= 5 ? HarnessContextCompactor.Prepare(request, providerEncoding: run.ToolContractVersion >= 23, maximumMessages: run.CombatSessionId is null ? null : 128) : new(request, null);
                if (prepared.Plan is { OmittedExchanges: > 0 })
                {
                    // Summarized historical IDs no longer serve as a model's current context.
                    // A fresh full context/list/search is required after a reduction.
                    run.OfferedIds = []; run.ContextReadVersion = 0; run.OfferedMemoryIds = null;
                }
                if (executionFrame is not null)
                {
                    // Compaction may revoke historical references; the freshly supplied frame
                    // then grants ONLY its current public IDs, never a replayed old frame.
                    run.OfferedIds = executionFrame.Context.Intent.Candidates.Select(c => c.Id).ToArray();
                    run.ContextReadVersion = executionFrame.Version;
                    var publicIds = executionFrame.Context.KnownMemory.Select(m => m.Id)
                        .Concat(executionFrame.WorkingContext?.PublicEvidence.Select(m => m.Id) ?? []).Distinct(StringComparer.Ordinal).ToArray();
                    run.OfferedMemoryIds = (run.OfferedMemoryIds ?? []).Where(id => !publicIds.Contains(id, StringComparer.Ordinal))
                        .Concat(publicIds).Distinct(StringComparer.Ordinal).TakeLast(256).ToArray();
                }
                run.ModelAttempts++;
            }
            else if (call.Kind == "tool" && run.Steps.Count(s => s.Kind == "tool") >= HarnessGeneration.ToolLimit(run))
                throw HarnessJson.Conflict("harness_tool_limit");
            step = new()
            {
                Id = call.Id, Kind = call.Kind, Fingerprint = fingerprint, CommandId = Guid.NewGuid().ToString(),
                ToolName = call.Kind == "tool" ? toolRequest!.Name : null, ToolRequest = toolRequest,
                ContextPlan = prepared?.Plan, ExecutionFrame = executionFrame
            };
            run.Steps.Add(step); runs.Save(run); // before any external request or possible state write
        }
        if (call.Kind == "model")
        {
            var request = prepared?.Request ?? throw HarnessJson.Conflict("harness_model_unknown");
            request = request with { BeforeProviderRequest = async (identity, requestCt) =>
            {
                CheckCancellation(run, requestCt);
                await game.ValidateHarnessEmission(run, token, requestCt, authority);
                if (run.ToolContractVersion < 36) return;
                if (identity is not { Length: 64 } || !identity.All(char.IsAsciiHexDigit) ||
                    step.ProviderIdentity is not null && step.ProviderIdentity != identity)
                    throw new HarnessModelNotSentException(HarnessModelRejection.Contract);
                var current = await game.AuthorizeHarness(run.CampaignId, token, requestCt, authority);
                if (current.ActorId != run.ActorId || current.Version != run.Version) throw HarnessJson.Conflict("stale_version");
                CheckCancellation(run, requestCt);
                step.ProviderIdentity = identity;
                runs.Save(run); // survives a first request with no saved response/native parts
            }, BeforeProviderRetry = async retryCt =>
            {
                CheckCancellation(run, retryCt);
                await game.ValidateHarnessEmission(run, token, retryCt, authority);
                var current = await game.AuthorizeHarness(run.CampaignId, token, retryCt, authority);
                CheckCancellation(run, retryCt);
                RequireEnabled(current);
                if (current.ActorId != run.ActorId) throw HarnessJson.Conflict("harness_profile_changed");
                if (current.Version != run.Version) throw HarnessJson.Conflict("stale_version");
                if (run.ModelAttempts >= HarnessGeneration.ModelLimit(run)) throw HarnessJson.Conflict("harness_model_limit");
                run.ModelAttempts++;
                runs.Save(run); // durable before reserving/sending the next attempt of this slot
            } };
            HarnessModelReply reply;
            ModelRequestScope.Current = new(run.CampaignId, run.Id, run.Input);
            try
            {
                var provider = capturedModel ?? model;
                request = await PrepareHistoryInput(run, token, step, executionFrame, request, authority, ct);
                reply = await provider.Complete(request, run.CampaignId, ct).WaitAsync(ct);
            }
            catch (HarnessModelNotSentException rejection) { throw new RejectedModelStep(step.Id, rejection); }
            // Keep started/attempts on rejection. No synthetic reply or retry; a crash before
            // terminal persistence remains conservatively unknown on recovery.

            ValidateModelReply(reply, run.Limits, run.ToolContractVersion);
            if (step.ContextPlan is { Policy: HarnessContextCompactor.HistoryPolicy } plan)
                step.ContextPlan = plan with { ReportedInputTokens = reply.ReportedInputTokens };
            run.Tokens = checked(run.Tokens + reply.InputTokens + reply.OutputTokens);
            reply.ProviderContinuation?.Validate();
            step.Result = HarnessJson.Element(reply);
            step.ProviderContinuation = reply.ProviderContinuation;
        }
        else
        {
            HarnessToolOutcome outcome;
            try
            {
                outcome = toolRequest!.Name == "combat_history_read"
                    ? await game.ReadCombatHistory(run.CampaignId, token, run.ActorId, run.Version, run.Id, run.CombatSessionId, authority,
                        HarnessJson.Read<CombatHistoryReadArgs>(toolRequest.Arguments), runs, ct, run.ToolContractVersion)
                    : await game.HarnessTool(run.CampaignId, token, run.ActorId, run.IntentId, run.Input, run.Version,
                    step.CommandId, "harness:" + fingerprint, toolRequest!, run.OfferedIds, ct, run.Profile,
                    run.ToolContractVersion, run.ContextReadVersion == run.Version, run.OfferedMemoryIds, run.RulesCatalogVersion,
                    run.Steps.LastOrDefault(s => s.Kind == "model" && s.Status == "done")?.ExecutionFrame?.Board?.State?.Map, run.Id, run.CombatSessionId, authority, run.Opening,
                    PlayerAnswers(run));
            }
            catch (GameException error) when (run.ToolContractVersion >= 17 && toolRequest!.Name == "world_record" && error.Code == "invalid_world_memory")
            {
                // The game gate has already exited without saving. Never swallow this inside
                // its transaction: even a rejected proposal may have created an in-memory root.
                // Auth/version/IO/unknown failures retain their original terminal semantics.
                outcome = HarnessExecutionProtocol.WorldRecordRejected(run.Version, error.Message);
            }
            catch (GameException error) when (run.ToolContractVersion >= 18 && toolRequest!.Name == "world_record" && error.Code == "invalid_story_items")
            {
                outcome = HarnessExecutionProtocol.InventoryRejected(run.Version, error.Message, run.ToolContractVersion);
            }
            catch (GameException error) when (run.ToolContractVersion >= 32 &&
                (toolRequest!.Name is "token_spawn" or "token_move" or "token_update" or "token_remove") &&
                error.Code is "invalid_board_command" or "board_source_unavailable")
            {
                // The campaign transaction has rolled back. Correctable model arguments
                // must not discard the entire natural action; auth/version/IO errors still fail.
                outcome = HarnessExecutionProtocol.BoardProposalRejected(run.Version, error.Code, error.Message);
            }
            catch (GameException error) when (run.ToolContractVersion >= 42 && toolRequest!.Name == "map_select" &&
                error.Code is "map_not_found" or "invalid_map_id" or "stale_board_map" or "board_scene_mismatch" or "board_combat_map_locked")
            {
                outcome = HarnessExecutionProtocol.ArgumentsRejected(run.Version, toolRequest.Name, error.Code, error.Message, run.ToolContractVersion);
            }
            catch (GameException error) when (run.ToolContractVersion >= 35 && toolRequest!.Name is "encounter_prepare" or "encounter_engage" &&
                (error.Code is "encounter_setup_unavailable" or "encounter_source_unavailable" || error.Code.StartsWith("board_combat_", StringComparison.Ordinal)))
            {
                outcome = HarnessExecutionProtocol.ArgumentsRejected(run.Version, toolRequest.Name, error.Code, error.Message, run.ToolContractVersion);
            }
            catch (GameException error) when (run.ToolContractVersion >= 47 && toolRequest!.Name == "combat_delegate" &&
                error.Code == "encounter_setup_unavailable")
            {
                outcome = HarnessExecutionProtocol.ArgumentsRejected(run.Version, toolRequest.Name, error.Code, error.Message, run.ToolContractVersion);
            }
            catch (GameException error) when (run.ToolContractVersion >= 39 &&
                error.Code is "opening_placement_required" or "opening_placement_unavailable")
            {
                outcome = HarnessExecutionProtocol.ArgumentsRejected(run.Version, toolRequest!.Name, error.Code, error.Message, run.ToolContractVersion);
            }
            catch (GameException error) when (run.ToolContractVersion >= 33 &&
                (error.Code == "harness_invalid_payload" || toolRequest!.Name == "check_request" &&
                    error.Code is "invalid_ruling_check" or "check_source_unavailable" or "check_already_requested" or "check_context_unavailable"))
            {
                outcome = HarnessExecutionProtocol.ArgumentsRejected(run.Version, toolRequest!.Name, error.Code, error.Message, run.ToolContractVersion);
            }
            if (run.ToolContractVersion >= 47 && toolRequest!.Name == "map_request" && !outcome.Reply.IsError &&
                HarnessJson.Read<HarnessMapRequestArgs>(toolRequest.Arguments).Purpose == "tactical")
            {
                using var queued = JsonDocument.Parse(outcome.Reply.Content);
                if (queued.RootElement.TryGetProperty("map", out var map) &&
                    map.GetProperty("status").GetString() is "pending" or "generating")
                    outcome = await game.AwaitHarnessMap(run.CampaignId, token, run.ActorId, run.Version,
                        step.CommandId, "harness:" + fingerprint, ct, authority);
            }
            if (outcome.Version != run.Version || run.ToolContractVersion >= HarnessExecutionProtocol.Version && outcome.Wait is not null)
            { run.OfferedIds = []; run.ContextReadVersion = 0; run.OfferedMemoryIds = null; }
            run.Version = outcome.Version; run.Wait = outcome.Wait;
            if (outcome.DelegatedSessionId is { } delegated) { run.DelegatedSessionId = delegated; run.CombatReturnId = null; }
            if (outcome.OfferedIds is { } offered) run.OfferedIds = offered;
            if (outcome.OfferedMemoryIds is { } memoryIds)
                run.OfferedMemoryIds = (run.OfferedMemoryIds ?? []).Where(id => !memoryIds.Contains(id, StringComparer.Ordinal)).Concat(memoryIds).Distinct(StringComparer.Ordinal).TakeLast(256).ToArray();
            if (run.ToolContractVersion != 0 && toolRequest!.Name == "context_read" &&
                (run.ToolContractVersion < 23 || HarnessJson.Read<HarnessContextReadArgs>(toolRequest.Arguments).Scope == "context"))
                run.ContextReadVersion = outcome.Version;
            step.Outcome = outcome; step.Result = HarnessJson.Element(outcome.Reply);
        }
        step.Status = "done"; runs.Save(run); // durable output before SDK may take another step
        return step.Result.Value;
    }
    private static void BoundCallback(HarnessRun run, JsonElement payload, bool model)
    {
        try { HarnessJson.Bound(payload, model && run.ToolContractVersion >= 5
            ? HarnessContextCompactor.MaximumCallbackBytes : run.Limits.MaxContextBytes); }
        catch (GameException error) when (run.ToolContractVersion >= HarnessContextCompactor.HistoryToolVersion && error.Code == "harness_context_limit")
        { throw HarnessJson.Conflict("harness_transport_limit"); }
    }
    private static void ValidateModelRequest(HarnessRun run, HarnessModelRequest request)
    {
        if (request.System != run.Profile.Preset.SystemPrompt || request.Messages is null || request.Messages.Length < 1 ||
            run.ToolContractVersion < HarnessContextCompactor.HistoryToolVersion && request.Messages.Length > 128 ||
            request.Tools is null || HarnessJson.Fingerprint(HarnessJson.Element(request.Tools)) != HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(run.ToolContractVersion))) ||
            request.MaxTokens is < 0 or > 4096 || request.Messages.Any(m => m is null || m.Content is null || m.Role is not ("user" or "assistant" or "tool")))
            throw HarnessJson.Conflict("harness_model_contract");
        BoundCallback(run, HarnessJson.Element(request), model: true);
    }
    private static void ValidateModelReply(HarnessModelReply reply, HarnessLimits limits, int toolContractVersion)
    {
        if (reply is null || reply.Text is null || reply.Text.Length > limits.MaxOutputCharacters || reply.ToolCalls is null || reply.ToolCalls.Length > 8 ||
            reply.Text == "" && reply.ToolCalls.Length == 0 || reply.InputTokens < 0 || reply.OutputTokens < 0 ||
            toolContractVersion < HarnessContextCompactor.HistoryToolVersion && (reply.InputTokens > 1000000 || reply.OutputTokens > 1000000) ||
            reply.ToolCalls.Any(t => t is null || string.IsNullOrWhiteSpace(t.Id) || t.Id.Length > 128 || !HarnessTools.ForVersion(toolContractVersion).Any(d => d.Name == t.Name) ||
                t.Arguments.ValueKind != JsonValueKind.Object) || reply.ToolCalls.Select(t => t.Id).Distinct().Count() != reply.ToolCalls.Length)
            throw HarnessJson.Conflict("harness_model_output");
        HarnessJson.Bound(reply);
    }
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        runs.InitializeHistory(); // local derived lookup only; never restart or call a model
        if (!configuration.GetValue("Harness:Enabled", false)) return;
        // Load both roles before play. No session, encounter or provider request is created.
        _ = HarnessTools.ForVersion(HarnessTools.CurrentVersion);
        _ = HarnessDmChecklist.InstructionsFor(HarnessTools.CurrentVersion, combatAgent: true);
        try { await runtime.Prepare(cancellationToken); }
        catch (Exception error) when (!cancellationToken.IsCancellationRequested)
        {
            // Execute owns normal startup/recovery and reports failure if still unavailable.
            logger.LogWarning("Local AI runtime preparation failed ({ErrorType}); the next action will retry local startup.", error.GetType().Name);
        }
    }
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        Task[] pending;
        await scheduling.WaitAsync(cancellationToken);
        try { stopping = true; foreach (var run in active.Values) run.Cancellation.Cancel(); pending = active.Values.Select(r => r.Task).ToArray(); }
        finally { scheduling.Release(); }
        await Task.WhenAll(pending).WaitAsync(cancellationToken);
    }
    public void Dispose() => scheduling.Dispose();
}
