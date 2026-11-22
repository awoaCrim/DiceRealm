using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// Private per-model-slot projection, not a client command, a model assertion or a new game
// state store. Saved with started before outbound I/O; replay never reacquires its references.
public sealed record HarnessExecutionFrame(string Kind, int Contract, int Version, string Phase,
    AdventureContext Context, JsonElement? Combat, string[] AvailableTools,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessCharacterContext? Self = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    SceneMapStatus? Map = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessSceneContext? WorkingContext = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    bool? DetailedSelf = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessWorkingMemory? WorkingMemory = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessScenePresentation? ScenePresentation = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    bool? HasImportedSkills = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessSupplyContext? Supplies = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessBoardContext? Board = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessDmChecklist? DmChecklist = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessAgentContext? Agent = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessSharedStories? SharedStories = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? NarrativeContract = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessOpeningContext? Opening = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessKnownInformation? KnownInformation = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessHistoryContext? History = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    HarnessReadPreload? ReadPreload = null)
{
    // Same-gate sources/catalog for preparation only. The final selection above is persisted.
    [System.Text.Json.Serialization.JsonIgnore]
    public HarnessHistoryCapture? HistoryCapture { get; init; }
    // An oversized provisional history is never sent as required-only. Preparation must
    // replace it with a complete valid selection or fail before generation.
    [System.Text.Json.Serialization.JsonIgnore]
    public bool HistoryPreparationRequired { get; init; }
}

// Only the current visited scene's public presentation, never source text or image prompts.
public sealed record HarnessScenePresentation(string SceneId, string Title, string CurrentSummary, string Arrival, string Notice,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? ArrivalStatus = null);

public static class HarnessExecutionProtocol
{
    public const int Version = 15;
    public const int MinimumMapToolVersion = 22;
    public static HarnessExecutionFrame Capture(int version, AdventureContext context, JsonElement? combat,
        HarnessCharacterContext? self = null, int toolContractVersion = Version, SceneMapStatus? map = null,
        HarnessSceneContext? workingContext = null, bool? detailedSelf = null, HarnessWorkingMemory? workingMemory = null,
        HarnessScenePresentation? scenePresentation = null, bool? hasImportedSkills = null, HarnessSupplyContext? supplies = null, HarnessBoardContext? board = null, HarnessAgentContext? agent = null) =>
        new("execution_state", Version, version, "ready", context, combat,
            HarnessTools.ForVersion(toolContractVersion >= HarnessCharacterContext.MinimumToolVersion ? toolContractVersion : Version).Where(t => (toolContractVersion < 36 || HarnessAgentContexts.Allows(t.Name, agent?.Role == "combat")) &&
                (agent?.Command is null || HarnessCombatCommands.Allows(t.Name)) && (t.Name switch
            {
                "opening_commit" => false,
                "combat_delegate" => (toolContractVersion < 39 || agent?.CombatPromptReady == true) &&
                    (toolContractVersion < 47 || agent?.EncounterId is not null),
                "skills_list" or "skills_read" => toolContractVersion < 24 || hasImportedSkills == true,
                "actions_propose" => context.Intent.Candidates.Length > 0,
                "combat_continue" => agent?.Narration?.CanContinue == true,
                "ask_player" or "ruling_request" => agent?.Narration is not { Pending: true } and not { CanContinue: true },
                "world_record" => context.CanNarrate,
                "map_request" => toolContractVersion >= 42 ? map is { GenerationEnabled: true, SceneId.Length: > 0 }
                    : toolContractVersion < MinimumMapToolVersion || map is { Status: "missing", GenerationEnabled: true },
                "map_select" => board?.Maps is { Length: > 0 },
                _ => true
            })).Select(t => t.Name).ToArray(), self, map, workingContext, detailedSelf, workingMemory, scenePresentation, hasImportedSkills, supplies, board, Agent: agent);

