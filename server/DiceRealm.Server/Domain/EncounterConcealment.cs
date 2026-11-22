namespace DiceRealm.Server.Domain;

// Private pre-combat evidence and per-seat discovery. NPC dice are saved once with setup.
public sealed class EncounterHiddenEnemy
{
    public required string EntityId { get; init; }
    public required string Cover { get; init; }
    public required string Reason { get; init; }
    public required DiceCheck Stealth { get; init; }
    public bool Hidden { get; set; }
    public string[] KnownActors { get; set; } = [];
}
public sealed record EncounterObservation(string IntentId, string ActorId, int Total, string[] FoundIds,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string[]? UnpresentedIds = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? SearchKind = null);

public static class EncounterConcealment
{
    public static EncounterHiddenEnemy? Find(Campaign c, string entityId) => c.RuntimeEncounters?
        .SelectMany(e => e.Concealment ?? []).SingleOrDefault(e => e.EntityId == entityId);
    public static bool KnownTo(Campaign c, string entityId, string actorId) => Find(c, entityId)?.KnownActors.Contains(actorId) == true;
    // A resolved check is available to the DM immediately. The player's map waits for
    // the story that delivers that discovery, not for an arbitrary UI timer.
    public static bool PresentedTo(Campaign c, string entityId, string actorId) => KnownTo(c, entityId, actorId) &&
        c.RuntimeEncounters?.SelectMany(e => e.Observations ?? []).Any(o => o.ActorId == actorId && o.UnpresentedIds?.Contains(entityId) == true) != true;
    public static void PresentDiscoveries(Campaign c)
    {
        if (c.RuntimeEncounters is null) return;
        for (int i = 0; i < c.RuntimeEncounters.Count; i++)
        {
            var setup = c.RuntimeEncounters[i];
            if (setup.SceneId != c.SceneId || setup.Observations?.Any(o => o.ActorId == c.ActingActorId && o.UnpresentedIds is { Length: > 0 }) != true) continue;
            c.RuntimeEncounters[i] = setup with { Observations = setup.Observations.Select(o => o.ActorId == c.ActingActorId ? o with { UnpresentedIds = null } : o).ToArray() };
        }
    }
    // v43 delivers only the explicitly named, already-known entities to each recipient.
    public static void PresentDiscoveries(Campaign c, PrivateStoryMessage[] messages)
    {
        if (c.RuntimeEncounters is null) return;
        foreach (var message in messages.Where(m => m.DiscoveryIds is { Length: > 0 }))
            for (int i = 0; i < c.RuntimeEncounters.Count; i++)
            {
                var setup = c.RuntimeEncounters[i];
                if (setup.SceneId != c.SceneId || setup.Observations is null) continue;
                c.RuntimeEncounters[i] = setup with
                {
                    Observations = setup.Observations.Select(o => message.RecipientIds.Contains(o.ActorId) && o.UnpresentedIds is not null
                        ? o with { UnpresentedIds = o.UnpresentedIds.Except(message.DiscoveryIds!).ToArray() is { Length: > 0 } remaining ? remaining : null } : o).ToArray()
                };
            }
    }
    public static int[] Difficulties(Campaign c) => (RuntimeEncounters.Current(c)?.Concealment ?? [])
        .Where(e => e.Stealth.Success && !e.KnownActors.Contains(c.ActingActorId))
        .Select(e => e.Stealth.Total).Distinct().Order().ToArray();
    public static bool IsHidden(Campaign c, string entityId) => Find(c, entityId)?.Hidden == true;
    public static bool CanParticipate(Campaign c, BoardEntity entity, string encounterId) =>
        entity.Source.EncounterId == encounterId && Find(c, entity.Id) is not null;

