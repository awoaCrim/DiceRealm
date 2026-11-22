using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// Cartographic metadata, not game rules. Pixels and scale never grant movement or reveal nodes.
public sealed record MapGrid
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Uncalibrated { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MapScaleBasis? ScaleBasis { get; init; }
    public string Type { get; init; } = "none";
    public double CellPixels { get; init; } = 64;
    public double OffsetX { get; init; }
    public double OffsetY { get; init; }
    public double Distance { get; init; } = 5;
    public string Units { get; init; } = "feet";
}
public sealed record MapScaleBasis(string Kind, string Detail);
public sealed record MapSpecification
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Purpose { get; init; }
    public string Title { get; init; } = "";
    public string Kind { get; init; } = "region";
    public string Edition { get; init; } = "gm";
    public string Prompt { get; init; } = "";
    public int Width { get; init; } = 1536;
    public int Height { get; init; } = 1024;
    public MapGrid Grid { get; init; } = new();
    public string[] ReferenceImages { get; init; } = [];
    // Presence identifies a locally supplied original, including its pre-upload draft.
    // These fields are author-provided public provenance, not a prompt or a fetch instruction.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MapImportSource? ImportSource { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MapStyleReference? StyleReference { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MapGenerationBasis? GenerationBasis { get; init; }
}
public sealed record MapImportSource
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SourceUrl { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? VisualStyle { get; init; }
}
// A frozen appearance-only reference; its source must have been a published player original.
public sealed record MapStyleReference(string MapId, string Title, string VisualStyle)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MapStyleSnapshot? Snapshot { get; init; }
}
public sealed record MapAdventureSource(string Id, string Version, string Hash);
public sealed record MapLibrarySource(MapAdventureSource Adventure, string LibraryId, string PackageHash, string File, string ContentHash);
public sealed record MapStyleSnapshot(int Version, string ContentHash, MapAdventureSource Adventure, string ReferenceMode);
public sealed record MapSpaceRecord(string Id, int Revision, string Source, string Name, string Summary);
public sealed record MapPublicExit(string SceneId, string Title, string Source, string RouteId, int Revision);
// Frozen, host-only input basis. Public clients receive only MapProvenance below.
public sealed record MapGenerationBasis(MapAdventureSource Adventure, string SceneId, int StateVersion,
    string Title, string Summary, MapSpaceRecord[] Places, MapPublicExit[] Exits);
public sealed record MapProvenance(string Kind, string ReferenceMode, string Layout);
public sealed record CreateMapRequest(string RequestId, MapSpecification Specification);
public sealed record GenerateMapRequest(string RequestId, int ExpectedVersion, bool ConfirmProviderUse);
public sealed record ImportMapRequest(string RequestId, int ExpectedVersion);
public sealed record PublishMapRequest(string RequestId, int ExpectedVersion, bool Published, bool ConfirmPlayerVisibility);
public sealed record ConfigureMapGridRequest(string RequestId, int ExpectedVersion, MapGrid Grid,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Purpose = null);
public sealed record ConfigureMapScenesRequest(string RequestId, int ExpectedVersion, string[] SceneIds);
public sealed record ConfigureMapMarkersRequest(string RequestId, int ExpectedVersion, MapMarker[] Markers);
// Normalized coordinates measured against actual image pixels, not requested generation dimensions.
public sealed record MapMarker(string Id, string Kind, string TargetId, double X, double Y, string Visibility);
public sealed record MapMarkerOption(string Kind, string TargetId, string Label, bool PlayerVisible);
public sealed record MapMarkerView(string Id, string Kind, string TargetId, double X, double Y, string Visibility,
    string Label, string Summary, string State);
public sealed record MapSceneOption(string Id, string Title);
// Public capability/state only: never include an unpublished map ID or generation inputs.
public sealed record SceneMapStatus(
    [property: JsonRequired] string SceneId,
    [property: JsonRequired] string Status,
    [property: JsonRequired] bool GenerationEnabled);
public sealed record MapAssetView(string Id, string Title, string Kind, string Edition, int Version, string Status,
    bool Published, int RequestedWidth, int RequestedHeight, int Width, int Height, MapGrid Grid,
    string ImageUrl, string ContentHash, string Error, int Attempts, DateTimeOffset CreatedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] MapSpecification? Specification = null,
    bool CurrentScene = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? SceneIds = null)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MapImportSource? ImportSource { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MapProvenance? Provenance { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Purpose { get; init; }
    public MapMarkerView[] Markers { get; init; } = [];
    // Derived from current public knowledge and authored image anchors; never round-trip these
    // through the manual marker editor or persist them as independent map metadata.
    public MapMarkerView[] AutomaticMarkers { get; init; } = [];
}
public sealed record MapLibraryView(MapAssetView[] Maps, bool CanManage, bool GenerationEnabled,
    string[] Kinds, string[] GridTypes, int MaximumDimension = 8192, long MaximumPixels = 33554432,
    string Note = "AI 可按需申请当前公开地点示意图，完成后自动显示；浏览不发起生成。手工重新生成仍须确认，未标定地图不能测距，图片不改变游戏规则。",
    string CurrentSceneId = "",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] MapSceneOption[]? SceneOptions = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] MapMarkerOption[]? MarkerOptions = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SceneMapStatus? Status = null)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SelectedMapId { get; init; }
}
public sealed record MapImageFile(string Path, string Hash);
public sealed record MapGenerationJob(string Id, string CampaignId, string LeaseId, string ProviderIdentity,
    MapSpecification Specification, int Attempt)
{
    [System.Text.Json.Serialization.JsonIgnore] public Action? BeforeProviderRequest { get; init; }
}
