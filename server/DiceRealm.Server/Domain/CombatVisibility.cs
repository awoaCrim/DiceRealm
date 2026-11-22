namespace DiceRealm.Server.Domain;

// Read projections only. Log audiences are frozen by the writer; learning about a unit
// later must not republish its earlier private actions or rewrite legacy public entries.
public static class CombatVisibility
{
    private static bool HostView(Campaign c, bool publicOnly) => !publicOnly && PartyEngine.IsHost(c);

    private static bool CanView(Campaign c, CombatUnit unit, bool publicOnly)
    {
        if (HostView(c, publicOnly) || unit.Team != "enemy" || unit.BoardEntityId is null) return true;
        var entity = c.Board?.Entities.FirstOrDefault(e => e.Id == unit.BoardEntityId);
        return entity is not null && SharedBoard.CanView(c, entity, publicOnly);
    }

    private static bool CanRead(Campaign c, CombatEntry entry, bool publicOnly) =>
        HostView(c, publicOnly) || entry.Audience is null || entry.Audience.Contains(c.ActingActorId, StringComparer.Ordinal);

    public static CombatEntry[] ProjectLog(Campaign c, IEnumerable<CombatEntry> entries, bool publicOnly = false) =>
        entries.Where(e => CanRead(c, e, publicOnly)).Select(e => Copy(e, HostView(c, publicOnly))).ToArray();

    public static Resolution ForViewer(Campaign c, Resolution result, bool publicOnly = false)
    {
        if (HostView(c, publicOnly) || result.CombatLog is null) return result;
        var entries = ProjectLog(c, result.CombatLog, publicOnly);
        return result with
        {
            // Old nonlethal combat.start has its own instructional summary. Keep it when
            // nothing was withheld, but never retain a summary containing a private entry.
            Summary = entries.Length == result.CombatLog.Length ? result.Summary : string.Join("\n", entries.Select(e => e.Text)),
            CombatLog = entries
        };
    }

    // Text and fallback narrative sometimes duplicate the generated combat summary.
    // Only replace that exact copy; authored narrative is not a mechanically generated log.
    public static string ProjectGeneratedText(Campaign c, string text, Resolution? result, bool publicOnly = false) =>
        result?.CombatLog is not null && text == result.Summary ? ForViewer(c, result, publicOnly).Summary : text;

    public static ActionOrigin? ProjectOrigin(Campaign c, ActionOrigin? origin, Resolution? result, bool publicOnly = false)
    {
        if (origin is null || HostView(c, publicOnly)) return origin;
        bool privateResult = result?.CombatLog?.Any(e => !CanRead(c, e, publicOnly)) == true;
        bool hiddenTarget = c.Combat?.Units.Any(u => !CanView(c, u, publicOnly) &&
            origin.Target.Contains(u.Id, StringComparison.Ordinal)) == true;
        // Label/Target are generated action metadata. Input remains the player's actual
        // words, and Changes only records the party's authoritative character changes.
        return privateResult || hiddenTarget ? origin with { Label = "战斗行动", Target = "" } : origin;
    }

    public static CombatState? Project(Campaign c, bool publicOnly = false)
    {
        if (c.Combat is not { } b) return null;
        var hidden = b.Units.Where(u => !CanView(c, u, publicOnly)).Select(u => u.Id).ToHashSet(StringComparer.Ordinal);
        return new()
        {
            Id = b.Id,
            DefinitionId = b.DefinitionId,
            Title = b.Title,
            Status = b.Status,
            Width = b.Width,
            Height = b.Height,
            CellFeet = b.CellFeet,
            Round = b.Round,
            ActiveActorId = hidden.Contains(b.ActiveActorId) ? "" : b.ActiveActorId,
            TurnOrder = b.TurnOrder.Where(id => !hidden.Contains(id)).ToArray(),
            Cells = b.Cells.Select(cell => cell with { }).ToArray(),
            Units = b.Units.Where(u => !hidden.Contains(u.Id)).Select(u => Copy(u, hidden)).ToArray(),
            Log = ProjectLog(c, b.Log, publicOnly).ToList(),
            LogSequence = b.LogSequence,
            RecoveryRestRequired = b.RecoveryRestRequired,
            DroppedWeaponId = b.DroppedWeaponId,
            BoardLayout = b.BoardLayout is { } layout ? layout with { Grid = layout.Grid with { } } : null,
            Standard = b.Standard is { } standard ? new()
            {
                SchemaVersion = standard.SchemaVersion,
                TurnSerial = standard.TurnSerial,
                Wait = ProjectWait(standard.Wait, hidden)
            } : null
        };
    }

