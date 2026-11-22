using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<BoardView> Board(string id, string token, string mapId, CancellationToken ct) =>
        store.Access(id, token, false, c => Task.FromResult(ProjectPortraits(c, SharedBoard.Project(c, BoardMap(c, mapId)))), ct);

    public Task<BoardTokenDetail> BoardToken(string id, string token, string entityId, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            var entity = SharedBoard.Find(c, entityId);
            // Validate an accessible placement, not whichever map happened to be edited last.
            // Detail contains no remembered positions or hidden-map identifiers.
            if ((entity.Placement is not null || entity.MapPlacements is { Count: > 0 }) &&
                !mapCatalog.List(c.Id, PartyEngine.IsHost(c), false).Maps.Any(m => SharedBoard.PlacementOn(entity, m.Id) is not null))
                throw new GameException("board_token_not_found", "未找到可访问的单位。", 404);
            return Task.FromResult(ProjectPortrait(c, SharedBoard.Detail(c, entityId)));
        }, ct);

    public Task<BoardCommandResponse> BoardCommand(string id, string token, BoardCommandRequest request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        if (request.ExpectedVersion < 1) throw new GameException("invalid_input", "需要 expectedVersion。");
        return store.Access(id, token, true, c =>
        {
            string fingerprint = JsonFiles.Hash("board:" + JsonSerializer.Serialize(request, JsonFiles.Options));
            var receipt = store.FindReceipt(c, request.RequestId);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint || receipt.BoardOutput is null)
                    throw new GameException("idempotency_conflict", "请求 ID 已用于另一份请求。", 409);
                return Task.FromResult(BoardResponse(c, request.MapId, receipt.BoardOutput, true));
            }
            if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "棋盘已更新，请刷新后重新选择。", 409);
            RequireActive(c);
            if (!PartyEngine.IsHost(c)) GameLifecycle.RequireAction(c);
            var map = BoardMap(c, request.MapId);
            // Browsing other maps is read-only for players; it must not teleport their token.
            if (!PartyEngine.IsHost(c) && !map.CurrentScene)
                throw new GameException("board_scene_mismatch", "查看其他地图不会移动角色；请先通过地点入口前往。", 409);
            if (c.Harness is not null && !PartyEngine.IsHost(c) && request.Operation == "spawn" &&
                request.Spawns?.Any(s => s?.Source?.Kind == "player" || s?.ExistingId is { Length: > 0 } entityId && SharedBoard.Find(c, entityId).ActorId.Length > 0) == true)
                throw new GameException("board_dm_placement_required", "角色初始站位由AI DM决定；已在图上的本人角色可正常移动。", 409);
            var (result, combatResolution) = ExecuteBoardCommand(c, map, request);
            c.Version++;
            var resolution = combatResolution ?? new Resolution(result.Status, "board." + request.Operation,
                result.Status == "pending" ? "已记录棋盘移动意图，实际位置未改变。" : "已保存棋盘位置或显示变更；未结算地形、伤害或资源。",
                null, [], result.RulingId);
            if (combatResolution is null && result.Status == "applied")
                c.StateOnlyVersions.Add(c.Version);
            else
            {
                // Pending and combat outcomes still drive exact consent/recovery.
                bool hostOnly = result.EntityIds.Any(entityId => !SharedBoard.CanView(c, SharedBoard.Find(c, entityId), true));
                c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, resolution.Kind, resolution.Summary, "", "system", DateTimeOffset.UtcNow,
                    resolution, c.ActingActorId, HostOnly: hostOnly));
            }
            c.Receipts.Add(new(request.RequestId, fingerprint, resolution, c.ActingActorId, BoardOutput: result));
            return Task.FromResult(BoardResponse(c, request.MapId, result, false));
        }, ct);
    }

    private Resolution ResolveBoardRuling(Campaign c, ResolveRulingRequest request, bool requestRoll = false)
    {
        if (request.Outcome == "board_move" && c.Board?.Moves.FirstOrDefault(m => m.RulingId == request.RulingId && m.Status == "pending") is { } move)
        {
            var map = BoardMap(c, move.Origin.MapId, publicOnly: true);
            if (!map.CurrentScene) throw new GameException("board_scene_mismatch", "原棋盘不属于当前场景，不能结算旧位置。", 409);
        }
        return rulings.Resolve(c, request, requestRoll);
    }

    private MapAssetView BoardMap(Campaign c, string mapId, bool publicOnly = false) =>
        mapCatalog.Get(c.Id, mapId, !publicOnly && PartyEngine.IsHost(c), c.SceneId, MapMarkers.Targets(c));

    private BoardCommandResponse BoardResponse(Campaign c, string mapId, BoardCommandResult result, bool replayed)
    {
        var board = ProjectPortraits(c, SharedBoard.Project(c, BoardMap(c, mapId)));
        var visible = board.Tokens.Select(t => t.Id).ToHashSet(StringComparer.Ordinal);
        var ids = result.EntityIds.Where(visible.Contains).ToArray();
        return new(board, result with { EntityIds = ids, RulingId = ids.Length == 0 ? "" : result.RulingId }, replayed);
    }
}