    public static HarnessModelRequest Project(HarnessModelRequest request, HarnessExecutionFrame frame, int toolContractVersion = Version)
    {
        Validate(frame, frame.Version, toolContractVersion);
        var tools = request.Tools.Where(t => frame.AvailableTools.Contains(t.Name, StringComparer.Ordinal)).Select(t => toolContractVersion >= 36 ? HarnessAgentContexts.Present(t, frame.Agent?.Role == "combat", toolContractVersion) : t).Select(t =>
        {
            if (t.Name != "actions_propose") return t;
            var schema = JsonNode.Parse(t.InputSchema.GetRawText())!.AsObject();
            schema["properties"]!["candidateId"]!["enum"] = new JsonArray(frame.Context.Intent.Candidates.Select(c => JsonValue.Create(c.Id)).ToArray<JsonNode?>());
            return t with { InputSchema = HarnessJson.Element(schema) };
        }).ToArray();
        // This frame is appended only to this provider request, never to the SDK transcript.
        // It is a structured server projection, not a replacement system prompt.
        var messages = toolContractVersion >= 23 ? HarnessProviderContext.Messages(request.Messages, frame) : request.Messages;
        return request with { Tools = tools, Messages = [.. messages, new("user", HarnessProviderJson.Serialize(toolContractVersion >= 23 ? (object)HarnessProviderContext.Frame(frame, toolContractVersion) : frame))
            { Images = frame.Board?.Images.Select(i => new HarnessImage(i.MediaType, i.Base64)).ToArray() ?? [] }] };
    }

    public static bool RequiresFrame(string tool) => tool is "combat_continue" or "opening_commit" or "combat_delegate" or "encounter_prepare" or "encounter_engage" or "check_request" or "actions_propose" or "world_record" or "world_route_propose" or "map_request" or "map_select" or "ruling_request" or "token_spawn" or "token_move" or "token_update" or "token_remove";

    public static HarnessToolOutcome RefreshRequired(int version) => new(version, new(HarnessJson.Serialize(new
    {
        protocol = new { contract = Version, phase = "refresh_required", version, applied = false, next = "model", wait = (HarnessWait?)null }
    })));

    public static HarnessToolOutcome WorldRecordRejected(int version, string reason) => new(version, new(HarnessJson.Serialize(new
    {
        code = "invalid_world_memory", reason,
        guidance = "This world_record saved nothing. Correct the proposal and submit a new tool call. For new objects use id:\"\"; never invent IDs. Updates require a supplied current public ID of the same kind; do not recreate known objects. Use only known public sceneIds, or leave sceneId empty for unknown locations. Do not repeat completed actions.",
        protocol = new { contract = Version, phase = "ready", version, applied = false, next = "model", wait = (HarnessWait?)null }
    }), IsError: true));

