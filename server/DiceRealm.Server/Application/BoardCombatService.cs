using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    private void PrepareBoardCombat(Campaign c, Intent? intent, bool useCurrentBoardMap)
    {
        if (intent?.Kind != "combat.start" || c.Board is null) return;
        string? selected = SharedBoard.SelectedMapId(c);
        var map = useCurrentBoardMap ? mapCatalog.SelectedPlayerMap(c.Id, c.SceneId, selected,
            allowFallback: !CombatEngine.InCombat(c) || c.Combat?.BoardLayout is null) : null;
        if (useCurrentBoardMap && map is null)
            throw new GameException("board_combat_map_required", "当前场景没有可读取的已发布玩家底图；不能改用角色最后操作的另一张图开战。", 409);
        var entity = c.Board.Entities.FirstOrDefault(e => e.ActorId == c.ActingActorId);
        // Old runs/consents retain their placement-based preparation. New actions use the
        // same effective current map as the library and model, even without a saved selection.
        var placement = useCurrentBoardMap ? SharedBoard.PlacementOn(entity, map!.Id)
            : selected is null ? entity?.Placement : SharedBoard.PlacementOn(entity, selected);
        if (placement is not { OnMap: true })
            throw new GameException("board_combat_placement_required", "当前角色尚未由DM放到所选场景地图；须先保存真实站位，不能补造战斗出生点。", 409);
        c.BoardMapContext = map ?? BoardMap(c, placement.MapId, publicOnly: true);
        if (ContentRuntime.AvailableEncounter(c) is { } encounter)
            _ = BoardCombat.Prepare(c, encounter, c.BoardMapContext);
    }

    private (BoardCommandResult Result, Resolution? Resolution) ExecuteBoardCommand(Campaign c, MapAssetView map,
        BoardCommandRequest command, bool narrator = false, bool controlPlayers = false, int namingVersion = NpcNames.Version)
    {
        if (command.ExpectedMapVersion != map.Version)
            throw new GameException("stale_board_map", "地图版本或标定已变化，请重新读取后选择；不会按新网格执行旧意图。", 409);
        if (command.Operation != "move" || !CombatEngine.InCombat(c))
            return (SharedBoard.Execute(c, map, command, narrator, controlPlayers, namingVersion), null);
        SharedBoard.ValidateCommand(command);
        ContextualRolls.RequireNoPending(c);
        // Combat uses the same movement/continuation engine as the ordinary action entry.
        // It never applies a preview as a free exploration placement or changes the acting seat.
        var resolution = BoardCombat.ResolveMove(c, map, command, combat);
        string status = resolution.Status == "resolved" ? "applied" : "pending";
        return (new(status, [command.EntityId], Guid.NewGuid().ToString(), resolution.RulingId,
            resolution.Summary + " 实际落点以返回棋盘为准；未结算的预览不代表已经移动。"), resolution);
    }
}
