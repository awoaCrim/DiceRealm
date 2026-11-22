using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<ActionResponse> ReviewCharacter(string id, string token, ReviewCharacterRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "character.review", request,
            c => CharacterReviews.Review(c, request), ct, reviewActorId: request.ActorId);

    public async Task<ActionResponse> ResubmitCharacter(string id, string token, ResubmitCharacterRequest request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        if (request.ExpectedVersion < 1) throw new GameException("invalid_input", "需要 expectedVersion。");
        PortraitRegistration? portrait = null;
        var result = await store.Access(id, token, true, c =>
        {
            string fingerprint = JsonFiles.Hash("character.resubmit:" + JsonSerializer.Serialize(request, JsonFiles.Options));
            if (ReplayIntent(c, request.RequestId, fingerprint) is { } replay)
            {
                portrait = CapturePortraitRegistration(c);
                return Task.FromResult(replay);
            }
            if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "资料已更新，请刷新后重新提交。", 409);
            RequireActive(c);
            var resolution = CharacterReviews.Resubmit(c, request);
            portrait = CapturePortraitRegistration(c);
            c.Version++;
            c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, resolution.Kind, resolution.Summary, "", "system", DateTimeOffset.UtcNow, resolution, c.ActingActorId, ReviewActorId: c.ActingActorId));
            c.Receipts.Add(new(request.RequestId, fingerprint, resolution, c.ActingActorId));
            return Task.FromResult(new ActionResponse(Snapshot(c), resolution, false));
        }, ct);
        return result with { Snapshot = await FinishPortraitRegistration(result.Snapshot, portrait, token) };
    }
}
