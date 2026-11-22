namespace DiceRealm.Server.Domain;

public static partial class SharedBoard
{
    public static void ValidateState(Campaign c)
    {
        if (c.Board is not { } board)
        {
            BoardCombat.ValidateState(c);
            return;
        }
        try
        {
            if (board.SchemaVersion != 1 || board.Entities is null || board.Moves is null ||
                board.Entities.Count > 2048 || board.RecentOperations is { Count: > 32 }) throw Invalid();
            if (board.SelectedMaps is not null && board.SelectedMaps.Any(pair =>
                string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 160 || !Uuid(pair.Value))) throw Invalid();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var labels = new HashSet<string>(StringComparer.Ordinal);
            var players = new HashSet<string>(StringComparer.Ordinal);
            var people = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entity in board.Entities)
            {
                if (entity is null || !Uuid(entity.Id) || !ids.Add(entity.Id) || !labels.Add(entity.Id[..8]) || entity.Kind is not ("creature" or "object") ||
                    entity.ActorId is null || entity.CharacterId is null || entity.FactionId is null || entity.FactionId.Length > 160 ||
                    entity.Source is null || entity.ActorId.Length > 0 && (!players.Add(entity.ActorId) || entity.CharacterId.Length == 0 ||
                        entity.Statistics is not null || entity.Character is not null || entity.Source.Kind != "player")) throw Invalid();
                ValidateSource(entity.Source);
                if (entity.Character is { } character && (entity.ActorId.Length != 0 || entity.Kind != "creature" || entity.Source.Kind != "custom" ||
                    entity.Statistics is not null || entity.CharacterId != character.Id || !Uuid(character.Id) || character.Build is null ||
                    character.Abilities is not { Length: 6 } || character.HitPoints < 0 || character.MaxHitPoints < 1 || character.HitPoints > character.MaxHitPoints)) throw Invalid();
                if (entity.Source.Kind == "player" && (entity.Source.Id != entity.ActorId || entity.ActorId.Length == 0)) throw Invalid();
                if (entity.Source.Kind == "npc" && !people.Add(entity.Source.Id)) throw Invalid();
                ValidateAppearance(entity.Appearance); ValidateStatistics(entity.Statistics);
                if (entity.Placement is { } p) ValidatePlacement(p);
                foreach (var pair in entity.MapPlacements ?? [])
                {
                    ValidatePlacement(pair.Value);
                    if (pair.Key != pair.Value.MapId || pair.Key == entity.Placement?.MapId) throw Invalid();
                }
            }
            var operations = new HashSet<string>(StringComparer.Ordinal);
            foreach (var operation in board.RecentOperations ?? [])
            {
                if (operation is null || !Uuid(operation.Id) || !operations.Add(operation.Id) || operation.Version < 1 || operation.Version > c.Version ||
                    string.IsNullOrEmpty(operation.ActorId) || operation.Kind is not ("spawn" or "move" or "remove" or "update" or "undo" or "ruling" or "combat") ||
                    operation.Changes is null || operation.Changes.Length == 0 || operation.Changes.Length > 2048) throw Invalid();
                foreach (var change in operation.Changes)
                {
                    if (change is null || !ids.Contains(change.EntityId)) throw Invalid();
                    if (change.Before is { } before) ValidatePlacement(before);
                    if (change.After is { } after) ValidatePlacement(after);
                    ValidateAppearance(change.BeforeAppearance); ValidateAppearance(change.AfterAppearance);
                }
            }
            var moves = new HashSet<string>(StringComparer.Ordinal);
            var pending = new HashSet<string>(StringComparer.Ordinal);
            foreach (var move in board.Moves)
            {
                if (move is null || !Uuid(move.Id) || !moves.Add(move.Id) || !ids.Contains(move.EntityId) || string.IsNullOrEmpty(move.ActorId) ||
                    move.SceneId is null || !Uuid(move.RulingId) || move.Status is not ("pending" or "applied" or "rejected") ||
                    move.Status == "pending" && !pending.Add(move.EntityId) || !c.PendingRulings.Any(r => r.Id == move.RulingId)) throw Invalid();
                ValidatePlacement(move.Origin); ValidatePlacement(move.Destination);
                if (move.Origin.MapId != move.Destination.MapId) throw Invalid();
            }
        }
        catch (GameException)
        {
            throw new GameException("invalid_board_state", "棋盘存档结构或引用无效；原存档已保留。", 409);
        }
        BoardCombat.ValidateState(c);
    }
    private static bool Uuid(string? id) => Guid.TryParseExact(id, "D", out var value) && value != Guid.Empty;
    private static void ValidatePlacement(BoardPlacement p)
    {
        if (p is null || !Uuid(p.MapId) || p.Path is null || p.Path.Length > 64) throw Invalid();
        ValidatePoint(new(p.X, p.Y)); foreach (var point in p.Path) ValidatePoint(point);
    }
    private static void ValidateSource(BoardSource s)
    {
        if (s.Kind is not ("player" or "npc" or "enemy" or "custom") ||
            s.Id is null || s.Id.Length > 160 || s.EncounterId is null || s.EncounterId.Length > 160 ||
            s.RulesId is null || s.RulesId.Length > 240 || s.ContentVersion is null || s.ContentVersion.Length > 160 ||
            s.Kind is "player" or "npc" or "enemy" && s.Id.Length == 0 ||
            s.Kind == "enemy" && s.EncounterId.Length == 0 ||
            s.Kind != "enemy" && s.EncounterId.Length > 0 ||
            s.Kind == "custom" && (s.Id.Length > 0 || s.RulesId.Length > 0)) throw Invalid();
    }
}
