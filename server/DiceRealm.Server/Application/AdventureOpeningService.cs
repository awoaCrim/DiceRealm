using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record StartOpeningRequest(string RequestId, int ExpectedVersion);
public sealed record OpeningNarrativeArgs(string Public,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? Private = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] PrivateMessageRequest[]? PrivateMessages = null);
// WriteArrival (v58): a later entrant, after the shared opening is saved, may add a short public line of
// their own arrival so the others see them join. Absent on older contracts and on history frames.
public sealed record HarnessOpeningContext(string SceneId, string PublicText, string PrivateText, bool Generating, bool WritePublic, string Instruction,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] bool? WriteArrival = null);

public static class HarnessOpenings
{
    public const string Input = "呈现入场开场；只交代已经成立的现场和本人相关前情，不接受任务或执行任何行动。";
    public const string Instruction = "This is an ENTRY, not a player action. First establish the authoritative current place and present moment. If writePublic=true, write ONE shared opening in third person from public current-scene evidence: necessary context, visible space and present people, their public words/behaviour, and an actionable handoff. Do not publish private identity/backstory, host evidence, undiscovered clues or future events. If writePublic=false, public MUST be empty; the saved shared opening is historical context, do not replay it or make its NPCs enter again. Write only optional second-person PRIVATE additions for this actor from their already-approved relevant backstory, established relationships/knowledge and actual current position. No relevant differences means private may be empty. Do not repeat their sheet/equipment, invent motives/agreements/reactions, accept the main quest, move anyone, advance time, create discoveries, or settle mechanics. Both parts describe the same instant; later joiners use current facts, never assume the original opening is still occurring. Only opening_commit saves this entry; no world/action tools or follow-up question is required.";
    public const int ArrivalVersion = 58;
    public const int ArrivalMaximum = 200;
    public const string ArrivalRule = "Contract 58: when opening.writeArrival=true the shared opening is already saved and public is no longer required to be empty: it may hold at most two short THIRD-person sentences (200 characters) in which ONLY this actor joins the current scene as it stands now, so the others see them arrive. Never restate the place, other people, the saved opening or anything private. Leave public empty when the saved opening or later public story already presents this actor.";
    public static string EntryInstruction(int contract) => contract >= ArrivalVersion ? EntryInstruction(ArrivalVersion - 1) + " " + ArrivalRule
        : contract >= 49
        ? EntryInstruction(48) + " " + HarnessStoryContext.IncrementalNarrativeContract : contract >= 43 ?
        "This is ENTRY, not an action. Present only already-established current public surroundings and confirmed individual backstory, relationships or messages. public may be empty even for the first entry; when writePublic=false it MUST be empty. Optional privateMessages use actual recipientIds, not necessarily the entering actor; common established knowledge can go to several actual knowers. No personal addition means omit it, never invent a secret or tell the room a private message exists. Public phenomena stay public; private recognition only goes to those who actually know it. Never send undiscovered threats, host-only plans or future events to an arbitrary player. Do not create discoveries, accepted quests, motives, actions or time advance. Each private text is second-person STORY ONLY, with no mechanics/receipts. If a current board exists and this actor has no token there, token_spawn once at a scene-grounded DM-chosen position; preserve existing positions. No other writes or follow-up question. opening_commit alone saves this entry." : contract < 39 ? Instruction :
        "This is ENTRY, not a player action. Establish the authoritative current place and present moment. If a current board is supplied and this actor has no on-map token there, use token_spawn ONCE for this actor alone at a scene-grounded DM-chosen initial position; never ask the player to place/approve it. Preserve existing positions. With no board, leave coordinates unknown and do not claim placement. Then opening_commit saves one THIRD-person shared opening only when writePublic=true (otherwise public MUST be empty), and optional SECOND-person private STORY for this actor from approved backstory, established relationships/knowledge and actual position. Private contains no dice/DC/modifier/result labels or mechanical receipts. No differences means empty private. Both parts describe the same instant. Later joiners use current facts, never replay past entrances. Do not invent motives, agreements, reactions, accepted quest, discoveries, actions or time advance; do not disclose hidden evidence. Apart from that initial placement, no world/mechanical writes. No follow-up question is required.";
    public static bool Allows(string tool, int contract = 38) => tool is "opening_commit" or "context_read" or "skills_list" or "skills_read" ||
        contract >= 39 && tool is "token_spawn" or "map_state_read" or "token_read";
    public const string HistoryInstruction = "Saved opening is historical evidence, not a new arrival. PublicText is shared; PrivateText belongs ONLY to this actor and must not be broadcast. Later established facts and current location take precedence. No accepted main quest, trust, motive or relationship follows merely from entering the game.";
    public static HarnessOpeningContext Capture(Campaign c, bool generating, int contract = 38)
    {
        if (generating) Require(c);
        return new(c.SceneId, c.Opening!.PublicText, c.Opening.Entries.FirstOrDefault(e => e.ActorId == c.ActingActorId)?.PrivateText ?? "",
            generating, generating && c.Opening.PublicSequence == 0, generating ? EntryInstruction(contract) : HistoryInstruction,
            contract >= ArrivalVersion && generating && c.Opening.PublicSequence != 0 ? true : null);
    }
    public static void Require(Campaign c)
    {
        if (!AdventureOpenings.Needed(c)) throw HarnessJson.Conflict("opening_completed");
        if (CombatEngine.InCombat(c) || c.Opening!.PublicSequence == 0 && c.SceneId != c.Opening.SceneId)
            throw HarnessJson.Conflict("opening_context_changed");
    }
    public static HarnessExecutionFrame Restrict(HarnessExecutionFrame frame, HarnessOpeningContext opening, int contract = 38) => frame with
    {
        Opening = opening,
        WorkingContext = frame.WorkingContext is not { } working ? null : working with
        {
            DmOnly = [], Coverage = working.Coverage with { DmOnly = new(0, 0, 0, 0) },
            Guidance = contract < 39 ? "入场只采用公开现场与本人已确认前情。主持秘密不参与开场生成；不授予发现、不执行行动，只用opening_commit保存。" :
                "入场只采用公开现场与本人已确认前情。当前图没有本人站位时，DM先用token_spawn保存本人初始位置，不让玩家选点或批准。已有位置不重置；无图时保持坐标未知。不授予发现、不执行行动；然后opening_commit保存纯剧情。"
        },
        AvailableTools = frame.AvailableTools.Where(t => Allows(t, contract)).Append("opening_commit").Distinct(StringComparer.Ordinal).ToArray()
    };
}