    public static HarnessToolOutcome ArgumentsRejected(int version, string tool, string code, string reason, int toolContractVersion = 33) => new(version, new(HarnessJson.Serialize(new
    {
        code, reason,
        guidance = toolContractVersion >= 47 && tool == "combat_delegate"
            ? "Nothing delegated, saved or rolled. Preserve the attack intent and all settled checks. Read the current encounter: layout=null requires a ready calibrated local map, actual party placements and encounter_prepare with the SAME encounterId/roster before delegation. Reuse an existing suitable board.maps entry, map_select it and use its next exact image. Only if no suitable map exists request one tactical map; the server awaits that same job. Do not rebuild enemies, reroll perception/Stealth, poll pending images with model calls or claim combat began."
            : toolContractVersion >= 47 && tool == "check_request" && code == "check_already_requested"
            ? "Nothing saved or rolled. This actor already has this task's result. Use checks_result scope=scene and encounter_read, then continue from that result. A new input, rephrased citation, ability/DC/mode change, map switch or layout binding does not permit another attempt. Do not substitute an unopposed check to reveal concealed creatures. Independent saving throws and combat Search keep their own rules."
            : toolContractVersion >= 44 && tool == "encounter_prepare" && code == "encounter_source_unavailable"
            ? "Nothing saved or rolled. Fix the source citation, not the map scale: use the exact supplied current scene/evidence ID and ONE continuous verbatim substring from that source. Do not join separate sentences, add ellipses, paraphrase, invent an ID or cite model narration. Keep any valid selected map and placements; only prepare after the corrected non-model evidence actually supports this encounter. Do not repeat settled setup or dice."
            : toolContractVersion >= 42 && tool == "map_select"
            ? "Nothing saved or moved. Select a current-scene published player map from the next fresh board.maps using its exact id/version. Active combat keeps its frozen map. Never move units or guess another image to bypass this rejection."
            : toolContractVersion >= 46 && tool == "encounter_prepare"
            ? "Nothing saved or rolled. For initial perception setup OMIT encounterId, use terrain=[], and retain the supplied current map even if uncalibrated/non-tactical. Use actual scene evidence, grounded normalized positions and hidingCover/hidingReason; map calibration is not required. Never skip required perception or reroll settled NPCs. Only an existing encounterId requests tactical binding: retain the original source/quote and roster order/name/rulesId/tactic, omit hiding fields, use a calibrated tactical map and explicit terrain/grounded positions for the same instances. Read encounter_read for saved state."
            : toolContractVersion >= 42 && tool == "encounter_prepare"
            ? "Nothing saved or rolled. Use the selected calibrated tactical map's actual scale; there are no grid/pixel arguments. Reuse a suitable board.maps option with map_select, or request one local tactical map despite a ready town/region map. Explicitly place the SAME existing instances at grounded new-map positions without changing their old-map positions or HP/resources, then prepare only once."
            : tool == "context_read"
            ? "Nothing saved. context/scene/character reads accept no nonempty query or pagination. Query filters items only. The current scene/DM evidence is already in the frame; inspect it before another read. Correct the arguments in a new call; do not end the player action because of this rejected read."
            : tool == "check_request"
            ? toolContractVersion >= 44
                ? "Nothing saved. Use checkType ability/save (save requires empty skill), a matching standard ability/skill and an exact continuous quote/sourceId from current non-model scene evidence. An explicit quoted DC must match. Otherwise choose an ordinary narrative DC 5..30 before rolling with a private reason (max500); no human ruling is required merely because a DC was not prewritten. Omit DC only for a useful raw number, never to defer deciding success/failure. Runtime opposition instead requires the saved encounterId and its exact sourceId/quote, ability wisdom/Perception and NO dc; ordinary checks cannot discover its hidden units. Only ability Perception supports passive. check_already_requested means keep the saved result, never alter reason/DC/mode or active/passive to reroll. Respect pending/state restrictions and the actual actor's confirmation."
                : toolContractVersion >= 35
                ? "Nothing saved. Runtime opposition uses the established encounterId and its exact sourceId/quote, wisdom/Perception, and no numeric dc. Read saved results instead of rerolling. Otherwise numeric DC must be explicitly sourced; missing unsupported mechanics need a concrete ruling."
                : toolContractVersion >= 34
                ? "Nothing saved. Correct the source and matching ability/skill. A numeric DC must be explicitly written as DC N in the quoted source. Missing required opposition goes to ruling_request before dice; omitting DC gives only an unopposed number, not success/failure. Retain existing results, never reroll."
                : "Nothing saved. Use a standard matching ability/skill, DC 5..30 and an exact quote/sourceId from the current supplied scene or non-model evidence. Only Perception supports passive. An already requested check must use its existing result, never a different threshold or active/passive reroll. A context restriction must be addressed, not narrated away."
            : "Nothing saved. Correct only the invalid tool arguments against the supplied schema and current evidence, then issue a new call. Do not repeat settled actions or invent identifiers.",
        protocol = new { contract = Version, phase = "ready", version, applied = false, next = "model", wait = (HarnessWait?)null }
    }), IsError: true));

    public static HarnessToolOutcome BoardProposalRejected(int version, string code, string reason) => new(version, new(HarnessJson.Serialize(new
    {
        code, reason,
        guidance = "Nothing was saved. Correct the board command and send a NEW call. For a new instance existingId must be empty. A Character/self.id is not a Board entity id; player source.id and actorId use the supplied actor id. Existing instances require exact offered Board ids. Do not invent identifiers, duplicate settled steps or claim arrival from this failed proposal.",
        protocol = new { contract = Version, phase = "ready", version, applied = false, next = "model", wait = (HarnessWait?)null }
    }), IsError: true));

