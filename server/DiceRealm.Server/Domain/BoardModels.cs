using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// Units survive leaving a map and ending combat. Player mechanical state lives only in Character.
public sealed class SharedBoardState
{
    public int SchemaVersion { get; init; } = 1;
    public List<BoardEntity> Entities { get; init; } = [];
    // Read-only compatibility for old saves; new commands never append operation history.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<BoardOperation>? RecentOperations { get; init; }
    public List<BoardMoveIntent> Moves { get; init; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? SelectedMaps { get; set; }
}
public sealed record BoardPoint(double X, double Y);
public sealed record BoardPlacement(string MapId, double X, double Y, bool OnMap, BoardPoint[] Path);
public sealed record BoardAppearance(string Name, string Summary = "", string IconKey = "", string Visibility = "player");
public sealed record BoardSource(string Kind, string Id = "", string EncounterId = "", string RulesId = "", string ContentVersion = "");
public sealed record BoardEntity(string Id, string Kind, BoardSource Source, BoardAppearance Appearance,
    string ActorId = "", string CharacterId = "", string FactionId = "", BoardStatistics? Statistics = null,
    Character? Character = null, BoardPlacement? Placement = null)
{
    // Explicit positions on other maps; never inferred from normalized coordinates.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, BoardPlacement>? MapPlacements { get; init; }
}
// Nullable numeric fields mean unknown, not zero. No class/level/ability scores are invented.
public sealed record BoardStatistics(
    int? HitPoints = null, int? MaxHitPoints = null, int? ArmorClass = null, int? Speed = null,
    int? InitiativeModifier = null, int? TemporaryHitPoints = null, Ability[]? Abilities = null,
    Dictionary<string, int>? SavingThrows = null, Dictionary<string, int>? Skills = null,
    string[]? Conditions = null, string[]? Features = null, string[]? Actions = null,
    Item[]? Inventory = null, Resource[]? Resources = null, Spellcasting? Spellcasting = null,
    TimedEffect[]? Effects = null, ConcentrationEffect? Concentration = null,
    string? Size = null, string? CreatureType = null, string[]? Senses = null, string[]? Languages = null,
    string[]? Resistances = null, string[]? Immunities = null, string[]? Vulnerabilities = null, string? ChallengeRating = null)
{
    public bool HasHitPoints => HitPoints.HasValue;
    public bool HasMaxHitPoints => MaxHitPoints.HasValue;
    public bool HasArmorClass => ArmorClass.HasValue;
    public bool HasSpeed => Speed.HasValue;
    public bool HasInitiativeModifier => InitiativeModifier.HasValue;
    public bool HasTemporaryHitPoints => TemporaryHitPoints.HasValue;
}
public sealed record BoardChange(string EntityId, BoardPlacement? Before, BoardPlacement? After,
    BoardAppearance BeforeAppearance, BoardAppearance AfterAppearance);
public sealed record BoardOperation(string Id, int Version, string ActorId, string Kind, BoardChange[] Changes);
public sealed record BoardMoveIntent(string Id, string EntityId, string ActorId, string SceneId,
    BoardPlacement Origin, BoardPlacement Destination, string RulingId, string Status);

// Commands are closed typed operations. Updating display text never changes rule state or provenance.
public sealed record BoardSpawn(string ExistingId, string Kind, BoardSource Source, BoardAppearance Appearance,
    double X, double Y, string ActorId = "", BoardStatistics? Statistics = null, Character? Character = null, CharacterBuild? Build = null);
public sealed record BoardCommandRequest(string RequestId, int ExpectedVersion, string MapId, string Operation,
    string EntityId = "", BoardSpawn[]? Spawns = null, BoardPoint? Destination = null, BoardPoint[]? Path = null,
    bool Snap = false, BoardAppearance? Appearance = null, string OperationId = "", int ExpectedMapVersion = 0);
public sealed record BoardCommandResult(string Status, string[] EntityIds, string OperationId, string RulingId = "", string Notice = "");
public sealed record BoardCommandResponse(BoardView Board, BoardCommandResult Result, bool Replayed);
public sealed record BoardMapView(string Id, string Title, int Version, string ContentHash, string ImageUrl,
    int Width, int Height, MapGrid Grid)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Purpose { get; init; }
}
public sealed record BoardTokenView(string Id, string Label, string Name, string Kind, string Summary, string IconKey,
    double X, double Y, bool OnMap, bool CanControl, string Visibility, int? HitPoints, int? MaxHitPoints,
    string[] Conditions, BoardPoint[] Path, string ActorId = "",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CharacterPortraitView? Portrait = null)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Size { get; init; }
    public bool HasHitPoints => HitPoints.HasValue;
    public bool HasMaxHitPoints => MaxHitPoints.HasValue;
}
public sealed record BoardChangeView(string EntityId, BoardPoint? From, BoardPoint? To, bool WasOnMap, bool OnMap);
public sealed record BoardOperationView(string Id, int Version, string Kind, string[] EntityIds, BoardChangeView[] Changes);
public sealed record BoardMoveView(string Id, string EntityId, double X, double Y, BoardPoint[] Path, string RulingId);
public sealed record BoardView(int Version, string SceneId, BoardMapView Map, BoardTokenView[] Tokens,
    BoardOperationView[] RecentOperations, BoardMoveView[] PendingMoves);
public sealed record BoardTokenDetail(int Version, string Id, string Name, string Kind, string Summary, string IconKey,
    string ActorId, string FactionId, bool CanControl, BoardStatistics? Statistics,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BoardSource? Source = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Character? Character = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CharacterPortraitView? Portrait = null)
{
    public bool HasStatistics => Statistics is not null;
}
