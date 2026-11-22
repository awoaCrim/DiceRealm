namespace DiceRealm.Server.Domain;

// Capabilities never appear in a snapshot. The leader owns the original character;
// every additional seat owns a different character and private immediate-check window.
public sealed class PartyMember
{
    public required string Id { get; init; }
    public required string TokenHash { get; init; }
    public required Character Character { get; set; }
    public bool Revoked { get; set; }
    public CharacterReview? Review { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public RoomJoinReceipt? RoomJoin { get; set; }
    public PendingAbilityCheck? PendingAbilityCheck { get; set; }
}
public sealed class PartyInvite
{
    public required string Id { get; init; }
    public required string TokenHash { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }
    public bool Revoked { get; set; }
    public string UsedByActorId { get; set; } = "";
    public string JoinFingerprint { get; set; } = "";
}
public sealed record PartyMemberView(string Id, string Role, bool Revoked, Character Character, CharacterReview? Review = null);
public sealed record InviteView(string Id, DateTimeOffset ExpiresAt, bool Used, bool Revoked);
public sealed record PartyView(string SelfActorId, bool IsHost, PartyMemberView[] Members, InviteView[] Invitations, bool CanInvite);
public sealed record InviteRequest(string RequestId, int ExpectedVersion, string InviteToken);
public sealed record JoinCampaignRequest(string RequestId, string InviteToken, string AccessToken, string CharacterName, string TemplateId = CharacterEngine.Fighter, CharacterCreationChoices? Creation = null, CharacterBuild? Build = null);
public sealed record RevokeSeatRequest(string RequestId, int ExpectedVersion, string ActorId);
public sealed record RevokeInviteRequest(string RequestId, int ExpectedVersion, string InviteId);

public static class PartyEngine
{
    public const string HostId = "player";
    public static bool IsHost(Campaign c) => c.ActingActorId == HostId;
    public static bool HasCharacter(Campaign c, string? actorId = null) => (actorId ?? c.ActingActorId) != HostId || !c.HostOnlySeat;
    public static void RequireCharacter(Campaign c)
    {
        if (!HasCharacter(c)) throw new GameException("player_character_required", "这是主持连接，没有玩家角色。请在客户端使用邀请完整建卡加入。", 403);
    }
    public static void ValidateSeats(Campaign c)
    {
        if (c.HostOnlySeat ? c.Character is not null || c.HostReview is not null : c.Character is null)
            throw new GameException("invalid_save", "主持席位与角色记录不一致；原存档已保留。", 409);
    }
    public static void RequireHost(Campaign c)
    {
        if (!IsHost(c)) throw new GameException("forbidden", "此操作需要队长 / DM 权限。", 403);
    }
    public static IEnumerable<(string Id, Character Character)> Characters(Campaign c, bool includeRevoked = false)
    {
        if (c.Character is { } host) yield return (HostId, host);
        foreach (var seat in c.PartyMembers.Where(m => includeRevoked || !m.Revoked && CharacterReviews.Approved(m.Review))) yield return (seat.Id, seat.Character);
    }
    public static Character CharacterFor(Campaign c, string actorId) => actorId == HostId
        ? c.Character ?? throw new GameException("player_character_required", "主持席位没有玩家角色；请在客户端使用邀请加入。", 403)
        : c.PartyMembers.Single(m => m.Id == actorId).Character;
    public static void SetCharacter(Campaign c, string actorId, Character character)
    {
        if (actorId == HostId)
        {
            if (c.HostOnlySeat) throw new GameException("player_character_required", "不能向主持席位写入玩家角色。", 403);
            c.Character = character;
        }
        else c.PartyMembers.Single(m => m.Id == actorId).Character = character;
    }
    // Initial assembly cannot depend on a player travelling before any player is approved.
    // A friend may join wherever the party is, outside a fight and while nobody is down; the
    // arrival line introduces them in the current scene (contract 58). Joining used to wait for an
    // authored safe-rest scene, which locked a late player out until the party walked back.
    public static bool CanAdmitCharacter(Campaign c) => !CombatEngine.InCombat(c) && Ready(c);
    public static bool CanInvite(Campaign c) => !c.Archived && IsHost(c) && CanAdmitCharacter(c)
        && c.PartyMembers.Count < (c.HostOnlySeat ? 4 : 3);
    public static bool Ready(Campaign c) => Characters(c).Where(p => !GameLifecycle.Dead(c, p.Id)).All(p => !p.Character.Conditions.Any(s => s is "Unconscious" or "Prone"));
    public static bool Allowed(Campaign c, ActionChoice a)
    {
        if (!GameLifecycle.CanAct(c) || !CharacterReviews.CanAct(c) || PartyRest.IsInitiation(a.Kind)) return false;
        // Daily world actions belong to every approved player; management still requires host.
        return a.Kind is not ("travel" or "combat.start") || Ready(c);
    }
    public static CombatUnit? Unit(Campaign c, string? actorId = null) => c.Combat?.Units.FirstOrDefault(u => u.Id == (actorId ?? c.ActingActorId));
    public static bool NeedsRecovery(Campaign c) => Unit(c)?.RecoveryRestRequired == true || (IsHost(c) && c.Combat?.RecoveryRestRequired == true);
    public static string DroppedWeapon(Campaign c) => Unit(c) is { } unit ? unit.DroppedWeaponId : IsHost(c) ? c.Combat?.DroppedWeaponId ?? "" : "";
    public static void FinishRecovery(Campaign c)
    {
        if (Unit(c) is { } unit) unit.RecoveryRestRequired = false;
        if (IsHost(c) && c.Combat is not null) c.Combat.RecoveryRestRequired = false;
    }
    private static PartyMemberView MemberView(Campaign c, string actor, string role, bool revoked, Character character, CharacterReview? review)
    {
        character = WearableEquipment.Project(c, character);
        bool mayReview = IsHost(c) || c.ActingActorId == actor;
        // Existing shared sheets stay readable; personal creation prose and review correspondence
        // are available only to their owner and the approving DM for new reviewed characters.
        return new(actor, role, revoked, mayReview || review is null ? character : character with { Build = null },
            mayReview ? CharacterReviews.View(review) : CharacterReviews.View(review) with { Submission = "", Reason = "" });
    }
    public static PartyView Snapshot(Campaign c) => new(c.ActingActorId, IsHost(c),
        (c.Character is { } host ? new[] { MemberView(c, HostId, "host", false, host, c.HostReview) } : Array.Empty<PartyMemberView>())
            .Concat(c.PartyMembers.Select(m => MemberView(c, m.Id, "player", m.Revoked, m.Character, m.Review))).ToArray(),
        IsHost(c) ? c.Invitations.Select(i => new InviteView(i.Id, i.ExpiresAt, i.UsedByActorId.Length > 0, i.Revoked)).ToArray() : [], CanInvite(c));
}