    public static HarnessToolOutcome InventoryRejected(int version, string reason, int toolContractVersion = 18) => new(version, new(HarnessJson.Serialize(new
    {
        code = "invalid_story_items", reason,
        guidance = toolContractVersion >= 26
            ? "Nothing saved, including narrative and memories. Use ranked item search for identity only, not local presence. Stock/immediate acquisition source.detail must quote pre-existing imported current scene or offered public preparation/dm evidence; model narration cannot prove itself. Do not rewrite cited source records. Remove unsupported item claims instead of inventing evidence. Existing stock still requires its supply id, permission and balance; no historical backfill."
            : toolContractVersion >= 25
            ? "Nothing saved. Correct identity/source/quantity. Standard names and aliases need catalog IDs, never custom props after a failed lookup. Recorded stock requires source.kind=supply and its supplied id, allowed permission and sufficient remaining. Same-call new stock can use empty supply id only with one matching declaration. Do not backfill historical grants or repeat completed acquisitions."
            : toolContractVersion >= 23
            ? "Nothing saved. Check the current delivery source, exact item identity and this action total. Use context_read scope=items for IDs. Past prose, rules and promises do not qualify; do not backfill old missing inventory. Unknown quantity: ask. Submit a corrected new call only for actual acquisition now."
            : "This world_record saved nothing. Fix the itemId/name/quantity and submit a new call. Catalog IDs require empty name; custom props require empty itemId. Quantity is total acquired in this action; do not grant an already recorded acquisition again or invent missing quantities.",
        protocol = new { contract = Version, phase = "ready", version, applied = false, next = "model", wait = (HarnessWait?)null }
    }), IsError: true));

    public static HarnessToolOutcome Describe(HarnessToolOutcome result, int priorVersion)
    {
        // Object results retain their established fields. Plain arrays are read-only data,
        // not transitions, and need no duplicated status envelope.
        var root = JsonNode.Parse(result.Reply.Content);
        if (root is not JsonObject obj) return result;
        obj["protocol"] = JsonSerializer.SerializeToNode(new
        {
            contract = Version,
            phase = result.DelegatedSessionId is not null ? "delegated" : result.CompletedNarrative is not null ? "completed" : result.Wait is not null ? "awaiting_player" : result.Version != priorVersion ? "refresh_required" : "ready",
            version = result.Version, applied = true,
            next = result.DelegatedSessionId is not null ? "combat" : result.CompletedNarrative is not null ? "done" : result.Wait is not null ? "player" : "model", wait = result.Wait
        }, HarnessJson.Options);
        return result with { Reply = result.Reply with { Content = HarnessJson.Serialize(obj) } };
    }

    private static string[] ExpectedTools(HarnessExecutionFrame frame, int contract)
    {
        var tools = Capture(frame.Version, frame.Context, frame.Combat, frame.Self, contract, frame.Map, hasImportedSkills: frame.HasImportedSkills, board: frame.Board, agent: frame.Agent).AvailableTools;
        return frame.Opening?.Generating == true ? tools.Where(t => HarnessOpenings.Allows(t, contract)).Append("opening_commit").Distinct(StringComparer.Ordinal).ToArray() : tools;
    }

