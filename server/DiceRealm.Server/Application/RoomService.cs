using System.Text.Json;
using System.Text;
using System.Security.Cryptography;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<RoomView> GetRoom(string id, string token, CancellationToken ct) => store.Access(id, token, false, c =>
    {
        PartyEngine.RequireHost(c);
        return Task.FromResult(new RoomView(c.Room?.Number ?? "", c.Room?.Enabled ?? false, c.Version));
    }, ct);

    public Task<ActionResponse> ConfigureRoom(string id, string token, ConfigureRoomRequest request, CancellationToken ct)
    {
        // Fingerprint only after authorization. Account sessions rotate, so use the
        // persistent account/campaign secret; legacy capabilities keep their old bytes.
        return HostCommand(id, token, request.RequestId, request.ExpectedVersion, "party.room", request, c =>
        {
            if (request.Enabled)
            {
                RequireActive(c);
                RoomCredentials.ValidatePassword(request.Password);
                c.Room = RoomCredentials.Create(store.ReserveRoom(c), request.Password);
            }
            else
            {
                if (request.Password != "") throw new GameException("invalid_input", "关闭加入时不应提交新密码。", 400);
                if (c.Room is { } room) c.Room = room with { Enabled = false };
            }
            return new("resolved", "party.room", request.Enabled ? "房间加入已开启，队员可使用房间号和共享密码加入。" : "已关闭新成员加入；已有席位不受影响。", null, []);
        }, ct, allowArchived: true, hostOnly: true, authorizedFingerprint: c =>
        {
            var fingerprintInput = new { request.RequestId, request.ExpectedVersion, request.Enabled,
                passwordProof = Convert.ToHexStringLower(HMACSHA256.HashData(c.AccountRoomFingerprintKey ?? Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(request.Password ?? ""))) };
            return JsonFiles.Hash("party.room:" + JsonSerializer.Serialize(fingerprintInput, JsonFiles.Options));
        });
    }

    public async Task<CreatedCampaign> JoinRoom(JoinRoomRequest request, CancellationToken ct)
    {
        // First-time connections cannot know the timeline; current room credentials remain authoritative.
        using var admission = CampaignTimeline.Bind(null, mutation: true, control: true);
        RequestId(request.RequestId); Capability(request.AccessToken);
        if (!RoomCredentials.ValidNumber(request.RoomNumber)) throw RoomCredentials.Denied();
        RoomCredentials.ValidatePassword(request.Password);
        request = request with { RequestId = Guid.Parse(request.RequestId).ToString() };
        PortraitRegistration? portrait = null;
        var joined = await store.AccessRoom(request, c =>
        {
            string fingerprint = JsonFiles.Hash(JsonSerializer.Serialize(request, JsonFiles.Options));
            var previous = c.PartyMembers.FirstOrDefault(m => m.RoomJoin?.RequestId == request.RequestId);
            if (previous is not null)
            {
                if (previous.Revoked || !CampaignStore.Matches(request.AccessToken, previous.TokenHash)) throw RoomCredentials.Denied();
                if (previous.RoomJoin!.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "请求 ID 已用于另一份加入请求。", 409);
                c.ActingActorId = previous.Id;
                portrait = CapturePortraitRegistration(c);
                return Task.FromResult(new CreatedCampaign(request.AccessToken, Snapshot(c)));
            }
            RequireActive(c);
            if (c.PartyMembers.Count >= (c.HostOnlySeat ? 4 : 3))
                throw new GameException("party_unavailable", "这个房间的角色席位已满。", 409);
            if (!PartyEngine.CanAdmitCharacter(c))
                throw new GameException("party_unavailable", "队伍正在战斗或有人倒地，结束后再加入。", 409);
            string hash = JsonFiles.Hash(request.AccessToken);
            if (hash == c.TokenHash || c.PartyMembers.Any(m => m.TokenHash == hash) || c.Invitations.Any(i => i.TokenHash == hash))
                throw new GameException("duplicate_capability", "加入凭证必须独立生成。", 409);
            string name = Text(request.Build?.Identity?.Name ?? "", 40, "characterName");
            var character = CharacterEngine.CreateComplete(name, CharacterEngine.Fighter, null, request.Build);
            var member = new PartyMember
            {
                Id = Guid.NewGuid().ToString(), TokenHash = hash, Character = character, Review = new(1, "pending"),
                RoomJoin = new(request.RequestId, fingerprint)
            };
            c.PartyMembers.Add(member); c.ActingActorId = member.Id; c.Version++;
            portrait = CapturePortraitRegistration(c);
            var resolution = new Resolution("resolved", "party.join", name + " 已提交角色，等待 DM 审核后参与冒险。", null, ["member:" + member.Id]);
            c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, resolution.Kind, resolution.Summary, "", "system", DateTimeOffset.UtcNow, resolution, member.Id));
            return Task.FromResult(new CreatedCampaign(request.AccessToken, Snapshot(c)));
        }, ct);
        return joined with { Snapshot = await FinishPortraitRegistration(joined.Snapshot, portrait, request.AccessToken) };
    }
}
