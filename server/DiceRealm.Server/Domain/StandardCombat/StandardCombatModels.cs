namespace DiceRealm.Server.Domain;

// Additive state belongs only to an explicitly opted-in standard encounter.
public sealed class StandardCombatState
{
    public int SchemaVersion { get; set; } = 1;
    public int TurnSerial { get; set; }
    public StandardCombatWait? Wait { get; set; }
}
public sealed record StandardCombatWait(string Kind, string ActorId, string TargetId, string Description);
public sealed class StandardCombatUnit
{
    public int DeathSuccesses { get; set; }
    public int DeathFailures { get; set; }
    public bool Stable { get; set; }
    public bool Dead { get; set; }
    public bool ZeroHitPointUnconscious { get; set; }
    public int TemporaryHitPoints { get; set; }
    public string[] Conditions { get; set; } = [];
    public StandardDroppedItem[] DroppedItems { get; set; } = [];
    public int AttacksRemaining { get; set; }
    public int DashesThisTurn { get; set; }
    public bool ActionSurgeUsed { get; set; }
    public int SlotSpentTurn { get; set; }
    public bool ShieldActive { get; set; }
    public bool ReactionsSuppressed { get; set; }
    public StandardMasteryEffect[] MasteryEffects { get; set; } = [];
}
public sealed record StandardMasteryEffect(string Kind, string SourceId, int TurnEndsRemaining);
public sealed record StandardDroppedItem(string Id, int X, int Y,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? Slot = null);
// Never projected to a client. The remaining continuation is saved with the triggering event.
public sealed class StandardCombatFlow
{
    public int SchemaVersion { get; set; } = 1;
    public List<StandardCombatStep> Steps { get; set; } = [];
    // Null preserves historical batch execution; a value is the last narrated log sequence.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public int? NarratedThrough { get; set; }
}
public sealed class StandardCombatStep
{
    public string Kind { get; set; } = "";
    public string ActorId { get; set; } = "";
    public string TargetId { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? WeaponId { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public string[] Reacted { get; set; } = [];
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public StandardStrike? Strike { get; set; }
    public int SaveDc { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public StandardAreaHit? Area { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public StandardMissiles? Missiles { get; set; }
}
// Goblin-only weapon and advantage d4 count are frozen before a possible Shield wait.
// Null keeps historical melee continuations and their serialized shape unchanged.
public sealed record StandardStrike(AttackRoll Roll, int Dice, int Die, string DamageType, bool Opportunity, bool Savage, bool GreatWeaponFighting, int GrazeDamage, bool UseMastery = false, int AbilityModifier = 0,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? WeaponId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] int? AdvantageDamageDice = null);

public sealed record StandardMissiles(string SourceKey, int Count, string[] Targets, int SlotLevel);
public sealed record StandardAreaHit(string SpellId, string Ability, int Dc, int Damage, string DamageType, bool HalfOnSave, int CoverBonus = 0);
