using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessTacticalGrid(double CellPixels, double OffsetX, double OffsetY);
public sealed record HarnessEncounterEnemy(string RulesId, string Name, string Tactic, double X, double Y,
    string HidingCover = "", string HidingReason = "");
public sealed record HarnessEncounterPrepare(string MapId, string SourceId, string Quote,
    string LayoutReason, HarnessTacticalGrid? Grid, HarnessEncounterEnemy[] Enemies, BattleCell[] Terrain);
public sealed record HarnessEncounterPrepareV42(string MapId, string SourceId, string Quote,
    string LayoutReason, HarnessEncounterEnemy[] Enemies, BattleCell[] Terrain)
{
    internal HarnessEncounterPrepare Preparation() => new(MapId, SourceId, Quote, LayoutReason, null, Enemies, Terrain);
}
public sealed record HarnessEncounterPrepareV46(string MapId, string SourceId, string Quote,
    string LayoutReason, HarnessEncounterEnemy[] Enemies, BattleCell[] Terrain,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? EncounterId = null)
{
    internal HarnessEncounterPrepare Preparation() => new(MapId, SourceId, Quote, LayoutReason, null, Enemies, Terrain);
}
public sealed record HarnessEncounterEngage(string EncounterId, string Reason, string[] SurprisedActors);

public sealed partial class GameService
{
    private static bool HasSceneEvidence(Campaign c, AdventureContext context, int contract, string sourceId, string quote)
    {
        var working = HarnessSceneContexts.Build(c, context, contract);
        var scene = Adventure.Current(c);
        return sourceId == c.SceneId && (scene.Summary.Contains(quote, StringComparison.Ordinal) || scene.Arrival.Contains(quote, StringComparison.Ordinal)) ||
            working.PublicEvidence.Concat(working.DmOnly).Any(e => e.Id == sourceId && e.Nature != "model_record" && e.Summary.Contains(quote, StringComparison.Ordinal));
    }

    private static object EncounterRead(Campaign c, int contract = 35) => new
    {
        version = c.Version,
        notice = "DM-only mechanical preparation, never copy the roster, positions or dice to public narration. KnownActors are per-seat discoveries; an attack reveals its attacker. No ordinary token tool can disclose a hidden instance." + (contract >= 51 ? " Hiding reason describes the original attempt, NOT current concealment: use hidden, Stealth.success and KnownActors. A known enemy may remain behind cover but is not unseen by that observer. Every enrolled unit participates even when its identity/initiative/position is withheld from this viewer. layout=null blocks delegation only; retain the original encounter and bind a grounded layout. Existing valid map/party positions need no repeated selection or placement." : ""),
        encounter = RuntimeEncounters.Current(c),
        roster = c.Board?.Entities.Where(e => e.Source.EncounterId == RuntimeEncounters.Current(c)?.Definition.Id &&
            (contract < 56 || RuntimeEncounters.Current(c) is not null)).Select(e => new
        { e.Id, sourceId = e.Source.Id, e.Appearance.Name, e.Appearance.Visibility,
            Placement = SharedBoard.PlacementOn(e, RuntimeEncounters.Current(c)!.Layout?.MapId ?? RuntimeEncounters.Current(c)!.ObservationMapId!), e.Statistics }).ToArray(),
        profiles = StandardMonsters.All.Select(p => new { p.Id, p.Hp, p.Ac, p.Speed, tactics = p.Id == "xmm:goblin-warrior" ? new[] { "engage", "ranged", "withdraw" } : ["engage", "withdraw"] }).ToArray()
    };

