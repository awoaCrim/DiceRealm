using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

public sealed record Ability(string Name, int Score, int Modifier);
public sealed record HarnessSceneNarrationState(string SceneId, int Version);
public sealed record Item(string Id, string Name, int Quantity, bool Equipped,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RulesId = null);
public sealed record CharacterEquipmentStatus(string Armor, string Current, string Reserve, string[] Issues, string[] ArmorClassSources);
public sealed record Resource(string Name, int Current, int Maximum, string Recovery = "long", string Description = "", string Source = "XPHB");
public sealed record Character(
    string Id, string Name, string TemplateId, string Species, string ClassName,
    string Background, int Level, int HitPoints, int MaxHitPoints, int ArmorClass,
    int ProficiencyBonus, Ability[] Abilities, string[] Skills, Item[] Inventory,
    string[] Conditions, string[] Features, Resource[] Resources, string Source,
    Spellcasting? Spellcasting = null, TimedEffect[]? Effects = null, long NextLongRestAtSeconds = 0, string[]? Expertise = null, bool ShortRestDiceAvailable = false, CharacterCreationChoices? Creation = null, CharacterBuild? Build = null, BuildMechanics? BuildMechanics = null, CharacterPlayState? PlayState = null, int TemporaryHitPoints = 0, int Exhaustion = 0,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CharacterAdvancement? Advancement = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ConcentrationEffect? Concentration = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CharacterEquipmentStatus? EquipmentStatus = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CharacterPortraitView? Portrait = null);
public sealed record ConcentrationEffect(string SpellId, string Source, long ExpiresAtSeconds);
public sealed record ActionDetails(string TargetLabel, string Cost, string Range, string Note = "", string UnavailableReason = "");
// Area: where an area spell lands (cell, radius in cells, the units it reaches as this player sees them),
// for the page's map preview. The choice's note stays the disclosure; the model's candidates omit it.
public sealed record ActionChoice(string Kind, string Target, string Label, ActionDetails? Details = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ActionArea? Area = null);
public sealed record ActionArea(int X, int Y, int Radius, string[] Targets);
public sealed record SceneView(string Id, string Title, string Summary, string AssetId, bool Visited);
public sealed record DiceCheck(
    string Ability, string Skill, int[] Rolls, int Selected, int Modifier, int Total,
    int Dc, bool Success, string Mode, string Ruleset = "dnd2024", string Source = "XPHB", int[]? BonusRolls = null, string BonusSource = "", bool HasDc = true, string TestKind = "ability",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int[]? DifficultyClasses = null);
public sealed record Resolution(
    string Status, string Kind, string Summary, DiceCheck? Check, string[] Changes,
    string RulingId = "", CombatEntry[]? CombatLog = null, string ContentActionId = "", string RollId = "", string IntentId = "");
public sealed record GameEvent(
    string Id, int Sequence, string Kind, string Text, string Narrative,
    string NarrativeSource, DateTimeOffset CreatedAt, Resolution? Resolution, string ActorId = "player", PromptCallTrace[]? PromptCalls = null, ActionOrigin? Origin = null, string ReviewActorId = "", bool HostOnly = false, string PrivateText = "",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] PrivateStoryPart? PrivatePart = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] PrivateStoryMessage[]? PrivateMessages = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] PrivateStoryPart[]? PrivateParts = null);
public sealed record PendingRuling(string Id, string Text, string Status, string Reason,
    string ActorId = "player", string SceneId = "", string CombatId = "", string Outcome = "",
    string Rationale = "", string RuleSource = "", string ResolvedBy = "", DateTimeOffset? ResolvedAt = null, DiceCheck? Check = null,
    string EffectsRequestId = "", CharacterChangeView[]? Effects = null, int OriginSequence = 0, StorySettlement? Story = null, string PrivateText = "",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? BoardMoveId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] PrivateStoryPart? PrivatePart = null);
public sealed record SceneAsset(
    string Id, string SceneId, string CampaignId, string LocationId, string SceneType,
    string Title, string Summary, string Status, string PromptBase, string PromptVariant,
    string[] ReferenceImages, string StyleProfile, string[] VisualConstraints,
    string ImageUrl, string ContentHash, string FallbackAssetId, int Version,
    string Error, int Attempts, DateTimeOffset? RetryAfter,
    string ProviderIdentity = "", string LeaseId = "", string FailureId = "");
public sealed record RetrySceneAssetRequest(string FailureId);
public sealed record ReferenceImage(string Id, string Name, int ByteLength, DateTimeOffset CreatedAt);
public sealed record ReviseSceneAssetRequest(
    string ExpectedAssetId, string PromptVariant, string StyleProfile,
    string[] VisualConstraints, string[] ReferenceImages);
public sealed record MapNode(string Id, string Title, string State, bool CanTravel, string Hint, float X, float Y,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Unlocated = false);
public sealed record MapEdge(string From, string To);
public sealed record ExplorationMap(string Title, MapNode[] Nodes, MapEdge[] Edges);
public sealed record CampaignSnapshot(
    string Id, string Name, string Ruleset, int Version, int Chapter,
    Character? Character, SceneView Scene, ActionChoice[] AvailableActions,
    GameEvent[] Events, string[] Facts, string[] VisitedScenes,
    PendingRuling[] PendingRulings, SceneAsset SceneAsset, ExplorationMap Map, CombatState? Combat = null, int ElapsedMinutes = 0, WorldView? World = null, long ElapsedSeconds = 0, PartyView? Party = null, bool Archived = false, CampaignContentView? Content = null, ActionChoice[]? ActionOptions = null, PendingRollView? PendingRoll = null, PendingIntentView? PendingIntent = null, WorldMemoryEntry[]? WorldMemory = null, AdventureCorrection[]? AdventureCorrections = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] WorldMemoryPaging? WorldMemoryPaging = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SharedStory[]? SharedStories = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AdventureOpeningView? Opening = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TimelineId = null,
    CampaignLifecycle? Lifecycle = null);
