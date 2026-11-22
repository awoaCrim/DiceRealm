using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<ActionResponse> InputAction(string id, string token, ActionRequest request, CancellationToken ct)
    {
        Validate(request);
        if (request.Kind != "natural") throw new GameException("invalid_input", "主输入入口只接受自然语言。");
        return store.Access(id, token, true, async c =>
        {
            string fingerprint = JsonFiles.Hash("actions.input:" + JsonSerializer.Serialize(request, JsonFiles.Options));
            if (ReplayIntent(c, request.RequestId, fingerprint) is { } replay) return replay;
            RequireLegacyInput(c);
            if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "冒险状态已更新，请同步后重新表达这次行动。", 409);
            string text = request.Text.Trim();
            Resolution result;
            if (InputContinuation.Resubmission(text) is { } submission)
            {
                RequireActive(c);
                var review = c.PartyMembers.FirstOrDefault(m => m.Id == c.ActingActorId)?.Review;
                result = CharacterReviews.Resubmit(c, new(request.RequestId, c.Version, review?.Revision ?? 0, submission));
                c.Version++;
                c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, result.Kind, result.Summary, "", "system", DateTimeOffset.UtcNow, result, c.ActingActorId, ReviewActorId: c.ActingActorId));
            }
            else if (ContextualRolls.Current(c) is { } roll)
            {
                string decision = InputContinuation.Cancel(text) ? "cancel" : InputContinuation.Roll(text) ? "roll"
                    : throw new GameException("input_roll_confirmation_required", "当前正在等待投掷。请输入“投掷”或“取消”；其他文字不会触发掷骰。");
                result = await RespondToRollCore(c, new(request.RequestId, c.Version, roll.Id, decision));
            }
            else if (ActionUnderstanding.Current(c) is { } intent)
            {
                if (InputContinuation.Cancel(text)) result = await RespondToIntentCore(c, new(request.RequestId, c.Version, intent.Id, "cancel"));
                else if (InputContinuation.Refer(text)) result = await RespondToIntentCore(c, new(request.RequestId, c.Version, intent.Id, "ruling"));
                else
                {
                    string? option = InputContinuation.Choose(intent, text);
                    result = await RespondToIntentCore(c, option is not null
                        ? new(request.RequestId, c.Version, intent.Id, "choose", option)
                        : new(request.RequestId, c.Version, intent.Id, "clarify", Text: text), autoExecute: true);
                }
            }
            else
            {
                RequireIntentContext(c, request.ExpectedVersion);
                if (InputContinuation.Cancel(text) || InputContinuation.Roll(text) || InputContinuation.Confirm(text))
                    throw new GameException("input_context_required", "现在没有等待确认的行动或投掷，请直接说明你想做什么。");
                var fresh = new PendingIntent { Id = Guid.NewGuid().ToString(), ActorId = c.ActingActorId, Text = text,
                    RootSequence = c.Version + 1, NpcNamingVersion = NpcNames.Version, UseCurrentBoardMap = true };
                c.PendingIntents.Add(fresh);
                result = await InterpretIntent(c, fresh, root: true, autoExecute: true, request.RequestId);
            }
            c.Receipts.Add(new(request.RequestId, fingerprint, result, c.ActingActorId));
            return new ActionResponse(Snapshot(c), result, false);
        }, ct);
    }
}
