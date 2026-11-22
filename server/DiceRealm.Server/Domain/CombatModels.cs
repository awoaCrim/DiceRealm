namespace DiceRealm.Server.Domain;

public sealed record BattleCell(int X, int Y, string Terrain);
public sealed record AttackRoll(int[] Rolls, int Selected, int Modifier, int Total, int ArmorClass,
    string Mode, bool Hit, bool Critical, int[] DamageRolls, int[] AlternateRolls,
    int[] EffectiveDice, int DamageModifier, int Damage, bool Graze,
    string Source = "XPHB", string Ruleset = "dnd2024");
public sealed record CombatEntry(int Sequence, int Round, string Kind, string ActorId, string Text, AttackRoll? Attack = null, SpellRoll? Spell = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] DiceCheck? Check = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string[]? Audience = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] CombatEntryPresentation? Presentation = null);
public sealed class CombatUnit
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Team { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
    public int HitPoints { get; set; }
    public int MaxHitPoints { get; set; }
    public int ArmorClass { get; set; }
    public int Speed { get; set; }
    public int InitiativeRoll { get; set; }
    public int InitiativeModifier { get; set; }
    public int Initiative { get; set; }
    public int MovementRemaining { get; set; }
    public bool ActionAvailable { get; set; }
    public bool BonusActionAvailable { get; set; }
    public bool ReactionAvailable { get; set; } = true;
    public bool Dodging { get; set; }
    public bool Disengaging { get; set; }
    public bool SavageAttackerUsed { get; set; }
    public bool SurgeAction { get; set; }
    public bool Withdrawn { get; set; }
    public bool RecoveryRestRequired { get; set; }
    public string DroppedWeaponId { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? BoardEntityId { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public BoardCombatPosition? BoardPosition { get; set; }
    // Nonlethal bridge state only; standard units already own these fields in Standard.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public BoardCombatBody? BoardBody { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public StandardCombatUnit? Standard { get; set; }
}
public sealed class CombatState
{
    public string Id { get; set; } = "";
    public string DefinitionId { get; set; } = "";
    public string Title { get; set; } = "";
    public string Status { get; set; } = "active"; // active | victory | defeated | retreated
    public int Width { get; set; } = 7;
    public int Height { get; set; } = 5;
    public int CellFeet { get; set; } = 5;
    public int Round { get; set; } = 1;
    public string ActiveActorId { get; set; } = "player";
    public string[] TurnOrder { get; set; } = [];
    public BattleCell[] Cells { get; set; } = [];
    public CombatUnit[] Units { get; set; } = [];
    public List<CombatEntry> Log { get; set; } = [];
    public int LogSequence { get; set; }
    public bool RecoveryRestRequired { get; set; }
    public string DroppedWeaponId { get; set; } = "greatsword";
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public BoardCombatLayout? BoardLayout { get; set; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public StandardCombatState? Standard { get; set; }
}
