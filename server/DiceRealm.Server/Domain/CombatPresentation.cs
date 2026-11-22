namespace DiceRealm.Server.Domain;

// Frozen playback facts only. They never drive combat rules or continuation steps.
public sealed record CombatEntryPresentation(string CombatId, string Text, string ActiveActorId, CombatUnitMoment[] Units);
public sealed record CombatUnitMoment(string Id, int X, int Y, int HitPoints, int TemporaryHitPoints,
    string[] Conditions, bool Dead, bool Stable, bool Withdrawn);

internal static class CombatPresentation
{
    internal static string[] Involved(string actor, string? target, string[]? targets) =>
        new[] { actor, target }.Concat(targets ?? []).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();

    internal static string[]? Audience(Campaign c, IEnumerable<string> involved)
    {
        string[]? audience = null;
        foreach (string id in involved)
        {
            var entity = Entity(c, id);
            if (entity?.Appearance.Visibility != "gm") continue;
            var known = EncounterConcealment.Find(c, entity.Id)?.KnownActors ?? [];
            audience = audience is null ? known.ToArray() : audience.Intersect(known).ToArray();
        }
        return audience;
    }

    internal static CombatEntryPresentation Capture(Campaign c, string text, string[] involved, string[]? audience)
    {
        var b = c.Combat!;
        var active = b.Units.FirstOrDefault(u => u.Id == b.ActiveActorId);
        var entity = active is null ? null : Entity(c, active.Id);
        // An unrelated hidden turn must not leak through an otherwise public damage/save.
        // Decide once here, never from the viewer's later knowledge of that combatant.
        bool showActive = active is not null && (entity is null || entity.Appearance.Visibility != "gm" || involved.Contains(active.Id) ||
            audience is not null && audience.All(id => (EncounterConcealment.Find(c, entity.Id)?.KnownActors ?? []).Contains(id)));
        var units = involved.Select(id => b.Units.FirstOrDefault(u => u.Id == id)).OfType<CombatUnit>().Select(u =>
        {
            var character = u.Standard is null && u.Team != "enemy" ? PartyEngine.CharacterFor(c, u.Id) : null;
            var conditions = (u.Standard?.Conditions ?? character?.Conditions ?? u.BoardBody?.Conditions ?? []).ToArray();
            return new CombatUnitMoment(u.Id, u.X, u.Y, u.HitPoints,
                u.Standard?.TemporaryHitPoints ?? character?.TemporaryHitPoints ?? u.BoardBody?.TemporaryHitPoints ?? 0,
                conditions, u.Standard?.Dead ?? conditions.Contains("Dead"), u.Standard?.Stable ?? false, u.Withdrawn);
        }).ToArray();
        return new(b.Id, text, showActive ? active!.Id : "", units);
    }

    private static BoardEntity? Entity(Campaign c, string unitId) =>
        c.Board?.Entities.FirstOrDefault(e => e.Id == c.Combat!.Units.FirstOrDefault(u => u.Id == unitId)?.BoardEntityId);
}
