using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    // Clients generate and durably retain these high-entropy capabilities before sending.
    // Only hashes are persisted, so response loss never requires storing plaintext tokens.
    public Task<ActionResponse> Invite(string id, string token, InviteRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "party.invite", request, c =>
        {
            Capability(request.InviteToken);
            if (!PartyEngine.CanInvite(c)) throw new GameException("party_unavailable", "战斗中或有队员倒地时不能邀请；最多四个角色席位。", 409);
            if (c.Invitations.Count >= 64) throw new GameException("invite_capacity", "本战役最多登记 64 份邀请。", 409);
            string hash = JsonFiles.Hash(request.InviteToken);
            if (hash == c.TokenHash || c.PartyMembers.Any(m => m.TokenHash == hash) || c.Invitations.Any(i => i.TokenHash == hash))
                throw new GameException("duplicate_capability", "请生成不同的邀请凭证。", 409);
            c.Invitations.Add(new() { Id = request.RequestId, TokenHash = hash, ExpiresAt = DateTimeOffset.UtcNow.AddHours(24) });
            return new("resolved", "party.invite", "已登记一份 24 小时有效、仅可使用一次的邀请。请私下传递邀请凭证，不要公开队长凭证。", null, ["invitation:" + request.RequestId]);
        }, ct);

    public async Task<CreatedCampaign> Join(string id, JoinCampaignRequest request, CancellationToken ct)
    {
        // Admission has no prior snapshot; current invitation and seat checks still run under the campaign gate.
        using var admission = CampaignTimeline.Bind(null, mutation: true, control: true);
        RequestId(request.RequestId); Capability(request.InviteToken); Capability(request.AccessToken);
        var name = Text(request.CharacterName, 40, "characterName");
        PortraitRegistration? portrait = null;
        var joined = await store.AccessInvitation(id, request.InviteToken, c =>
        {
            var invite = c.Invitations.Single(i => CampaignStore.Matches(request.InviteToken, i.TokenHash));
            var fingerprint = JsonFiles.Hash(JsonSerializer.Serialize(request, JsonFiles.Options));
            if (invite.Revoked) throw new GameException("unauthorized", "邀请已撤销。", 401);
            if (invite.UsedByActorId.Length > 0)
            {
                var seat = c.PartyMembers.Single(m => m.Id == invite.UsedByActorId);
                if (seat.Revoked || invite.JoinFingerprint != fingerprint || !CampaignStore.Matches(request.AccessToken, seat.TokenHash))
                    throw new GameException("invite_used", "邀请已经使用；无法再次加入。", 409);
                c.ActingActorId = seat.Id;
                portrait = CapturePortraitRegistration(c);
                return Task.FromResult(new CreatedCampaign(request.AccessToken, Snapshot(c)));
            }
            RequireActive(c);
            if (invite.ExpiresAt <= DateTimeOffset.UtcNow) throw new GameException("invite_expired", "邀请已过期。", 409);
            if (!PartyEngine.CanInvite(c)) throw new GameException("party_unavailable", "队伍正在战斗或有人倒地，结束后再加入。", 409);
            var hash = JsonFiles.Hash(request.AccessToken);
            if (hash == c.TokenHash || c.PartyMembers.Any(m => m.TokenHash == hash) || c.Invitations.Any(i => i.TokenHash == hash))
                throw new GameException("duplicate_capability", "加入凭证必须独立生成。", 409);
            var member = new PartyMember { Id = Guid.NewGuid().ToString(), TokenHash = hash, Character = CharacterEngine.CreateComplete(name, request.TemplateId, request.Creation, request.Build), Review = new(1, "pending") };
            c.PartyMembers.Add(member); invite.UsedByActorId = member.Id; invite.JoinFingerprint = fingerprint;
            c.ActingActorId = member.Id; c.Version++;
            portrait = CapturePortraitRegistration(c);
            var resolution = new Resolution("resolved", "party.join", name + " 已提交角色，等待 DM 审核后参与冒险。" + (c.HostOnlySeat ? "物品后果归原行动的玩家角色。" : "剧情任务奖励仍由队长保管。"), null, ["member:" + member.Id]);
            c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, resolution.Kind, resolution.Summary, "", "system", DateTimeOffset.UtcNow, resolution, member.Id));
            return Task.FromResult(new CreatedCampaign(request.AccessToken, Snapshot(c)));
        }, ct);
        return joined with { Snapshot = await FinishPortraitRegistration(joined.Snapshot, portrait, request.AccessToken) };
    }

    public Task<ActionResponse> RevokeSeat(string id, string token, RevokeSeatRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "party.revoke", request, c =>
        {
            if (CombatEngine.InCombat(c)) throw new GameException("party_unavailable", "请先结束战斗再撤销席位；队长不能替其他成员消耗回合。", 409);
            var seat = c.PartyMembers.FirstOrDefault(m => m.Id == request.ActorId && !m.Revoked)
                ?? throw new GameException("invalid_seat", "无法撤销此席位。", 409);
            seat.Revoked = true;
            return new("resolved", "party.revoke", "已撤销 " + seat.Character.Name + " 的访问权限。角色和审计记录保留，不能靠重复加入生成额外物品。", null, ["revoked:" + seat.Id]);
        }, ct, allowArchived: true);

    public Task<ActionResponse> RevokeInvite(string id, string token, RevokeInviteRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "party.revoke_invite", request, c =>
        {
            var invite = c.Invitations.FirstOrDefault(i => i.Id == request.InviteId && !i.Revoked && i.UsedByActorId.Length == 0)
                ?? throw new GameException("invalid_invite", "邀请不可撤销；已加入成员请撤销其席位。", 409);
            invite.Revoked = true;
            return new("resolved", "party.revoke_invite", "未使用的邀请已撤销。", null, ["invitation-revoked:" + invite.Id]);
        }, ct, allowArchived: true);

    public Task<ActionResponse> ResolveRuling(string id, string token, ResolveRulingRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "ruling.resolve", request, c => ResolveBoardRuling(c, request), ct);

    private Task<ActionResponse> HostCommand<T>(string id, string token, string requestId, int version, string kind, T request,
        Func<Campaign, Resolution> execute, CancellationToken ct, bool allowArchived = false, string reviewActorId = "", bool hostOnly = false,
        Func<Campaign, string>? authorizedFingerprint = null)
    {
        RequestId(requestId);
        if (version < 1) throw new GameException("invalid_input", "需要 expectedVersion。", 400);
        return store.Access(id, token, true, c =>
        {
            PartyEngine.RequireHost(c);
            string fingerprint = authorizedFingerprint?.Invoke(c) ?? JsonFiles.Hash(kind + ":" + JsonSerializer.Serialize(request, JsonFiles.Options));
            var receipt = store.FindReceipt(c, requestId);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "请求 ID 已用于另一份请求。", 409);
                return Task.FromResult(new ActionResponse(Snapshot(c), receipt.Resolution, true));
            }
            if (c.Version != version) throw new GameException("stale_version", "状态已更新，请刷新后重新选择。", 409);
            if (!allowArchived) RequireActive(c);
            var resolution = execute(c);
            c.Version++;
            c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, resolution.Kind, resolution.Summary, "", "system", DateTimeOffset.UtcNow, resolution, c.ActingActorId, ReviewActorId: reviewActorId, HostOnly: hostOnly));
            c.Receipts.Add(new(requestId, fingerprint, resolution, c.ActingActorId));
            return Task.FromResult(new ActionResponse(Snapshot(c), resolution, false));
        }, ct);
    }
    private static void RequestId(string value)
    {
        if (!Guid.TryParseExact(value, "D", out _)) throw new GameException("invalid_input", "需要合法的 requestId。", 400);
    }
    private static void Capability(string value)
    {
        if (value is null || value.Length != 64 || value.Any(c => !char.IsAsciiHexDigit(c)))
            throw new GameException("invalid_capability", "需要独立随机生成的 32 字节十六进制凭证。", 400);
    }
}