    private static StandardCombatWait? ProjectWait(StandardCombatWait? wait, HashSet<string> hidden)
    {
        if (wait is null) return null;
        bool hiddenActor = hidden.Contains(wait.ActorId), hiddenTarget = hidden.Contains(wait.TargetId);
        return hiddenActor || hiddenTarget ? wait with
        {
            ActorId = hiddenActor ? "" : wait.ActorId,
            TargetId = hiddenTarget ? "" : wait.TargetId,
            Description = "等待当前战斗回应。"
        } : wait with { };
    }

    private static CombatUnit Copy(CombatUnit u, HashSet<string> hidden) => new()
    {
        Id = u.Id,
        Name = u.Name,
        Team = u.Team,
        X = u.X,
        Y = u.Y,
        HitPoints = u.HitPoints,
        MaxHitPoints = u.MaxHitPoints,
        ArmorClass = u.ArmorClass,
        Speed = u.Speed,
        InitiativeRoll = u.InitiativeRoll,
        InitiativeModifier = u.InitiativeModifier,
        Initiative = u.Initiative,
        MovementRemaining = u.MovementRemaining,
        ActionAvailable = u.ActionAvailable,
        BonusActionAvailable = u.BonusActionAvailable,
        ReactionAvailable = u.ReactionAvailable,
        Dodging = u.Dodging,
        Disengaging = u.Disengaging,
        SavageAttackerUsed = u.SavageAttackerUsed,
        SurgeAction = u.SurgeAction,
        Withdrawn = u.Withdrawn,
        RecoveryRestRequired = u.RecoveryRestRequired,
        DroppedWeaponId = u.DroppedWeaponId,
        BoardEntityId = u.BoardEntityId,
        BoardPosition = u.BoardPosition is { } position ? position with { Origin = position.Origin with { } } : null,
        BoardBody = u.BoardBody is { } body ? new()
        {
            TemporaryHitPoints = body.TemporaryHitPoints,
            Conditions = body.Conditions.ToArray()
        } : null,
        Standard = u.Standard is { } standard ? new()
        {
            DeathSuccesses = standard.DeathSuccesses,
            DeathFailures = standard.DeathFailures,
            Stable = standard.Stable,
            Dead = standard.Dead,
            ZeroHitPointUnconscious = standard.ZeroHitPointUnconscious,
            TemporaryHitPoints = standard.TemporaryHitPoints,
            Conditions = standard.Conditions.ToArray(),
            DroppedItems = standard.DroppedItems.Select(item => item with { }).ToArray(),
            AttacksRemaining = standard.AttacksRemaining,
            DashesThisTurn = standard.DashesThisTurn,
            ActionSurgeUsed = standard.ActionSurgeUsed,
            SlotSpentTurn = standard.SlotSpentTurn,
            ShieldActive = standard.ShieldActive,
            ReactionsSuppressed = standard.ReactionsSuppressed,
            MasteryEffects = standard.MasteryEffects.Where(e => !hidden.Contains(e.SourceId)).Select(e => e with { }).ToArray()
        } : null
    };

    private static CombatEntry Copy(CombatEntry e, bool hostView) => e with
    {
        Audience = hostView ? e.Audience?.ToArray() : null,
        Presentation = e.Presentation is { } presentation ? presentation with
        {
            Units = presentation.Units.Select(u => u with { Conditions = u.Conditions.ToArray() }).ToArray()
        } : null,
        Attack = e.Attack is { } attack ? attack with
        {
            Rolls = attack.Rolls.ToArray(),
            DamageRolls = attack.DamageRolls.ToArray(),
            AlternateRolls = attack.AlternateRolls.ToArray(),
            EffectiveDice = attack.EffectiveDice.ToArray()
        } : null,
        Spell = e.Spell is { } spell ? spell with { DamageRolls = spell.DamageRolls.ToArray() } : null,
        Check = e.Check is { } check ? check with { Rolls = check.Rolls.ToArray(), BonusRolls = check.BonusRolls?.ToArray() } : null
    };
}
