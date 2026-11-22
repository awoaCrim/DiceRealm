namespace DiceRealm.Server.Domain;

public static partial class SharedBoard
{
    // A ruling may settle this one saved placement intent, never arbitrary coordinates or mechanics.
    public static string ResolveMoveRuling(Campaign c, string rulingId, bool apply)
    {
        int index = c.Board?.Moves.FindIndex(m => m.RulingId == rulingId && m.Status == "pending") ?? -1;
        if (index < 0)
        {
            if (apply) throw new GameException("board_move_unavailable", "此裁定没有待处理的棋盘移动。", 409);
            return "";
        }
        var board = c.Board!; var move = board.Moves[index];
        if (!apply)
        {
            board.Moves[index] = move with { Status = "rejected" };
            return "棋盘移动预览已结束，实际位置未改变。检定或叙事记录本身不解除移动限制。";
        }
        var entity = Find(c, move.EntityId);
        if (CombatEngine.InCombat(c) || move.SceneId != c.SceneId || PlacementOn(entity, move.Origin.MapId) is not { OnMap: true } current ||
            current.MapId != move.Origin.MapId || current.X != move.Origin.X || current.Y != move.Origin.Y ||
            !current.Path.SequenceEqual(move.Origin.Path) || !CanView(c, entity, true))
            throw new GameException("board_move_context_changed", "原场景、位置或可见范围已变化；请驳回旧意图后按当前状态重新移动。", 409);
        if (MovementRestricted(c, entity))
            throw new GameException("board_move_restricted", "当前实例仍有移动限制；请先通过原规则结算解除，裁定摆位不能删除状态。", 409);
        if (entity.ActorId.Length > 0 && !PartyEngine.Characters(c).Any(p => p.Id == entity.ActorId && p.Character.Id == entity.CharacterId))
            throw new GameException("board_move_context_changed", "原角色已不在此席位。", 409);
        board.Entities[board.Entities.FindIndex(e => e.Id == entity.Id)] = WithPlacement(entity, move.Destination);
        board.Moves[index] = move with { Status = "applied" };
        return "已按原移动意图保存实际落点；未修改 HP、状态、资源或地形。";
    }
}