    public static void Validate(HarnessExecutionFrame frame, int cursor, int toolContractVersion = Version)
    {
        bool combatAgent = frame.Agent?.Role == "combat";
        if (frame.Opening is { } opening)
        {
            if (toolContractVersion < 38 || opening.Generating && combatAgent || opening.Instruction != (opening.Generating ? HarnessOpenings.EntryInstruction(toolContractVersion) : HarnessOpenings.HistoryInstruction) ||
                opening.SceneId != (frame.WorkingContext?.SceneId ?? frame.Map?.SceneId) || opening.PublicText is null || opening.PublicText.Length > 4096 ||
                opening.PrivateText is null || opening.PrivateText.Length > 1024 ||
                (toolContractVersion >= 43 ? opening.WritePublic && (!opening.Generating || opening.PublicText.Length != 0)
                    : opening.WritePublic != (opening.Generating && opening.PublicText.Length == 0)) ||
                opening.WriteArrival != (toolContractVersion >= HarnessOpenings.ArrivalVersion && opening.Generating && !opening.WritePublic ? (bool?)true : null))
                throw new InvalidDataException("Invalid opening context.");
        }
        if ((toolContractVersion >= 38) != (frame.SharedStories is not null) ||
            (toolContractVersion >= 38 ? frame.NarrativeContract != HarnessStoryContext.ForVersion(toolContractVersion) : frame.NarrativeContract is not null) ||
            frame.SharedStories is { } shared && (shared.Entries is null || shared.Entries.Length > 12 || shared.Total < shared.Entries.Length ||
                shared.Entries.Any(s => s is null || s.Sequence < 1 || s.Sequence > shared.Total || s.AtVersion > frame.Version || s.AtVersion < 1 ||
                    string.IsNullOrEmpty(s.ActorId) || string.IsNullOrEmpty(s.Text) || !PrivateStories.ValidSource(s.Source) ||
                    s.Publication is not (null or "retelling") || s.Publication is null && s.Source.Revision != PrivateStories.Revision(s.Text) ||
                    s.Publication == "retelling" && s.Text.Length > PrivateStories.MaximumText)))
            throw new InvalidDataException("Invalid shared story context.");
        if ((toolContractVersion >= 39) != (frame.Agent?.CombatPromptReady is not null))
            throw new InvalidDataException("Invalid combat prompt availability.");
        if ((toolContractVersion >= 36) != (frame.Agent is not null) || frame.Agent is { } agent &&
            (agent.Role is not ("exploration" or "combat") || combatAgent != (agent.SessionId is not null) ||
             combatAgent && (!Guid.TryParseExact(agent.SessionId, "D", out _) || string.IsNullOrEmpty(agent.EncounterId)) ||
             !combatAgent && agent.Handoff is not null)) throw new InvalidDataException("Invalid agent ownership.");
        if (frame.Agent?.Command is { } command && (toolContractVersion < 51 || !combatAgent ||
            command.Source is null || !command.Source.Valid(frame.Version) || command.Instruction != HarnessCombatCommands.Instruction ||
            frame.Context.Intent.Candidates.Length != 0)) throw new InvalidDataException("Invalid command narration association.");
        if (frame.Agent?.AfterCombat is { } aftermath && (toolContractVersion < 37 || combatAgent ||
            !Guid.TryParseExact(aftermath.SessionId, "D", out _) || !Guid.TryParseExact(aftermath.ReturnId, "D", out _) ||
            aftermath.Version < 1 || aftermath.Version > frame.Version || aftermath.Instruction != HarnessAgentContexts.AftermathInstruction))
            throw new InvalidDataException("Invalid combat aftermath.");
        if (!HarnessTools.Supports(toolContractVersion) || toolContractVersion < Version ||
            (toolContractVersion >= HarnessCharacterContext.MinimumToolVersion) != (frame.Self is not null) ||
            (toolContractVersion >= MinimumMapToolVersion) != (frame.Map is not null) ||
            (toolContractVersion >= 23 && !combatAgent) != (frame.WorkingContext is not null) ||
            (toolContractVersion >= 23) != (frame.DetailedSelf is not null) ||
            (toolContractVersion is >= 23 and < 45) != (frame.WorkingMemory is not null) ||
            (toolContractVersion >= 45) != (frame.History is not null) ||
            (toolContractVersion >= 24 && !combatAgent) != (frame.ScenePresentation is not null) ||
            (toolContractVersion >= 24) != (frame.HasImportedSkills is not null) ||
            (toolContractVersion >= 25 && !combatAgent) != (frame.Supplies is not null) ||
            (toolContractVersion >= 27) != (frame.Board is not null) ||
            (toolContractVersion >= 43) != (frame.KnownInformation is not null) ||
            (toolContractVersion >= HarnessDmChecklist.MinimumToolVersion) != (frame.DmChecklist is not null) ||
            frame.Kind != "execution_state" || frame.Contract != Version || frame.Phase != "ready" || frame.Version < 1 || frame.Version > cursor ||
            frame.Context?.Intent?.Context?.Character is null || frame.Context.Intent.Candidates is null || frame.Context.KnownMemory is null || frame.Context.KnownScenes is null ||
            frame.Context.Intent.Candidates.Length > 32 || frame.Context.KnownMemory.Length > 32 || frame.Context.KnownScenes.Length > 64 ||
            frame.Context.Intent.Candidates.Any(c => c is null || string.IsNullOrEmpty(c.Id) || c.Id.Length > 64) ||
            frame.Context.Intent.Candidates.Select(c => c.Id).Distinct(StringComparer.Ordinal).Count() != frame.Context.Intent.Candidates.Length ||
            frame.Context.KnownMemory.Any(m => m is null || string.IsNullOrEmpty(m.Id)) || frame.Context.KnownScenes.Any(s => s is null || string.IsNullOrEmpty(s.Id)) ||
            frame.Combat is { ValueKind: not JsonValueKind.Object } || frame.AvailableTools is null ||
            !frame.AvailableTools.SequenceEqual(ExpectedTools(frame, toolContractVersion)))
            throw new InvalidDataException("Invalid execution frame.");
        if (frame.Map is { } map && (map.SceneId is null || map.SceneId.Length > 160 || map.SceneId.Any(char.IsControl) ||
            map.Status is not ("unavailable" or "missing" or "pending" or "generating" or "ready" or "failed" or "withheld") ||
            map.Status == "unavailable" && map.GenerationEnabled ||
            (map.SceneId.Length == 0 ? map.Status != "unavailable" || map.GenerationEnabled
                : !frame.Context.KnownScenes.Any(scene => scene.Id == map.SceneId))))
            throw new InvalidDataException("Invalid execution map state.");
        if (frame.ScenePresentation is { } scene && (scene.SceneId is null || scene.Title is null || scene.CurrentSummary is null ||
            scene.Arrival is null || scene.Notice is null || scene.Title.Length > 160 || scene.CurrentSummary.Length > 8000 || scene.Arrival.Length > 8000 ||
            scene.Notice.Length > 600 || (scene.SceneId.Length == 0
                ? scene.Title.Length != 0 || scene.CurrentSummary.Length != 0 || scene.Arrival.Length != 0
                : scene.SceneId != frame.WorkingContext?.SceneId || !frame.Context.KnownScenes.Any(s => s.Id == scene.SceneId))))
            throw new InvalidDataException("Invalid scene presentation.");
        HarnessReadPreloads.Validate(frame, toolContractVersion);
        if (frame.DmChecklist is { } checklist) checklist.Validate(frame, toolContractVersion);
        if (frame.Board is { } board) HarnessBoardContext.Validate(board, frame.Version, frame.WorkingContext?.SceneId ?? frame.Map?.SceneId ?? "", allowPersonal: toolContractVersion >= 36, toolContractVersion: toolContractVersion);
        if (frame.Supplies is { } supplies)
            HarnessSupplyContext.Validate(supplies, frame.Version, frame.WorkingContext!.SceneId);
        if (frame.WorkingMemory is { } memory)
        {
            HarnessWorkingMemories.Validate(memory);
            if (memory.Version != frame.Version || memory.ActorId != frame.Self?.ActorId)
                throw new InvalidDataException("Invalid working memory version or seat.");
        }
        if (frame.WorkingContext is { } working)
        {
            HarnessSceneContexts.Validate(working);
            if (working.Version != frame.Version || frame.Map is { } currentMap && currentMap.SceneId.Length > 0 && working.SceneId != currentMap.SceneId)
                throw new InvalidDataException("Invalid working context version or scene.");
        }
        if (frame.History is { } history) HarnessHistoryContexts.Validate(history, frame.Version, frame.Self!.ActorId, HarnessHistoryContexts.Scope(frame.Agent?.SessionId), toolContractVersion);
        if (frame.KnownInformation is { } knowledge) HarnessKnownInformations.Validate(knowledge, frame.Version, frame.Self?.ActorId);
        if (frame.Self is { } self) HarnessCharacterContext.Validate(self, frame.Context.Intent.Context.Character, toolContractVersion);
        // v23 stores complete self and source evidence, including deliberate duplicates
        // removed only in provider presentation. This is not the outbound request limit.
        HarnessJson.Bound(frame, toolContractVersion >= 45 ? HarnessContextCompactor.MaximumPreparedBytes : toolContractVersion >= 23 ? 512 * 1024 : 131072);
    }
}
