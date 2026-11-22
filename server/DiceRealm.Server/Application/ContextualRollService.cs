using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<ActionResponse> RespondToRuling(string id, string token, ResolveRulingRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "ruling.respond", request,
            c => ResolveBoardRuling(c, request, requestRoll: true), ct);

    public Task<ActionResponse> RespondToRoll(string id, string token, RollResponseRequest request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        if (request.ExpectedVersion < 1 || !Guid.TryParseExact(request.RollId, "D", out _) || request.Decision is not ("roll" or "cancel"))
            throw new GameException("invalid_roll_response", "需要投掷请求编号、当前版本及 roll/cancel。 ");
        return store.Access(id, token, true, async c =>
        {
            string fingerprint = JsonFiles.Hash("rolls.respond:" + JsonSerializer.Serialize(request, JsonFiles.Options));
            var receipt = store.FindReceipt(c, request.RequestId);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "请求 ID 已用于另一份请求。", 409);
                return new ActionResponse(Snapshot(c), ActionUnderstanding.ForViewer(c, receipt.Resolution), true);
            }
            var result = await RespondToRollCore(c, request);
            c.Receipts.Add(new(request.RequestId, fingerprint, result, c.ActingActorId));
            return new ActionResponse(Snapshot(c), ActionUnderstanding.ForViewer(c, result), false);
        }, ct);
    }

    private async Task<Resolution> RespondToRollCore(Campaign c, RollResponseRequest request)
    {
        if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "状态已更新，请同步后查看待投掷请求。", 409);
        var roll = c.PendingRolls.FirstOrDefault(r => r.Id == request.RollId && r.ActorId == c.ActingActorId && r.Status == "pending")
            ?? throw new GameException("roll_unavailable", "该投掷不属于当前席位，或已处理。", 409);
        string linkedIntentId = roll.GroupId == "" ? roll.IntentId : c.PendingRolls.FirstOrDefault(r => r.Id == roll.GroupId)?.IntentId ?? "";
        Resolution result;
        if (request.Decision == "cancel")
        {
            foreach (var member in c.PendingRolls.Where(r => r.Id == roll.Id || roll.GroupId != "" && r.GroupId == roll.GroupId))
                member.Status = "cancelled";
            if (roll.Ruling is { } cancelled)
            {
                int index = c.PendingRulings.FindIndex(r => r.Id == cancelled.RulingId && r.Status == "awaiting_roll");
                if (index >= 0) c.PendingRulings[index] = c.PendingRulings[index] with { Status = "pending", Outcome = "", ResolvedBy = "", ResolvedAt = null, PrivateText = "" };
            }
            result = new("cancelled", "roll.cancel", "已放弃本次投掷。未产生骰点、消耗或成功/失败结果。", null, [], roll.Ruling?.RulingId ?? "", RollId: roll.GroupId == "" ? roll.Id : roll.GroupId, IntentId: linkedIntentId);
            foreach (var member in c.PendingRolls.Where(r => r.Id == roll.Id || roll.GroupId != "" && r.GroupId == roll.GroupId)) member.Result = result with { RollId = member.Id };
            c.Version++;
            AddRollEvent(c, result);
            ActionUnderstanding.Complete(c, result);
        }
        else
        {
            RequireActive(c);
            CharacterReviews.RequireApproved(c);
            GameLifecycle.RequireAction(c);
            if (c.Version != roll.Version) throw new GameException("roll_context_changed", "投掷上下文已变化，请放弃旧请求并重新选择。", 409);
            if (roll.GroupId != "")
            {
                if (roll.Confirmed) throw new GameException("roll_already_confirmed", "你已确认此遭遇，正在等待其他队员。", 409);
                roll.Confirmed = true;
                var group = c.PendingRolls.Where(r => r.GroupId == roll.GroupId && r.Status == "pending").ToArray();
                if (group.Any(r => !r.Confirmed))
                {
                    result = new("awaiting_roll", "roll.ready", "已确认，等待其他队员。尚未掷先攻或开始战斗。", null, [], RollId: roll.Id);
                    c.Version++;
                    foreach (var member in group) member.Version = c.Version;
                    AddRollEvent(c, result);
                }
                else
                {
                    var leader = group.Single(r => r.Id == roll.GroupId);
                    string actor = c.ActingActorId;
                    try
                    {
                        c.ActingActorId = leader.ActorId;
                        if (!Adventure.Choices(c).Any(a => a.Kind == leader.Intent!.Kind && a.Target == leader.Intent.Target))
                            throw new GameException("roll_context_changed", "原遭遇已不可用，请放弃后重新选择。", 409);
                        result = await ExecuteAction(c, leader.Action!, leader.Intent, true, leader.PromptCalls.ToList(), leader.Id, leader.IntentId,
                            namingVersion: leader.NpcNamingVersion, useCurrentBoardMap: leader.UseCurrentBoardMap);
                    }
                    finally { c.ActingActorId = actor; }
                    foreach (var member in group) { member.Status = "resolved"; member.Result = result; }
                }
            }
            else if (roll.SceneCheck is not null)
            {
                result = CompleteSceneCheck(c, roll);
                c.Version++;
                AddRollEvent(c, result);
                roll.Result = result;
                ActionUnderstanding.Complete(c, result);
            }
            else if (roll.Ruling is not null)
            {
                // The DM already authorized the immutable specification. The original actor alone
                // consents to execute it; attribution still names the DM, not a forged player role.
                result = rulings.CompleteRoll(c, roll) with { RollId = roll.Id };
                c.Version++;
                AddRollEvent(c, result);
                roll.Result = result;
            }
            else
            {
                var intent = roll.Intent ?? throw new InvalidOperationException("Missing roll intent.");
                if (!Adventure.Choices(c).Any(a => a.Kind == intent.Kind && a.Target == intent.Target))
                    throw new GameException("roll_context_changed", "原行动已不可用，请放弃后重新选择。", 409);
                bool systemAction = CombatEngine.Kinds.Contains(intent.Kind) || CharacterEngine.Kinds.Contains(intent.Kind) || GrowthEngine.Kinds.Contains(intent.Kind);
                result = await ExecuteAction(c, roll.Action!, intent, systemAction, roll.PromptCalls.ToList(), roll.Id, roll.IntentId,
                    namingVersion: roll.NpcNamingVersion, useCurrentBoardMap: roll.UseCurrentBoardMap);
            }
            if (roll.GroupId == "") roll.Status = "resolved";
        }
        return result;
    }

    private async Task<PendingRoll?> PrepareAutomaticDeathSave(Campaign c, string completedRollId = "", string intentId = "")
    {
        if (c.Combat is not { Status: "active", Standard.Wait: { Kind: "death" } wait } ||
            StandardCombatEngine.NarrationPending(c) ||
            c.PendingRolls.Any(r => r.ActorId == wait.ActorId && r.Status == "pending" && r.Id != completedRollId)) return null;
        string requestId = new Guid(Convert.FromHexString(JsonFiles.Hash("death-save:" + c.Combat.Id + ":" + c.Combat.Standard.TurnSerial + ":" + wait.ActorId))[..16]).ToString();
        if (c.PendingRolls.Any(r => r.ActorId == wait.ActorId && r.Intent?.Kind == "combat.death_save" && r.Action?.RequestId == requestId)) return null;
        string actor = c.ActingActorId;
        try
        {
            c.ActingActorId = wait.ActorId;
            var request = new ActionRequest(requestId, c.Version, "combat.death_save");
            var result = await PrepareAction(c, request, new("combat.death_save", ""), true, true, [],
                intentId: wait.ActorId == actor ? intentId : "");
            return c.PendingRolls.Single(r => r.Id == result.RollId);
        }
        finally { c.ActingActorId = actor; }
    }

    private static void AddRollEvent(Campaign c, Resolution result) => c.Events.Add(new(Guid.NewGuid().ToString(), c.Version,
        result.Kind, result.Summary, "", "system", DateTimeOffset.UtcNow, result, c.ActingActorId));
}
