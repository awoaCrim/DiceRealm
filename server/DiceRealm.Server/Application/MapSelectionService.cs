using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record SelectMapRequest(string RequestId, int ExpectedVersion, int ExpectedMapVersion);
public sealed record SelectMapResponse(int Version, string SelectedMapId, bool Replayed);
internal sealed record HarnessMapSelectArgs(string MapId, int MapVersion);

public sealed partial class GameService
{
    public Task<SelectMapResponse> SelectMap(string id, string token, string mapId, SelectMapRequest request, CancellationToken ct)
    {
        RequestId(request.RequestId);
        if (request.ExpectedVersion < 1 || request.ExpectedMapVersion < 1)
            throw new GameException("invalid_input", "需要战役版本和地图版本。");
        return store.Access(id, token, true, c =>
        {
            string fingerprint = JsonFiles.Hash("map-select:" + JsonSerializer.Serialize(new { mapId, request }, JsonFiles.Options));
            if (store.FindReceipt(c, request.RequestId) is { } receipt)
            {
                if (receipt.Fingerprint != fingerprint || receipt.Resolution.Kind != "map.select")
                    throw new GameException("idempotency_conflict", "请求 ID 已用于另一份请求。", 409);
                return Task.FromResult(new SelectMapResponse(c.Version,
                    mapCatalog.SelectedPlayerMapId(c.Id, c.SceneId, SharedBoard.SelectedMapId(c),
                        allowFallback: !CombatEngine.InCombat(c) || c.Combat?.BoardLayout is null) ?? "", true));
            }
            if (c.Version != request.ExpectedVersion) throw new GameException("stale_version", "状态已更新，请刷新后重新选择地图。", 409);
            RequireActive(c);
            if (!PartyEngine.IsHost(c)) { CharacterReviews.RequireApproved(c); GameLifecycle.RequireAction(c); }
            var map = SelectSharedMap(c, mapId, request.ExpectedMapVersion);
            var response = new SelectMapResponse(c.Version, map.Id, false);
            c.Receipts.Add(new(request.RequestId, fingerprint, new("resolved", "map.select", "已切换当前场景共享地图；单位位置未改变。", null, []),
                c.ActingActorId));
            return Task.FromResult(response);
        }, ct);
    }

    private MapAssetView SelectSharedMap(Campaign c, string mapId, int mapVersion)
    {
        var map = BoardMap(c, mapId, publicOnly: true);
        if (!map.CurrentScene || map.Status != "ready" || !map.Published || map.Edition != "player")
            throw new GameException("board_scene_mismatch", "只可选择当前场景已发布且就绪的玩家地图。", 409);
        if (map.Version != mapVersion)
            throw new GameException("stale_board_map", "地图版本已变化，请读取当前地图后重新选择。", 409);
        if (CombatEngine.InCombat(c) && c.Combat?.BoardLayout is { } layout && layout.MapId != map.Id)
            throw new GameException("board_combat_map_locked", "当前战斗使用已冻结的局部地图；结束战斗前不能切换战斗底图。", 409);
        c.Board ??= new();
        (c.Board.SelectedMaps ??= new(StringComparer.Ordinal))[c.SceneId] = map.Id;
        c.Version++;
        c.StateOnlyVersions.Add(c.Version);
        return map;
    }
}