public sealed partial class GameService
{
    private (HarnessToolOutcome Outcome, Resolution Resolution) CommitOpening(Campaign c, OpeningNarrativeArgs args, int contract)
    {
        HarnessOpenings.Require(c);
        if (contract >= 39 && mapCatalog.CapturePlayerBoard(c.Id, c.SceneId, MapMarkers.Targets(c), SharedBoard.SelectedMapId(c)) is { } board &&
            c.Board?.Entities.Any(e => e.ActorId == c.ActingActorId && SharedBoard.PlacementOn(e, board.Map.Id) is { OnMap: true }) != true)
            throw new GameException("opening_placement_required", "当前地图已有依据；先由DM用token_spawn保存本人初始站位，再提交开场。", 409);
        var opening = c.Opening!;
        string publicText = args.Public is null ? throw new GameException("harness_invalid_payload", "开场需要 public 与 private 字符串。") : args.Public.Trim();
        if (args.PrivateMessages is not null && contract < 43) throw new GameException("harness_invalid_payload", "旧开场合同不支持 privateMessages。");
        string privateText = args.Private is null && contract < 43 ? throw new GameException("harness_invalid_payload", "private 必须为字符串；没有补充可写空串。") : ActionUnderstanding.NormalizePrivate(args.Private, 1024, "harness_invalid_payload");
        var privateMessages = contract >= 43 ? PrivateStories.Plan(c, args.PrivateMessages, privateText) : null;
        if (contract >= 49 && privateMessages?.Any(m => (publicText.Length > 0 && m.Text.Trim() == publicText) ||
            (opening.PublicText.Length > 0 && m.Text.Trim() == opening.PublicText.Trim())) == true)
            throw new GameException("harness_invalid_payload", "私人消息重复了公共开场；没有独有新增信息时请省略。");
        if (privateMessages?.Any(m => m.DiscoveryIds is { Length: > 0 }) == true)
            throw new GameException("harness_invalid_payload", "入场只交付已经成立的个人前情，不创建或呈现新发现。");
        if (opening.PublicSequence == 0 && (contract < 43 || publicText.Length > 0)) publicText = WorldMemories.Text(publicText, 4096, multiline: true);
        else if (publicText.Length != 0 && contract < HarnessOpenings.ArrivalVersion)
            throw new GameException("harness_invalid_payload", "公共开场已经保存；个人补充不得重写共同现场。");
        else if (publicText.Length > HarnessOpenings.ArrivalMaximum || publicText.Any(char.IsControl))
            throw new GameException("harness_invalid_payload", "后加入的公开到场只写本人加入的一两句，不超过 200 字。");
        // One narrative-only event, without an invented player intent, action, clock advance,
        // world memory proposal, fact, inventory change or movement.
        c.Version++;
        string eventId = Guid.NewGuid().ToString();
        var resolution = new Resolution("resolved", "story.opening", publicText.Length > 0 ? publicText : contract >= 43 ? "" : "个人入场补充已保存。", null, []);
        c.Events.Add(new(eventId, c.Version, "story.opening", resolution.Summary, publicText, "harness",
            DateTimeOffset.UtcNow, resolution, c.ActingActorId, PrivateText: privateText, PrivateMessages: privateMessages));
        if (opening.PublicSequence == 0) { opening.PublicText = publicText; opening.PublicSequence = c.Version; }
        opening.Entries.Add(new(c.ActingActorId, eventId, c.Version, privateText));
        c.HarnessSceneNarration = new(c.SceneId, c.Version);
        var outcome = ToolOutcome(c, new { version = c.Version, opening = OpeningView(c), resolution });
        return (outcome with { Reply = outcome.Reply with { Stop = true }, CompletedNarrative = publicText }, resolution);
    }
}
