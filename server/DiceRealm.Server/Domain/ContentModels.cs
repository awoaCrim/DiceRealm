using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// Import format v1: data only. No scripts, expressions, URLs, or arbitrary state patches.
// Rules and supported operations stay in the engine; all fiction is supplied by the host.
public sealed record ContentCondition
{
    public string[] All { get; init; } = [];
    public string[] Any { get; init; } = [];
    public string[] None { get; init; } = [];
}
public sealed record ContentEffect(string Op, string Key = "", int Amount = 0);
public sealed record ContentOutcome(string Text, ContentEffect[] Effects);
public sealed record ContentCheck(string Ability, string Skill, int Dc);
public sealed record ContentAction
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "script.action";
    public string Target { get; init; } = "";
    public string Label { get; init; } = "";
    public ContentCondition When { get; init; } = new();
    public bool Repeatable { get; init; }
    public ContentCheck? Check { get; init; }
    public ContentOutcome Success { get; init; } = new("", []);
    public ContentOutcome Failure { get; init; } = new("", []);
    public ContentEffect[] Always { get; init; } = [];
}
public sealed record ContentExit(string Target, ContentCondition When, int Seconds = 600);
public sealed record ContentVariant(ContentCondition When, string Title, string Summary, string ImagePrompt);
public sealed record ContentScene
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string Summary { get; init; } = "";
    public string Arrival { get; init; } = "";
    public string ImagePrompt { get; init; } = "";
    public float X { get; init; } = .5f;
    public float Y { get; init; } = .5f;
    // Prepared scenes have no authored position evidence. The default keeps old document
    // fingerprints byte-identical; prepared scenes set it true and are not drawn on a map.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Unlocated { get; init; }
    public bool SafeRest { get; init; }
    public bool PreGenerate { get; init; }
    public ContentExit[] Exits { get; init; } = [];
    public ContentAction[] Actions { get; init; } = [];
    public ContentVariant[] Variants { get; init; } = [];
    public ContentEncounter? Encounter { get; init; }
}
public sealed record ContentItem(string Id, string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RulesId = null);
public sealed record ContentObjective(string Text, ContentCondition Complete)
{
    // Null keeps legacy objectives public and their serialized content fingerprint unchanged.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ContentCondition? Visible { get; init; }
}
public sealed record ContentQuest(string Id, string Title, string Summary, string Reward, ContentCondition Visible,
    ContentCondition Active, ContentCondition Complete, ContentObjective[] Objectives);
public sealed record ContentNpc(string Id, string Name, string SceneId, string FactionId, string Summary,
    ContentCondition Visible, ContentCondition Met, ContentLocation[] Locations);
public sealed record ContentLocation(ContentCondition When, string SceneId);
public sealed record ContentAdjustment(ContentCondition When, int Amount);
public sealed record ContentFaction(string Id, string Name, ContentCondition Visible, ContentAdjustment[] Adjustments);
public sealed record ContentBranch(string Id, string Choice, string Label, ContentCondition When);
public sealed record ContentEnemy(string Id, string Name, int X, int Y, int HitPoints, int ArmorClass, int Speed,
    int InitiativeModifier = 1, int AttackBonus = 3, int DamageDice = 1, int DamageDie = 4, int DamageBonus = 1,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Tactic = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RulesId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Dictionary<string, int>? SavingThrows = null);
public sealed record ContentEncounter
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public string StartLabel { get; init; } = "";
    public ContentCondition When { get; init; } = new();
    public bool Repeatable { get; init; }
    public bool Nonlethal { get; init; } = true;
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mode { get; init; }
    public ContentEnemy[] Enemies { get; init; } = [];
    public BattleCell[] Cells { get; init; } = [];
    public ContentEffect[] OnStart { get; init; } = [];
    public ContentOutcome Victory { get; init; } = new("", []);
}
// Non-mechanical opening knowledge prepared from the host's own text. It carries no reward,
// fact, HP, inventory, DC or combat parameter and is seeded as public world memory on activation.
public sealed record InitialKnowledgeEntry(string Id, string Kind, string Name, string Summary, string SceneId,
    string Visibility, string RevealSceneId = "");
public sealed record AdventureDocument
{
    public int FormatVersion { get; init; } = 1;
    public string Id { get; init; } = "";
    public string Version { get; init; } = "";
    public string Name { get; init; } = "";
    public string StartSceneId { get; init; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ContentOpening? Opening { get; init; }
    public string SourceText { get; init; } = "";
    public string StyleProfile { get; init; } = "";
    public string[] VisualConstraints { get; init; } = [];
    public ContentCondition? Level2Milestone { get; init; }
    public ContentScene[] Scenes { get; init; } = [];
    // Null is omitted from serialization so documents authored before this field keep their
    // exact content binding fingerprint; legacy saves deserialize it as absent.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public InitialKnowledgeEntry[]? InitialKnowledge { get; init; }
    public ContentItem[] Items { get; init; } = [];
    public ContentQuest[] Quests { get; init; } = [];
    public ContentNpc[] Npcs { get; init; } = [];
    public ContentFaction[] Factions { get; init; } = [];
    public ContentBranch[] Branches { get; init; } = [];
}
public sealed record ContentBinding(string Id, string Version, string Name, string Hash);
public sealed record CampaignContentView(string Status, ContentBinding? Adventure, ContentBinding? Prompts, string Message, bool OfflineTrial = false,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)] bool InitialSetup = false);
public sealed record PromptRevision(ContentBinding Binding, PromptBundle Document, DateTimeOffset? SavedAt);
public sealed record PromptCallTrace(string Purpose, ContentBinding Binding, string Outcome);