    private (HarnessToolOutcome Outcome, Resolution Resolution) PrepareHarnessEncounter(Campaign c, string runId, string input,
        HarnessEncounterPrepare args, AdventureContext context, BoardMapView? suppliedMap, int contract, string? encounterId = null)
    {
        ContextualRolls.RequireNoPending(c);
        if (ActionUnderstanding.Current(c) is not null || c.PendingRulings.Any(r => r.ActorId == c.ActingActorId && r.Status is "pending" or "awaiting_roll"))
            throw new GameException("encounter_setup_unavailable", "先完成当前待处理的行动或裁定。", 409);
        string quote = WorldMemories.Text(args.Quote, 800, multiline: true);
        if (!HasSceneEvidence(c, context, contract, args.SourceId, quote))
            throw new GameException("encounter_source_unavailable", "遭遇必须引用当前已提供的非模型场景依据，不能自证新增敌人。", 409);
        var map = BoardMap(c, args.MapId, publicOnly: true);
        if (suppliedMap is null || suppliedMap.Id != map.Id || suppliedMap.Version != map.Version || suppliedMap.ContentHash != map.ContentHash)
            throw new GameException("stale_board_map", "遭遇依据的底图已变化，请先读取实际地图。", 409);
        if (args.Enemies is null || args.Enemies.Any(e => e is null) || args.Terrain is null)
            throw new GameException("harness_invalid_payload", "缺少完整战术布置。");
        var placements = args.Enemies.Select(e => new EncounterPlacement(e.RulesId, e.Name, e.Tactic, new(e.X, e.Y),
            e.HidingCover == "" ? null : e.HidingCover, e.HidingReason == "" ? null : e.HidingReason)).ToArray();
        RuntimeEncounter setup;
        if (contract >= 46 && encounterId is not null)
        {
            var original = RuntimeEncounters.Current(c);
            if (original?.Definition.Id != encounterId || original.SourceId != args.SourceId || original.Quote != quote)
                throw new GameException("encounter_setup_unavailable", "绑定布局须引用原遭遇及其原始来源，不重新建立敌人。", 409);
            setup = RuntimeEncounters.BindLayout(c, map, encounterId, args.LayoutReason, placements, args.Terrain, contract);
        }
        else
        {
            var grid = contract >= 46 ? null : contract >= 42 ? MapScale.TacticalGrid(map)
                : args.Grid is { } legacyGrid ? new MapGrid { Type = "square", CellPixels = legacyGrid.CellPixels, OffsetX = legacyGrid.OffsetX, OffsetY = legacyGrid.OffsetY, Distance = 5, Units = "feet" }
                : throw new GameException("harness_invalid_payload", "缺少完整战术布置。");
            setup = RuntimeEncounters.Prepare(c, map, grid, IntentContexts.Bounded(Adventure.Current(c).Title, 70) + " · 战斗", args.SourceId, quote, args.LayoutReason, placements, args.Terrain,
                namingVersion: contract);
            RuntimeEncounters.Establish(c, map, setup, placements, rules);
        }
        var (intent, root) = HarnessRoot(c, runId, input);
        var resolution = new Resolution("resolved", "encounter.prepare", setup.Layout is null
            ? "已完成本次观察的准备；尚未投掷玩家骰子。"
            : "已记录当前场景的战术布置；尚未开始战斗或投掷玩家骰子。", null, [], IntentId: runId);
        RecordIntent(c, intent, resolution, root ? "intent.request" : resolution.Kind);
        ActionUnderstanding.Complete(c, resolution, intent.ResultOrigin);
        return (ToolOutcome(c, EncounterRead(c, contract)), resolution);
    }

    private async Task<(HarnessToolOutcome Outcome, Resolution Resolution)> EngageHarnessEncounter(Campaign c, string runId, string input,
        string commandId, HarnessEncounterEngage args, int toolContractVersion)
    {
        ContextualRolls.RequireNoPending(c);
        var setup = RuntimeEncounters.Current(c);
        if (setup?.Definition.Id != args.EncounterId || setup.Layout is null || setup.EngagementReason is not null || CombatEngine.Restricted(c) ||
            !StandardCombatEngine.CanStart(c) || ActionUnderstanding.Current(c) is not null ||
            c.PendingRulings.Any(r => r.ActorId == c.ActingActorId && r.Status is "pending" or "awaiting_roll"))
            throw new GameException("encounter_setup_unavailable", "当前遭遇不能再次进入先攻或已有待处理行动。", 409);
        string reason = WorldMemories.Text(args.Reason, 500, multiline: true);
        var actors = PartyEngine.Characters(c).Select(p => p.Id).ToHashSet();
        if (args.SurprisedActors is null || args.SurprisedActors.Distinct().Count() != args.SurprisedActors.Length || args.SurprisedActors.Any(id => !actors.Contains(id) ||
            setup.Concealment?.Any(e => e.KnownActors.Contains(id)) == true || setup.Concealment?.Any(e => e.Hidden) != true))
            throw new GameException("encounter_setup_unavailable", "惊讶须引用本次未被发现的真实隐匿；已经发现敌人的队员不按伏击惊讶处理。", 409);
        c.RuntimeEncounters![c.RuntimeEncounters.IndexOf(setup)] = setup with { SurprisedActors = args.SurprisedActors, EngagementReason = reason };
        var (intent, root) = HarnessRoot(c, runId, input);
        var starting = new Resolution("resolved", "encounter.engage", "敌对交锋即将开始，等待各队员确认自己的先攻。", null, [], IntentId: runId);
        RecordIntent(c, intent, starting, root ? "intent.request" : starting.Kind);
        ActionUnderstanding.Complete(c, starting, intent.ResultOrigin);
        var result = await PrepareAction(c, new(commandId, c.Version, "natural", Text: input), new("combat.start", ""), true, true, [], runId,
            namingVersion: toolContractVersion, useCurrentBoardMap: toolContractVersion >= 42);
        return (ToolOutcome(c, new { version = c.Version, resolution = result, pendingRoll = ContextualRolls.View(c) }, WaitFor(result)), result);
    }
}
