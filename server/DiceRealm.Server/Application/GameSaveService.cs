using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    internal Task<GameSaveList> ListGameSaves(string id, string token, bool busy, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            var index = store.GameSaves.Read(c.Id);
            return Task.FromResult(new GameSaveList(index.Entries.Select(s => s.View).OrderByDescending(s => s.CreatedAt)
                .ThenBy(s => s.Id, StringComparer.Ordinal).ToArray(), !busy,
                busy ? "正在结算行动，请在完成或进入等待确认后保存。" : ""));
        }, ct);

    internal Task<GameSaveResponse> SaveGame(string id, string token, SaveGameRequest request, bool busy, HarnessRunStore runs, CancellationToken ct)
    {
        ValidateSaveRequest(request.RequestId, request.ExpectedVersion);
        request = request with { RequestId = Guid.Parse(request.RequestId).ToString() };
        string name = Text(request.Name, 80, "name");
        if (request.SaveId is null ? request.ExpectedSaveRevision is not null : request.ExpectedSaveRevision is not > 0)
            throw new GameException("invalid_game_save", "覆盖档位时需要当前存档修订；新建存档不携带档位修订。");
        string? slotId = request.SaveId is null ? null : SaveId(request.SaveId);
        request = request with { SaveId = slotId };
        string fingerprint = SaveFingerprint("save", request);
        return store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            var catalog = store.GameSaves; var index = catalog.Read(c.Id);
            if (ReplaySave(c, index, request.RequestId, fingerprint) is { } replay) return Task.FromResult(replay);
            RequireSaveContext(c, request.ExpectedVersion, busy);
            var old = slotId is null ? null : GameSaveCatalog.RequireSlot(index, slotId, request.ExpectedSaveRevision!.Value);
            return Task.FromResult(mapCatalog.WithGameSaveLock(() =>
            {
                ValidateSaveSources(c, runs);
                string payload = catalog.Capture(c, store);
                var view = SaveView(c, slotId ?? Guid.NewGuid().ToString(), name, (old?.View.Revision ?? 0) + 1, "manual");
                if (old is not null) index.Entries.Remove(old);
                index.Entries.Add(new(view, payload));
                index.Receipts.Add(new(request.RequestId, fingerprint, view.Id));
                catalog.Commit(c.Id, index);
                return new GameSaveResponse(Snapshot(c), view.Id, false);
            }));
        }, ct);
    }

    internal Task<GameSaveResponse> DeleteGameSave(string id, string token, string saveId, DeleteGameSaveRequest request, CancellationToken ct)
    {
        ValidateSaveRequest(request.RequestId); saveId = SaveId(saveId);
        request = request with { RequestId = Guid.Parse(request.RequestId).ToString() };
        if (request.ExpectedSaveRevision < 1) throw new GameException("invalid_game_save", "需要当前存档修订。");
        string fingerprint = SaveFingerprint("delete:" + saveId, request);
        return store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            var catalog = store.GameSaves; var index = catalog.Read(c.Id);
            if (ReplaySave(c, index, request.RequestId, fingerprint) is { } replay) return Task.FromResult(replay);
            CampaignTimeline.RequireRequest(c);
            var slot = GameSaveCatalog.RequireSlot(index, saveId, request.ExpectedSaveRevision);
            index.Entries.Remove(slot); index.Receipts.Add(new(request.RequestId, fingerprint, saveId));
            // Removing the pointer and publishing the control receipt is one atomic write.
            // Old immutable payloads may still be needed by a recovery/control receipt.
            catalog.Commit(c.Id, index);
            return Task.FromResult(new GameSaveResponse(Snapshot(c), saveId, false));
        }, ct);
    }

    internal Task<GameSaveResponse> LoadGame(string id, string token, string saveId, LoadGameRequest request, bool busy, HarnessRunStore runs, CancellationToken ct)
    {
        ValidateSaveRequest(request.RequestId, request.ExpectedVersion); saveId = SaveId(saveId);
        request = request with { RequestId = Guid.Parse(request.RequestId).ToString() };
        if (request.ExpectedSaveRevision < 1) throw new GameException("invalid_game_save", "需要当前存档修订。");
        string fingerprint = SaveFingerprint("load:" + saveId, request);
        return ReplaceGame(id, token, request.RequestId, request.ExpectedVersion, fingerprint, saveId,
            request.ExpectedSaveRevision, busy, runs, restart: false, ct);
    }

    internal Task<GameSaveResponse> RestartGame(string id, string token, RestartGameRequest request, bool busy, HarnessRunStore runs, CancellationToken ct)
    {
        ValidateSaveRequest(request.RequestId, request.ExpectedVersion);
        request = request with { RequestId = Guid.Parse(request.RequestId).ToString() };
        return ReplaceGame(id, token, request.RequestId, request.ExpectedVersion, SaveFingerprint("restart", request),
            null, null, busy, runs, restart: true, ct);
    }

    private Task<GameSaveResponse> ReplaceGame(string id, string token, string requestId, int version, string fingerprint,
        string? saveId, int? revision, bool busy, HarnessRunStore runs, bool restart, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            var catalog = store.GameSaves; var index = catalog.Read(c.Id);
            if (ReplaySave(c, index, requestId, fingerprint) is { } replay) return Task.FromResult(replay);
            RequireSaveContext(c, version, busy);
            var source = restart ? null : GameSaveCatalog.RequireSlot(index, saveId!, revision!.Value);
            if (restart && !ContentRuntime.Ready(c)) throw new GameException("content_required", "请先启用当前采用的冒险，再整场重开。", 409);
            return Task.FromResult(mapCatalog.WithGameSaveLock(() =>
            {
                ValidateSaveSources(c, runs);
                // The complete current game is immutable before any replacement. It also
                // preserves cold receipts from the abandoned branch, not just recent events.
                string before = catalog.Capture(c, store);
                string after = catalog.Clone(c.Id, source?.PayloadId ?? before);
                string folder = catalog.Payload(c.Id, after), timeline = Guid.NewGuid().ToString();
                string database = Path.Combine(folder, "campaign.sqlite");
                if (restart)
                {
                    CampaignStore.WriteRestart(database, RestartCampaign(c, timeline));
                    string runFolder = Path.Combine(folder, "harness");
                    if (Directory.Exists(runFolder)) Directory.Delete(runFolder, recursive: true);
                }
                else CampaignStore.PrepareGameRestore(c, database, timeline);
                runs.PrepareGameRestore(c.Id, Path.Combine(folder, "harness"), timeline);
                mapCatalog.PrepareGameRestore(c.Id, Path.Combine(folder, "maps"));
                CampaignStore.InspectGame(database, c.Id, saved =>
                { workspaces.ValidateGameSave(saved, Path.Combine(folder, "workspace.sqlite")); return true; });
                GameSaveCatalog.Seal(c.Id, folder);
                var recovery = SaveView(c, Guid.NewGuid().ToString(), restart ? "整场重开前恢复点" : "读档前恢复点", 1, "recovery");
                index.Entries.Add(new(recovery, before));
                catalog.Commit(c.Id, index);
                catalog.Restore(c, before, after, index, new(requestId, fingerprint, saveId), () => runs.ReindexCampaign(c.Id));
                return CampaignStore.InspectGame(database, c.Id, saved =>
                {
                    saved.ActingActorId = c.ActingActorId;
                    return new GameSaveResponse(Snapshot(saved), saveId, false);
                });
            }));
        }, ct);

    private void ValidateSaveSources(Campaign c, HarnessRunStore runs)
    {
        if (c.Harness is not null) _ = workspaces.Get(c);
        runs.CaptureIssued(c.Id);
    }
    private GameSaveResponse? ReplaySave(Campaign c, GameSaveIndex index, string requestId, string fingerprint) =>
        GameSaveCatalog.Receipt(index, requestId, fingerprint) is { } receipt ? new(Snapshot(c), receipt.SaveId, true) : null;
    private static void RequireSaveContext(Campaign c, int version, bool busy)
    {
        CampaignTimeline.RequireRequest(c);
        if (busy) throw new GameException("game_save_busy", "正在结算行动，请在完成或进入等待确认后再保存、读档或重开。", 409);
        if (c.Version != version) throw new GameException("stale_version", "游戏进度已更新，请同步后重新操作存档。", 409);
    }
    private static void ValidateSaveRequest(string requestId, int? version = null)
    {
        RequestId(requestId);
        if (Guid.Parse(requestId) == Guid.Empty || version is < 1) throw new GameException("invalid_game_save", "需要合法的请求编号与当前游戏版本。");
    }
    private static string SaveId(string id)
    {
        if (!Guid.TryParseExact(id, "D", out var value) || value == Guid.Empty) throw new GameException("invalid_game_save", "存档编号必须是有效 UUID。");
        return value.ToString();
    }
    private static string SaveFingerprint(string operation, object request) => JsonFiles.Hash("game-control:" + operation + ":" + JsonSerializer.Serialize(request, request.GetType(), JsonFiles.Options));
    private static GameSaveView SaveView(Campaign c, string id, string name, int revision, string kind) =>
        new(id, name, revision, DateTimeOffset.UtcNow, Adventure.Current(c).Title, c.ElapsedSeconds, c.Version, kind,
            PartyEngine.Characters(c).Select(p => new GameSavePartyMember(p.Id, p.Character.Name, p.Character.Level, GameLifecycle.Dead(c, p.Id))).ToArray());

    private static Campaign RestartCampaign(Campaign current, string timeline)
    {
        var c = new Campaign
        {
            Id = current.Id, Name = current.Name, TokenHash = current.TokenHash, OwnerUserId = current.OwnerUserId,
            HostOnlySeat = current.HostOnlySeat, Character = current.Character is null ? null : CampaignStore.InitialCharacter(current.Character),
            HostReview = current.HostReview, Room = current.Room, Invitations = current.Invitations,
            PartyMembers = current.PartyMembers.Select(m => new PartyMember
            { Id = m.Id, TokenHash = m.TokenHash, Revoked = m.Revoked, RoomJoin = m.RoomJoin,
                Review = m.Review, Character = CampaignStore.InitialCharacter(m.Character) }).ToList(),
            Adventure = current.Adventure, Prompts = current.Prompts, Harness = current.Harness,
            PromptRevisions = current.PromptRevisions, HarnessWorkspaceInitialized = current.HarnessWorkspaceInitialized,
            TimelineId = timeline, OfflineTrial = current.OfflineTrial, TrialSourceId = current.TrialSourceId, TrialFingerprint = current.TrialFingerprint
        };
        Activate(c);
        var scene = Adventure.Current(c);
        c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, "arrival", scene.Arrival, "", "authored", DateTimeOffset.UtcNow, null));
        return c;
    }
}
