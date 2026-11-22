namespace DiceRealm.Server.Domain;

public static partial class SharedBoard
{
    public static BoardPlacement? PlacementOn(BoardEntity? entity, string mapId) =>
        entity?.Placement?.MapId == mapId ? entity.Placement :
        entity?.MapPlacements?.GetValueOrDefault(mapId);

    public static BoardEntity WithPlacement(BoardEntity entity, BoardPlacement placement)
    {
        var remembered = entity.MapPlacements is null ? null : new Dictionary<string, BoardPlacement>(entity.MapPlacements, StringComparer.Ordinal);
        if (entity.Placement is { } before && before.MapId != placement.MapId)
        {
            remembered ??= new(StringComparer.Ordinal);
            remembered[before.MapId] = before;
        }
        remembered?.Remove(placement.MapId);
        return entity with { Placement = placement, MapPlacements = remembered is { Count: > 0 } ? remembered : null };
    }

    public static string? SelectedMapId(Campaign c) => CombatEngine.InCombat(c) && c.Combat?.BoardLayout is { } layout
        ? layout.MapId : c.Board?.SelectedMaps?.GetValueOrDefault(c.SceneId)
            ?? RuntimeEncounters.Current(c)?.Layout?.MapId ?? RuntimeEncounters.Current(c)?.ObservationMapId;
}
