using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    private sealed record PortraitRegistration(string CampaignId, string ActorId, Character Character, string? TimelineId);
    private static PortraitRegistration CapturePortraitRegistration(Campaign c) =>
        new(c.Id, c.ActingActorId, c.ActingCharacter, c.TimelineId);

    private static Character? PortraitCharacter(Campaign c, string actorId)
    {
        var member = actorId == PartyEngine.HostId ? null : c.PartyMembers.FirstOrDefault(m => m.Id == actorId && !m.Revoked);
        var character = actorId == PartyEngine.HostId ? c.Character : member?.Character;
        var review = actorId == PartyEngine.HostId ? c.HostReview : member?.Review;
        // Appearance prose is private creation data. Only its owner and approving DM may see
        // an unapproved portrait; peers see the public image once the character is approved.
        if (!PartyEngine.IsHost(c) && c.ActingActorId != actorId && !CharacterReviews.Approved(review)) return null;
        return character;
    }
    private static Character RequirePortraitCharacter(Campaign c, string actorId) => PortraitCharacter(c, actorId)
        ?? throw new GameException("character_unavailable", "该角色资料当前不可用。", 404);

    private CharacterPortraitView? PortraitFor(Campaign c, string actorId)
    {
        var character = PortraitCharacter(c, actorId);
        return character is null ? null : portraitCatalog.Get(c.Id, actorId, CharacterPortraits.Describe(character), c.OfflineTrial);
    }
    private Character ProjectPortrait(Campaign c, string actorId, Character projected) => projected with { Portrait = PortraitFor(c, actorId) };
    private PartyView ProjectPortraits(Campaign c, PartyView party) => party with
    {
        Members = party.Members.Select(m => m with { Character = ProjectPortrait(c, m.Id, m.Character) }).ToArray()
    };
    private BoardView ProjectPortraits(Campaign c, BoardView board) => board with
    {
        // SharedBoard has already filtered visibility. This enriches only those player tokens.
        Tokens = board.Tokens.Select(t => t with { Portrait = t.ActorId.Length == 0 ? null : PortraitFor(c, t.ActorId) }).ToArray()
    };
    private BoardTokenDetail ProjectPortrait(Campaign c, BoardTokenDetail detail) => detail with
    {
        Portrait = detail.ActorId.Length == 0 ? null : PortraitFor(c, detail.ActorId),
        Character = detail.Character is null ? null : ProjectPortrait(c, detail.ActorId, detail.Character)
    };

    private async Task<CampaignSnapshot> FinishPortraitRegistration(CampaignSnapshot snapshot, PortraitRegistration? registration, string token)
    {
        if (registration is null) return snapshot;
        CharacterPortraitView portrait;
        try
        {
            // Join/Resubmit committed before this best-effort registration. A restore may
            // have happened in between; authorize again under the campaign gate rather than
            // queueing a late image request for the abandoned timeline/character build.
            portrait = await store.Access(registration.CampaignId, token, false, c =>
            {
                CampaignTimeline.Require(c, registration.TimelineId);
                var current = RequirePortraitCharacter(c, registration.ActorId);
                var specification = CharacterPortraits.Describe(current);
                if (specification.Id != CharacterPortraits.Describe(registration.Character).Id)
                    return Task.FromResult(portraitCatalog.Get(c.Id, registration.ActorId, specification, c.OfflineTrial));
                return Task.FromResult(c.Archived
                    ? portraitCatalog.Get(c.Id, registration.ActorId, specification, c.OfflineTrial)
                    : portraitCatalog.Ensure(c.Id, registration.ActorId, specification, c.OfflineTrial));
            }, CancellationToken.None);
        }
        catch (Exception ex)
        {
            // The game transaction has ALREADY committed. Never report Join/Resubmit as failed
            // and invite duplicate creation. Original Join replay or explicit POST can recover.
            logger.LogError("Portrait registration failed ({ErrorType}), campaign {CampaignId}, actor {ActorId}",
                ex.GetType().Name, registration.CampaignId, registration.ActorId);
            portrait = new(snapshot.Character?.Portrait?.Id ?? "", "failed", "", "", 0, 0, "portrait_registration_failed");
        }
        return snapshot with
        {
            Character = snapshot.Character is null ? null : snapshot.Character with { Portrait = portrait },
            Party = snapshot.Party is null ? null : snapshot.Party with
            {
                Members = snapshot.Party.Members.Select(m => m.Id == registration.ActorId
                    ? m with { Character = m.Character with { Portrait = portrait } } : m).ToArray()
            }
        };
    }

    public Task<CharacterPortraitView> CharacterPortrait(string id, string token, string actorId, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            _ = RequirePortraitCharacter(c, actorId);
            return Task.FromResult(PortraitFor(c, actorId)!);
        }, ct);

    public Task<CharacterPortraitResponse> RequestPortrait(string id, string token, string actorId,
        RequestCharacterPortrait request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        if (Guid.Parse(request.RequestId) == Guid.Empty || !AssetCatalog.IsHash(request.ExpectedPortraitId) || request.RetryFailureId is null ||
            request.RetryFailureId.Length > 80 || request.RetryFailureId.Any(char.IsControl))
            throw new GameException("invalid_portrait_request", "需要当前头像身份；重试时携带当前 failureId。");
        return store.Access(id, token, false, c =>
        {
            var character = RequirePortraitCharacter(c, actorId);
            if (!PartyEngine.IsHost(c) && c.ActingActorId != actorId)
                throw new GameException("forbidden", "只能为本人角色请求头像；主持可以为本战役有效角色补图。", 403);
            return Task.FromResult(portraitCatalog.Request(c.Id, c.ActingActorId, actorId, CharacterPortraits.Describe(character), request,
                c.Archived, c.OfflineTrial));
        }, ct);
    }

    public Task<CharacterPortraitImage> PortraitImage(string id, string token, string actorId,
        string portraitId, string contentHash, CancellationToken ct) => store.Access(id, token, false, c =>
        {
            var character = RequirePortraitCharacter(c, actorId);
            return Task.FromResult(portraitCatalog.Image(c.Id, actorId, CharacterPortraits.Describe(character), portraitId, contentHash));
        }, ct);
}
