using System.Text.Json;
using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// Acquisition history is separate from the immutable level-one Build and live counters.
// New drafts contain choices only: never HP, slots, proficiency, or other derived values.
public sealed record AdvancementDraft
{
    public string Revision { get; init; } = BuildCatalog.Revision;
    public string ClassId { get; init; } = "";
    public string SubclassId { get; init; } = "";
    public BuildSelection[] Selections { get; init; } = [];
}
public sealed record AdvancementClass(string ClassId, int Level, string SubclassId, string[] Cantrips,
    string[] PreparedSpells, string[] Spellbook, string[] OptionalFeatures,
    string[]? Masteries = null, AdvancementBonusSpell[]? BonusSpells = null, BuildSelection[]? Choices = null);
public sealed record AdvancementBonusSpell(string Id, string Mode, string Origin, string Ability = "", int Uses = 0,
    string Recovery = "long", string Resource = "", string Condition = "");
public sealed record AdvancementStep(int CharacterLevel, string ClassId, int ClassLevel, string SubclassId,
    int HitPointIncrease, string[] Features, AdvancementDraft Choices);
public sealed record CharacterAdvancement(int SchemaVersion, string Revision, AdvancementClass[] Classes, AdvancementStep[] Steps,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AdvancementFeatSource[]? FeatSources = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AdvancementRetiredResource[]? RetiredResources = null);
public sealed record AdvancementFeatSource(string Id, string[] Feats, string[] Skills, string[] Expertise, string[] Tools, string[] Weapons);
public sealed record AdvancementRetiredResource(string Name, int Current, int Maximum, long RestBoundary);
public sealed record AdvancementPreview(bool CanApply, int FromLevel, int ToLevel, BuildIssue[] Issues,
    BuildGroup[] Groups, Character? Character, string[] Notices);

public sealed record AdvancementCatalogData(int SchemaVersion, string Ruleset, string Source, string Revision,
    AdvancementEvidence[] Evidence, int[] Experience, int[] Proficiency, int[][] FullCasterSlots,
    AdvancementClassData[] Classes, AdvancementSubclassData[] Subclasses, AdvancementFeatureData[] Features,
    AdvancementFeatData[] Feats, AdvancementOptionalData[] OptionalFeatures, AdvancementSpellData[] Spells,
    AdvancementLineageSpell[] LineageSpells);
public sealed record AdvancementLineageSpell(string SpeciesId, string LineageId, int Level, string SpellId);
public sealed record AdvancementEvidence(string Path, string Sha256);
public sealed record AdvancementTable(string[] ColLabels, JsonElement[][]? Rows = null, int[][]? RowsSpellProgression = null);
public sealed record AdvancementClassData(string Id, string Name, int HitDie, JsonElement PrimaryAbility,
    JsonElement MulticlassProficiencies, string[] Features, AdvancementTable[] Tables,
    string CasterProgression = "", string SpellcastingAbility = "", int[]? CantripProgression = null,
    int[]? PreparedSpellsProgression = null, int[]? SpellsKnownProgressionFixed = null,
    JsonElement OptionalfeatureProgression = default, JsonElement AdditionalSpells = default);
public sealed record AdvancementSubclassData(string Id, string ClassId, string Name, string[] Features,
    AdvancementTable[] Tables, string CasterProgression = "", string SpellcastingAbility = "",
    int[]? CantripProgression = null, int[]? PreparedSpellsProgression = null,
    JsonElement OptionalfeatureProgression = default, JsonElement AdditionalSpells = default);
public sealed record AdvancementFeatureData(string Id, string Name, int Level, int Page,
    AdvancementLink[] Links, JsonElement Mechanics);
public sealed record AdvancementLink(string Ref = "", string Optional = "", string Key = "", int Count = 0,
    AdvancementLink[]? Options = null);
public sealed record AdvancementFeatData(string Id, string Name, string Category, int Page, JsonElement Mechanics);
public sealed record AdvancementOptionalData(string Id, string Name, string[] Types, int Page, JsonElement Mechanics);
public sealed record AdvancementSpellData(string Id, string Name, int Level, string School, string[] Classes, bool DealsDamage,
    int Page, bool ActionCasting, bool Ritual, bool SpellAttack, string Casting, JsonElement Range, JsonElement Duration, JsonElement Components);