public sealed record CreateCampaignRequest(string Name, string CharacterName = "", string TemplateId = CharacterEngine.Fighter, AdventureDocument? Adventure = null, PromptBundle? Prompts = null, bool StartImmediately = false, CharacterCreationChoices? Creation = null, CharacterBuild? Build = null);
public sealed record CreatedCampaign(string AccessToken, CampaignSnapshot Snapshot);
public sealed record ActionRequest(
    string RequestId, int ExpectedVersion, string Kind, string Target = "", string Text = "");
public sealed record ActionResponse(CampaignSnapshot Snapshot, Resolution Resolution, bool Replayed,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SharedStory? SharedStory = null);
public sealed record ActionReceipt(string RequestId, string Fingerprint, Resolution Resolution, string ActorId = "player",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] System.Text.Json.JsonElement? HarnessOutput = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BoardCommandResult? BoardOutput = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BoardOperation[]? BoardHistory = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SharedStory? SharedStoryOutput = null);

// The persistence aggregate is private to the server. Never serialize it to a client.
public sealed class Campaign
{
    public int SchemaVersion { get; init; } = 1;
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string Ruleset { get; init; } = "dnd2024";
    public required string TokenHash { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? OwnerUserId { get; init; }
    // Request-local secret for stable account room-command fingerprints; never persisted.
    [JsonIgnore] internal byte[]? AccountRoomFingerprintKey { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? TimelineId { get; set; }
    public int Version { get; set; } = 1;
    public int Chapter { get; set; } = 1;
    public bool Archived { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool GameEnded { get; set; }
    public required Character? Character { get; set; }
    // Missing/false retains legacy host-player saves. True explicitly records a DM-only seat.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool HostOnlySeat { get; init; }
    public CharacterReview? HostReview { get; set; }
    public List<PartyMember> PartyMembers { get; init; } = [];
    public List<PartyInvite> Invitations { get; init; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public RoomSettings? Room { get; set; }
    // Request-local actor context: never persisted or substituted into the leader character.
    [JsonIgnore] public string ActingActorId { get; set; } = PartyEngine.HostId;
    [JsonIgnore] public Character ActingCharacter
    {
        get => PartyEngine.CharacterFor(this, ActingActorId);
        set => PartyEngine.SetCharacter(this, ActingActorId, value);
    }
    [JsonIgnore] public PendingAbilityCheck? ActingPendingAbilityCheck
    {
        get => PartyEngine.IsHost(this) ? PendingAbilityCheck : PartyMembers.Single(m => m.Id == ActingActorId).PendingAbilityCheck;
        set { if (PartyEngine.IsHost(this)) PendingAbilityCheck = value; else PartyMembers.Single(m => m.Id == ActingActorId).PendingAbilityCheck = value; }
    }
    public AdventureDocument? Adventure { get; set; }
    public PromptBundle? Prompts { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public HarnessProfile? Harness { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool InitialAdventureSetup { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] public bool HarnessWorkspaceInitialized { get; set; }
    public List<PromptRevision> PromptRevisions { get; init; } = [];
    public bool OfflineTrial { get; init; }
    public string TrialSourceId { get; init; } = "";
    public string TrialFingerprint { get; init; } = "";
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public AdventureOpeningState? Opening { get; set; }
    public bool ContentActivated { get; set; }
    public List<string> CompletedContentActions { get; init; } = [];
    public List<string> AttemptedEncounters { get; init; } = [];
    public CombatState? Combat { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<RuntimeEncounter>? RuntimeEncounters { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<CombatAgentSession>? CombatAgentSessions { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public SharedBoardState? Board { get; set; }
    // Authorized actual image metadata supplied by Application inside the campaign gate.
    [JsonIgnore] public MapAssetView? BoardMapContext { get; set; }
    // Explicit state-only versions in this transaction, never persisted as operation history.
    // Save merges these with event versions to keep detecting accidental missing writes.
    [JsonIgnore] internal List<int> StateOnlyVersions { get; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public StandardCombatFlow? StandardCombatFlow { get; set; }
    public PendingAbilityCheck? PendingAbilityCheck { get; set; }
    public int ElapsedMinutes { get; set; }
    public long ElapsedSeconds { get; set; }
    public string SceneId { get; set; } = "";
    public List<string> Facts { get; init; } = [];
    public List<string> VisitedScenes { get; init; } = [];
    public List<PendingRuling> PendingRulings { get; init; } = [];
    public List<PendingRoll> PendingRolls { get; init; } = [];
    public List<PendingIntent> PendingIntents { get; init; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<StorySupply>? StorySupplies { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public HarnessSceneNarrationState? HarnessSceneNarration { get; set; }
    public List<WorldMemoryEntry> WorldMemory { get; init; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? WorldMemoryStorageVersion { get; set; }
    [JsonIgnore] public IWorldMemoryIndex? WorldMemoryIndex { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public WorldAtlas? WorldAtlas { get; set; }
    // Sharing changes knowledge, not the mechanical version used by rolls and frozen Runs.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<SharedStory>? SharedStories { get; set; }
    public List<AdventureCorrection> AdventureCorrections { get; init; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<AdvancementAward>? AdvancementAwards { get; set; }
    public List<GameEvent> Events { get; init; } = [];
    public List<ActionReceipt> Receipts { get; init; } = [];
}

public sealed class GameException(string code, string message, int status = 400) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}
