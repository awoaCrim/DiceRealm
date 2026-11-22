namespace DiceRealm.Server.Domain;

// Runtime choices are separate from the immutable level-one acquisition record.
public sealed record CharacterPlayState(int SchemaVersion, string[] PreparedSpells, bool PreparationOpen = false,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string[]? PreparedClasses = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string[]? RestChoicesUsed = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? ActiveWeaponId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] CharacterLoadout? Loadout = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] CharacterAttunement[]? Attunements = null);
public sealed record CharacterAttunement(string ItemId, string RulesId);
public sealed record SheetWearablesView(SheetEquipmentSlot[] Slots, SheetLoadoutOption[] Options, SheetWearableItem[] Items,
    SheetLoadoutOption[] AttunementOptions, int AttunementUsed, int AttunementLimit = 3, string Notice = "");
public sealed record SheetWearableItem(string ItemId, string RulesId, string Slot, string Label, bool Equipped,
    bool RequiresAttunement, bool Attuned, bool Effective, string Status, string Notice = "");
public sealed record CharacterLoadout(string MeleeMainHandId = "", string MeleeOffHandId = "", string RangedMainHandId = "", string RangedOffHandId = "", string ActiveSet = "melee", string MeleeGrip = "one");
public sealed record SheetEquipmentSlot(string Id, string Label, string ItemId, string OccupiedBy, bool Active);
public sealed record SheetLoadoutOption(string Key, string Label, string Slot, string ItemId, int Seconds, bool Available, string Reason = "");
public sealed record SheetLoadoutView(string ActiveSet, string MeleeGrip, SheetEquipmentSlot[] Slots, SheetLoadoutOption[] Options, string Notice = "");
public sealed record CharacterPlayRequest(string RequestId, int ExpectedVersion, string Operation, string Key = "", int Value = 1,
    string Mode = "normal", string[]? Choices = null);
public sealed record SheetCheckOption(string Id, string Label, string Ability, string Skill, int Modifier, bool SavingThrow, bool Available = true, string Reason = "");
public sealed record SheetEquipmentOption(string Id, string Name, bool Equipped, int Seconds, bool Available, string Reason, string Details = "", bool IsActive = false, bool CanActivate = false, string ActivateReason = "");
public sealed record SheetSpellOption(string Id, string SpellId, string Name, string Source, string Ability, int AttackBonus, int SaveDc,
    string Resource, int Remaining, string Details, bool Available, string Reason);
public sealed record SheetPreparation(bool Available, string Reason, int Count, int MaxChanges, BuildOption[] Options, string[] Selected, string ClassId = "");
public sealed record SheetRestChoice(string Key, string Label, int Count, BuildOption[] Options, string[] Selected, bool Available, string Reason);
public sealed record SheetEffectOption(string Key, string Label, string ItemId, string SpellSource, ActionDetails Details);
public sealed record SheetPackOption(string Key, string ItemId, SheetPackContent[] Contents, bool Available, string Reason = "");
public sealed record SheetPackContent(string Id, string Name, string RulesId, int Quantity);
public sealed record SheetFeatureDetail(int Index, string Name, string Text, string Notice = "", string Group = "");
public sealed record CharacterRuleReferences(int Version, string ActorId, string CharacterId, SheetFeatureDetail[] FeatureDetails, string Notice);
public sealed record SheetItemDetail(string Id, string Name, string Text, string Notice = "",
    bool HasWeight = false, decimal WeightPounds = 0, bool HasPrice = false, decimal PriceCp = 0, string Rarity = "", string Category = "");
public sealed record SheetWeightView(decimal TotalPounds, long UnknownCount, string Unit = "lb",
    bool HasCapacity = false, decimal CapacityPounds = 0, string CapacityNotice = "");
public sealed record CharacterSheetView(int Version, bool Enabled, string Reason, Character Character, SheetCheckOption[] Checks,
    SheetEquipmentOption[] Equipment, SheetSpellOption[] Spells, SheetPreparation Preparation, string Notice, string ActionBlock = "",
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetPreparation[]? ClassPreparations = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetRestChoice[]? RestChoices = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetEffectOption[]? Effects = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetFeatureDetail[]? FeatureDetails = null,
    string RuleDetailsNotice = "",
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetItemDetail[]? ItemDetails = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetLoadoutView? Loadout = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetWearablesView? Wearables = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetWeightView? Weight = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] SheetPackOption[]? Packs = null);
public sealed record CharacterAdjustment(string Operation, string Key, int Value, string Name = "");
public sealed record AdjustCharacterRequest(string RequestId, int ExpectedVersion, string ActorId, string Rationale, string RuleSource,
    CharacterAdjustment[] Changes, string RulingId = "");
public sealed record CharacterChangeView(string Operation, string Key, string Label, string Before, string After);
public sealed record AdjustmentPreview(int Version, string ActorId, string CharacterName, CharacterChangeView[] Changes, string[] Warnings);
public sealed record PlaySpellInfo(string Id, string Name, int Level, int Page, string Casting, string Range, string Duration, string Components,
    bool Concentration, bool Ritual, string Summary);