    public static void Search(Campaign c, string encounterId, string intentId, int total, bool waitForNarrative = false, string? searchKind = null)
    {
        var setup = RuntimeEncounters.Current(c);
        if (setup?.Definition.Id != encounterId || setup.Concealment is null)
            throw new GameException("check_context_unavailable", "原对抗记录不再适用，不能重建隐匿骰。", 409);
        if (searchKind is not (null or "active" or "passive"))
            throw new GameException("check_context_unavailable", "侦察方式无效。", 409);
        if (setup.Observations?.Any(o => o.IntentId == intentId && o.ActorId == c.ActingActorId &&
            (searchKind is null || o.SearchKind == searchKind)) == true)
            throw new GameException("check_already_requested", "此行动已处理过侦察结果，不能重掷。", 409);
        var found = setup.Concealment.Where(e => e.KnownActors.Contains(c.ActingActorId) || !e.Stealth.Success || total >= e.Stealth.Total).ToArray();
        var unpresented = waitForNarrative ? found.Where(e => !e.KnownActors.Contains(c.ActingActorId)).Select(e => e.EntityId).ToArray() : [];
        foreach (var enemy in found)
        {
            enemy.Hidden = false; // XPHB Hide ends when an enemy finds you.
            enemy.KnownActors = enemy.KnownActors.Append(c.ActingActorId).Distinct().ToArray();
        }
        var observations = (setup.Observations ?? []).Append(new EncounterObservation(intentId, c.ActingActorId, total, found.Select(e => e.EntityId).ToArray(), unpresented.Length == 0 ? null : unpresented, searchKind)).ToArray();
        c.RuntimeEncounters![c.RuntimeEncounters.IndexOf(setup)] = setup with { Observations = observations };
    }

    // Current flat-cover policy only: actual sight from an unobstructed side ends Hide,
    // but does not tell other seats what this observer discovered. No GET-time updates.
    public static void RefreshSight(Campaign c, CombatState board)
    {
        foreach (var enemy in RuntimeEncounters.Current(c)?.Concealment ?? [])
        {
            var target = board.Units.FirstOrDefault(u => u.BoardEntityId == enemy.EntityId);
            if (target is null || target.Withdrawn || target.HitPoints <= 0) continue;
            var observers = board.Units.Where(u => u.Team == "party" && !u.Withdrawn && u.HitPoints > 0 &&
                !((u.Standard?.Conditions ?? []).Any(s => s is "Blinded" or "Unconscious" or "Incapacitated" or "Paralyzed" or "Stunned" or "Petrified")) &&
                CombatGeometry.Cover(board, u, target) < 5).Select(u => u.Id).ToArray();
            if (observers.Length == 0) continue;
            enemy.Hidden = false;
            enemy.KnownActors = enemy.KnownActors.Concat(observers).Distinct().ToArray();
        }
    }

    public static void RefreshSight(Campaign c, MapAssetView map)
    {
        var setup = RuntimeEncounters.Current(c);
        if (setup?.Layout is null || CombatEngine.Restricted(c) || !RuntimeEncounters.MatchesMap(setup.Layout, map)) return;
        var units = (c.Board?.Entities ?? []).Where(e => SharedBoard.PlacementOn(e, map.Id) is { OnMap: true } &&
            (e.ActorId.Length > 0 || e.Source.EncounterId == setup.Definition.Id)).Select(e =>
        {
            var position = SharedBoard.PlacementOn(e, map.Id)!;
            var cell = BoardCombat.NormalizedToGrid(setup.Layout, new(position.X, position.Y));
            var ch = e.ActorId.Length > 0 ? PartyEngine.CharacterFor(c, e.ActorId) : null;
            return new CombatUnit { Id = ch is null ? e.Id : e.ActorId, BoardEntityId = e.Id, Team = ch is null ? "enemy" : "party",
                X = cell.X, Y = cell.Y, HitPoints = ch?.HitPoints ?? e.Statistics?.HitPoints ?? 0,
                Standard = new() { Conditions = ch?.Conditions ?? e.Statistics?.Conditions ?? [] } };
        }).ToArray();
        RefreshSight(c, new CombatState { Width = setup.Layout.Width, Height = setup.Layout.Height, Cells = setup.Definition.Cells, Units = units });
    }

    public static void Reveal(Campaign c, string entityId)
    {
        var hidden = Find(c, entityId);
        if (hidden is null) return;
        hidden.Hidden = false;
        // Revocation removes access, not the historical fact of an earlier discovery.
        hidden.KnownActors = hidden.KnownActors.Concat(PartyEngine.Characters(c).Select(p => p.Id)).Distinct().ToArray();
        var board = c.Board!;
        int index = board.Entities.FindIndex(e => e.Id == entityId);
        var before = board.Entities[index];
        if (before.Appearance.Visibility == "player") return;
        var after = before with { Appearance = before.Appearance with { Visibility = "player" } };
        board.Entities[index] = after;
    }

