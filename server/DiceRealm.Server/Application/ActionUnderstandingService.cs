using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<ActionResponse> InterpretAction(string id, string token, ActionRequest request, CancellationToken ct)
    {
        Validate(request);
        if (request.Kind != "natural") throw new GameException("invalid_input", "此入口只理解自然语言行动。");
        return store.Access(id, token, true, async c =>
        {
            string fingerprint = JsonFiles.Hash("actions.interpret:" + JsonSerializer.Serialize(request, JsonFiles.Options));
            if (ReplayIntent(c, request.RequestId, fingerprint) is { } replay) return replay;
            RequireLegacyInput(c);
            RequireIntentContext(c, request.ExpectedVersion);
            if (ActionUnderstanding.Current(c) is not null)
                throw new GameException("intent_pending", "请先继续或放弃上一次待澄清的意图。", 409);
            var intent = new PendingIntent { Id = Guid.NewGuid().ToString(), ActorId = c.ActingActorId,
                Text = request.Text.Trim(), RootSequence = c.Version + 1, NpcNamingVersion = NpcNames.Version, UseCurrentBoardMap = true };
            c.PendingIntents.Add(intent);
            var result = await InterpretIntent(c, intent, root: true);
            c.Receipts.Add(new(request.RequestId, fingerprint, result, c.ActingActorId));
            return new ActionResponse(Snapshot(c), ActionUnderstanding.ForViewer(c, result), false);
        }, ct);
    }

    public Task<ActionResponse> RespondToIntent(string id, string token, IntentResponseRequest request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        if (request.ExpectedVersion < 1 || !Guid.TryParseExact(request.IntentId, "D", out _) ||
            request.Decision is not ("choose" or "clarify" or "ruling" or "cancel") || request.OptionId is null ||
            request.Text is null || request.OptionId.Length > 64 || request.Text.Length > 1000 ||
            request.OptionId.Any(char.IsControl) || request.Text.Any(char.IsControl) ||
            (request.Decision == "choose" ? request.OptionId.Length == 0 : request.OptionId.Length != 0) ||
            (request.Decision == "clarify" ? string.IsNullOrWhiteSpace(request.Text) : request.Text.Length != 0))
            throw new GameException("invalid_intent_response", "请选择所列行动、补充说明、转交裁定或放弃，不接受额外执行参数。");
        return store.Access(id, token, true, async c =>
        {
            string fingerprint = JsonFiles.Hash("intents.respond:" + JsonSerializer.Serialize(request, JsonFiles.Options));
            if (ReplayIntent(c, request.RequestId, fingerprint) is { } replay) return replay;
            var result = await RespondToIntentCore(c, request);
            c.Receipts.Add(new(request.RequestId, fingerprint, result, c.ActingActorId));
            return new ActionResponse(Snapshot(c), ActionUnderstanding.ForViewer(c, result), false);
        }, ct);
    }

    private async Task<Resolution> RespondToIntentCore(Campaign c, IntentResponseRequest request, bool autoExecute = false)
    {
        if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "状态已更新，请同步当前意图。", 409);
        var intent = ActionUnderstanding.Current(c);
        if (intent is null || intent.Id != request.IntentId)
            throw new GameException("intent_unavailable", "该意图不属于当前席位，或已处理。", 409);
        Resolution result;
        if (request.Decision == "cancel")
        {
            result = new("cancelled", "intent.cancel", "已放弃这次意图。未执行行动、掷骰或消耗资源。", null, [], IntentId: intent.Id);
            RecordIntent(c, intent, result, "intent.cancel");
            ActionUnderstanding.Complete(c, result);
        }
        else
        {
            RequireIntentContext(c, request.ExpectedVersion);
            if (intent.Version != c.Version)
                throw new GameException("intent_context_changed", "意图依据的状态已变化，请放弃后重新描述。", 409);
            if (request.Decision == "clarify")
            {
                RequireLegacyInput(c);
                intent.Clarifications.Add(new(intent.Question, request.Text.Trim()));
                result = intent.Clarifications.Count >= ActionUnderstanding.MaximumClarifications
                    ? ReferIntent(c, intent, "已保留原意图与补充说明；仍需主持明确目标、条件或处理方式。", false)
                    : await InterpretIntent(c, intent, root: false, autoExecute, request.RequestId);
            }
            else if (request.Decision == "ruling")
                result = ReferIntent(c, intent, "已将原意图与补充说明交给主持判断。尚未执行或扣除资源。", false);
            else
            {
                result = await ExecuteIntentOption(c, intent, request.OptionId, request.RequestId);
            }
        }
        return result;
    }

    private async Task<Resolution> ExecuteIntentOption(Campaign c, PendingIntent intent, string optionId, string requestId)
    {
        var option = intent.Options.FirstOrDefault(o => o.Id == optionId)
            ?? throw new GameException("intent_option_unavailable", "只能选择当前意图提供的行动。", 409);
        if (option.BoardCommand is { } board) return ExecuteConfirmedBoard(c, intent, board, requestId);
        if (option.WorldRoute is { } route)
        {
            var result = WorldRoutes.Apply(c, route, intent.Id);
            RecordIntent(c, intent, result, "world.route");
            ActionUnderstanding.Complete(c, result, IntentOrigin(c, intent));
            return result;
        }
        if (option.Consequence is { } consequence)
        {
            var scene = Adventure.Current(c); var before = ActivityRecords.Capture(c); long time = c.ElapsedSeconds;
            var result = VerifiedStoryConsequences.Apply(c, consequence, intent.Id, requestId);
            intent.ResultOrigin = new(intent.Text, option.Label, "story.verified", consequence.ActionId, c.ActingCharacter.Name,
                scene.Id, scene.Title, ActivityRecords.Changes(before, c), time, c.ElapsedSeconds, intent.Clarifications.ToArray());
            RecordIntent(c, intent, result, "story.verified", origin: intent.ResultOrigin);
            ActionUnderstanding.Complete(c, result, intent.ResultOrigin);
            return result;
        }
        if (!ActionUnderstanding.Candidates(c, rootId: intent.Id, includeLoadout: option.Character?.Operation == "loadout", includeWearables: option.Character?.Operation is "wear" or "attunement").Any(option.SameCommand))
            throw new GameException("intent_option_unavailable", "该行动或来源现在不可用，请放弃后重新选择。", 409);
        if (option.Action is { } action)
        {
            var command = new ActionRequest(requestId, c.Version, "natural", Text: intent.Text);
            return await PrepareAction(c, command, action, true, CombatEngine.Restricted(c), intent.PromptCalls.ToList(), intent.Id,
                namingVersion: intent.NpcNamingVersion, useCurrentBoardMap: intent.UseCurrentBoardMap);
        }
        if (option.Character is { } character)
            return ExecuteCharacterAction(c, new(requestId, c.Version, character.Operation, character.Key, character.Value, Choices: character.ChoiceIds?.Split(',')), intent.Text, intent.Id, option.Label);
        throw new InvalidOperationException("Missing server-owned candidate command.");
    }

    private ActionResponse? ReplayIntent(Campaign c, string requestId, string fingerprint)
    {
        var receipt = store.FindReceipt(c, requestId);
        if (receipt is null) return null;
        if (receipt.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "请求 ID 已用于另一份请求。", 409);
        return new(Snapshot(c), ActionUnderstanding.ForViewer(c, receipt.Resolution), true);
    }
    private static void RequireIntentContext(Campaign c, int version)
    {
        if (c.Version != version) throw new GameException("stale_version", "状态已更新，请重新描述行动。", 409);
        RequireActive(c);
        CharacterReviews.RequireApproved(c);
        GameLifecycle.RequireAction(c);
        if (!ContentRuntime.Ready(c)) throw new GameException("content_required", "请先导入并启用剧本与提示词包。", 409);
        ContextualRolls.RequireNoPending(c);
    }
    private async Task<Resolution> InterpretIntent(Campaign c, PendingIntent intent, bool root, bool autoExecute = false, string requestId = "")
    {
        string related = intent.Text + " " + string.Join(" ", intent.Clarifications.Select(x => x.Answer));
        var candidates = IntentContexts.SelectCandidates(ActionUnderstanding.Candidates(c, rootId: intent.Id, includeRecording: false, includeWearables: autoExecute), related);
        var context = IntentContexts.Build(c, intent.Text, intent.Clarifications.ToArray(), candidates);
        IntentInterpretation decision;
        AdventureDecision? directed = null;
        WorldMemoryEntry[] memoryPlan = [];
        using var timeout = new CancellationTokenSource(textDeadline);
        try
        {
            IIntentInterpreter provider = c.OfflineTrial ? new OfflineText() : interpreter;
            if (autoExecute)
            {
                var adventureContext = AdventureDirecting.Build(c, context);
                directed = AdventureDirecting.Validate(await provider.Direct(adventureContext, timeout.Token, c.Id, c.Prompts).WaitAsync(timeout.Token), adventureContext);
                memoryPlan = WorldMemories.Plan(c, directed.Memory ?? [], adventureContext.KnownMemory.Select(m => m.Id).ToHashSet(),
                    adventureContext.KnownScenes.Select(s => s.Id).ToHashSet(), intent.RootSequence, directed.Source);
                decision = new(directed.Decision, directed.CandidateIds, directed.Question, directed.Source);
            }
            else decision = IntentContexts.Validate(await provider.Understand(context, timeout.Token, c.Id, c.Prompts).WaitAsync(timeout.Token), context);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Contextual action interpretation unavailable ({ErrorType})", ex.GetType().Name);
            directed = null;
            memoryPlan = [];
            decision = new("clarify", [], "暂时未能可靠处理这次行动。尚未执行或保存世界变化；你可以补充目标和做法，或输入“交给DM”。", "unavailable");
        }
        intent.Source = decision.Source;
        intent.PromptCalls = [..intent.PromptCalls, new(autoExecute ? "adventure.direct" : "intent.context", Binding(c.Prompts)!, decision.Source + ":" + decision.Decision)];
        if (directed?.Decision == "narrate") return CommitNarrative(c, intent, directed, memoryPlan, root);
        if (decision.Decision == "adjudicate")
            return ReferIntent(c, intent, decision.Source == "offline"
                ? "离线标签匹配未覆盖这次行动。已交给主持判断，尚未掷骰或消耗资源。"
                : "此意图没有可以直接确认的现有操作，已交给主持判断。尚未掷骰或消耗资源。", root);
        intent.Options = decision.CandidateIds.Select(id => candidates.Single(c => c.Id == id)).ToArray();
        intent.Question = decision.Decision == "action" ? "请核对目标、来源和成本，再确认你要采取的行动。" : decision.Question;
        var result = new Resolution(decision.Decision == "action" ? "awaiting_confirmation" : "awaiting_clarification",
            root ? "intent.request" : "intent.clarify", intent.Question, null, [], IntentId: intent.Id);
        RecordIntent(c, intent, result, root ? "intent.request" : "intent.clarify");
        if (autoExecute && decision.Decision == "action" && InputContinuation.CanExecuteDirectly(c, intent.Options[0]))
            return await ExecuteIntentOption(c, intent, intent.Options[0].Id, requestId);
        return result;
    }
    private Resolution ReferIntent(Campaign c, PendingIntent intent, string reason, bool root)
    {
        string text = intent.Text + string.Concat(intent.Clarifications.Select(x => "\n补充：" + x.Answer));
        var result = Adjudicate(c, text) with { Summary = ActionUnderstanding.RulingRequestSummary, IntentId = intent.Id };
        // The question is for the host, not the event/receipt's public waiting summary.
        int index = c.PendingRulings.FindIndex(r => r.Id == result.RulingId);
        c.PendingRulings[index] = c.PendingRulings[index] with { Reason = reason };
        RecordIntent(c, intent, result, root ? "intent.request" : "intent.ruling");
        ActionUnderstanding.Complete(c, result, IntentOrigin(c, intent));
        return result;
    }
    private static ActionOrigin IntentOrigin(Campaign c, PendingIntent intent)
    {
        var scene = Adventure.Current(c);
        return new(intent.Text, "自由行动", "natural", "", c.ActingCharacter.Name, scene.Id, scene.Title, [],
            c.ElapsedSeconds, c.ElapsedSeconds, intent.Clarifications.ToArray());
    }
    private static void RecordIntent(Campaign c, PendingIntent intent, Resolution result, string kind, string narrative = "", string source = "system", string privateText = "", PrivateStoryMessage[]? privateMessages = null, ActionOrigin? origin = null)
    {
        c.Version++;
        intent.Version = c.Version;
        intent.Result = result;
        if (c.Version == intent.RootSequence && privateMessages is not null && narrative.Length == 0)
            intent.PrivateRoot = true;
        // A private-root continuation owns its own audit. Reusing ResultOrigin would copy
        // the private event's changes/metadata along with its input into later public events.
        origin ??= intent.PrivateRoot ? IntentOrigin(c, intent) : intent.ResultOrigin ?? IntentOrigin(c, intent);
        intent.ResultOrigin = origin with { Clarifications = intent.Clarifications.ToArray() };
        ActivityRecords.Link(c, result);
        c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, kind, result.Summary, narrative, source, DateTimeOffset.UtcNow,
            result, c.ActingActorId, intent.PromptCalls, intent.ResultOrigin, PrivateText: privateText, PrivateMessages: privateMessages));
    }
}
