using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<AdvancementView> Advancement(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => Task.FromResult(AdvancementOpportunities.View(c)), ct);

    public Task<AdvancementView> PreviewAdvancement(string id, string token, PreviewAdvancementRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "状态已更新，请重新预览成长选择。", 409);
            CharacterReviews.RequireApproved(c);
            GameLifecycle.RequireAction(c);
            if (request.Draft is null) throw new GameException("invalid_advancement", "缺少成长草稿。");
            return Task.FromResult(AdvancementOpportunities.View(c, request.Draft));
        }, ct);

    public Task<ActionResponse> AwardAdvancement(string id, string token, AwardAdvancementRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "growth.award", request,
            c => AdvancementOpportunities.Award(c, request), ct);

    public Task<ActionResponse> ApplyAdvancement(string id, string token, ApplyAdvancementRequest request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        if (request.ExpectedVersion < 1 || request.Draft is null) throw new GameException("invalid_advancement", "缺少成长草稿或版本。");
        return store.Access(id, token, true, c =>
        {
            string fingerprint = JsonFiles.Hash("growth.apply:" + JsonSerializer.Serialize(request, JsonFiles.Options));
            var receipt = store.FindReceipt(c, request.RequestId);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "请求 ID 已用于另一份请求。", 409);
                return Task.FromResult(new ActionResponse(Snapshot(c), receipt.Resolution, true));
            }
            if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "状态已更新，请重新预览成长选择。", 409);
            RequireActive(c);
            CharacterReviews.RequireApproved(c);
            GameLifecycle.RequireAction(c);
            ContextualRolls.RequireNoPending(c);
            var view = AdvancementOpportunities.View(c, request.Draft);
            if (!view.Available) throw new GameException("advancement_unavailable", view.Reason, 409);
            var preview = view.Preview!;
            if (!preview.CanApply) throw new GameException("advancement_incomplete", preview.Issues.FirstOrDefault()?.Message ?? "成长选择尚未完成。");
            var before = ActivityRecords.Capture(c);
            c.ActingCharacter = preview.Character!;
            c.ActingPendingAbilityCheck = null;
            CharacterEngine.Sync(c);
            var ch = c.ActingCharacter;
            var resolution = new Resolution("resolved", "growth.apply", ch.Name + " 完成成长：总等级 " + ch.Level + "，本次提升 "
                + request.Draft.ClassId + "。已保存子职业、法术及其他取得选择；保留伤势和已消耗资源。", null,
                ["level:" + ch.Level, "character:" + ch.Id]);
            c.Version++;
            var scene = Adventure.Current(c);
            var origin = new ActionOrigin("", "确认角色成长", resolution.Kind, request.Draft.ClassId, ch.Name, scene.Id, scene.Title,
                ActivityRecords.Changes(before, c), c.ElapsedSeconds, c.ElapsedSeconds);
            c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, resolution.Kind, resolution.Summary, "", "system", DateTimeOffset.UtcNow,
                resolution, c.ActingActorId, Origin: origin));
            c.Receipts.Add(new(request.RequestId, fingerprint, resolution, c.ActingActorId));
            return Task.FromResult(new ActionResponse(Snapshot(c), resolution, false));
        }, ct);
    }
}