    public static void Validate(Campaign c, RuntimeEncounter setup)
    {
        void Require(bool value)
        {
            if (!value) throw new GameException("invalid_runtime_encounter", "隐匿、发现或开战记录无效；原存档已保留。", 409);
        }
        var party = PartyEngine.Characters(c, true).Select(p => p.Id).ToHashSet();
        var hidden = setup.Concealment ?? [];
        Require(hidden.All(e => e is not null) && hidden.Select(e => e.EntityId).Distinct().Count() == hidden.Length);
        foreach (var enemy in hidden)
        {
            var entity = c.Board?.Entities.SingleOrDefault(e => e.Id == enemy.EntityId);
            Require(entity is not null && entity.Source.EncounterId == setup.Definition.Id &&
                enemy.Cover is "three-quarters-cover" or "total-cover" && enemy.Reason is { Length: > 0 and <= 500 } &&
                enemy.KnownActors is not null && enemy.KnownActors.All(party.Contains) && enemy.KnownActors.Distinct().Count() == enemy.KnownActors.Length);
            var profile = StandardMonsters.Find(entity!.Source.RulesId);
            var check = enemy.Stealth;
            int modifier = profile?.Id == "xmm:goblin-warrior" ? 6 : profile?.Dexterity ?? int.MinValue;
            Require(check is not null && check.Ability == "dexterity" && check.Skill == "Stealth" && check.Mode == "normal" &&
                check.Rolls is { Length: 1 } && check.Selected == check.Rolls[0] && check.Selected is >= 1 and <= 20 &&
                check.Modifier == modifier && check.Total == check.Selected + modifier && check.Dc == 15 && check.HasDc &&
                check.Success == (check.Total >= 15) && (!enemy.Hidden || check.Success && enemy.KnownActors!.Length == 0));
        }
        Require(setup.SurprisedActors is null || setup.SurprisedActors.All(party.Contains) && setup.SurprisedActors.Distinct().Count() == setup.SurprisedActors.Length);
        Require(setup.EngagementReason is null || setup.EngagementReason.Length is > 0 and <= 500);
        if (setup.Observations is { } observations)
            Require(observations.All(o => o is not null && o.IntentId.Length > 0 && party.Contains(o.ActorId) && o.FoundIds is not null &&
                o.SearchKind is null or "active" or "passive" &&
                o.FoundIds.All(id => hidden.Any(e => e.EntityId == id)) &&
                (o.UnpresentedIds is null || o.UnpresentedIds.Distinct().Count() == o.UnpresentedIds.Length &&
                    o.UnpresentedIds.All(id => o.FoundIds.Contains(id) && hidden.Any(e => e.EntityId == id && e.KnownActors.Contains(o.ActorId))))) &&
                observations.Select(o => (o.IntentId, o.ActorId, o.SearchKind)).Distinct().Count() == observations.Length);
    }
}

public static partial class SharedBoard
{
    // This scope is only called after exact descriptor/layout validation. It is not a client flag
    // and cannot be obtained by token_spawn or ordinary board commands.
    internal static string[] SpawnEncounter(Campaign c, MapAssetView map, RuntimeEncounter setup, EncounterPlacement[] placements)
    {
        var board = c.Board ??= new SharedBoardState();
        var entityIds = new List<string>();
        for (int i = 0; i < placements.Length; i++)
        {
            var p = placements[i]; var enemy = setup.Definition.Enemies[i];
            var appearance = new BoardAppearance(enemy.Name, "", "", p.HidingCover is null ? "player" : "gm");
            var entity = Create(c, board.Entities, new("", "creature", new("enemy", enemy.Id, setup.Definition.Id), appearance,
                p.Position.X, p.Position.Y), narrator: true, encounterSetup: true);
            entity = WithPlacement(entity, new(map.Id, p.Position.X, p.Position.Y, true, []));
            board.Entities.Add(entity);
            entityIds.Add(entity.Id);
        }
        return entityIds.ToArray();
    }
}
