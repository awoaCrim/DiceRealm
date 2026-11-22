using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    private (HarnessBoardContext Context, byte[] Png) CaptureHarnessBoard(Campaign c, int toolContractVersion)
    {
        var capture = mapCatalog.CapturePlayerBoard(c.Id, c.SceneId, MapMarkers.Targets(c), SharedBoard.SelectedMapId(c),
            allowFallback: !CombatEngine.InCombat(c) || c.Combat?.BoardLayout is null);
        if (capture is null)
        {
            var unavailable = HarnessBoardContext.Unavailable(c.Version, c.SceneId);
            return (toolContractVersion < 42 ? unavailable : unavailable with
            {
                Maps = mapCatalog.List(c.Id, false, false, true, c.SceneId, MapMarkers.Targets(c)).Maps
                    .Where(m => m.CurrentScene && m.Status == "ready").Select(m => BoardMapOption(toolContractVersion >= 51 ? RuntimeEncounters.TacticalMap(c, m) : m)).ToArray()
            }, []);
        }
        var board = ProjectHarnessBoard(c, capture.Map, toolContractVersion);
        // CanView has already filtered this exact actor. A personally discovered GM
        // token is not globally public; preserve that distinction in the v36 model frame.
        if (toolContractVersion >= 36)
            board = board with { Tokens = board.Tokens.Select(t => t.Visibility == "gm" ? t with { Visibility = "actor" } : t).ToArray() };
        var context = new HarnessBoardContext(c.Version, c.SceneId, "image_failed", board, BoardSources(c, capture.Map.Id, toolContractVersion), [], HarnessBoardContext.CoordinateContract,
            (capture.Map.Provenance?.Layout ?? "") + (toolContractVersion >= 36 ? " Tokens with visibility=actor are this actor’s personal discoveries, not public information; never publish them as shared knowledge." : "") +
            (toolContractVersion >= 51 ? " Both state.map.grid and maps[].grid are the effective grid for this scene, derived without changing the original asset calibration. A square grid does not mean the encounter layout is bound. Terrain uses zero-based local cells; cover cells obstruct occupancy and must lie between an observer and the concealed unit, not under that unit." : ""));
        if (toolContractVersion >= 42)
            context = context with { Maps = capture.Maps.Where(m => m.Status == "ready" || m.Id == capture.Map.Id).Select(m => BoardMapOption(toolContractVersion >= 51 ? RuntimeEncounters.TacticalMap(c, m) : m)).ToArray() };
        return (context, capture.Png);
    }
    private static HarnessBoardContext RenderHarnessBoard(HarnessBoardContext context, byte[] png)
    {
        if (context.State is null || png.Length == 0) return context;
        try
        {
            return context with { Status = "ready", Images = BoardRenderer.Render(context.State, png),
                Notice = "Images and token summaries are frozen from this exact campaign/map version and content hash. Only actual on-map positions are drawn; pending previews are not committed locations. Full details are available through token_read. Template sources do not grant mechanics. " + context.Notice };
        }
        catch (Exception error) when (error is InvalidDataException or ArgumentException or TypeInitializationException or DllNotFoundException)
        {
            return context with { Status = "image_failed", Images = [], Notice = "Board rendering failed. No image was attached; use explicit coordinates and do not claim visual understanding. No provider/model switch was performed. " + context.Notice };
        }
    }
    private static BoardView ProjectHarnessBoard(Campaign c, MapAssetView map, int contract)
    {
        var board = SharedBoard.Project(c, map, publicOnly: true);
        return contract >= 42 ? board : board with
        {
            Map = board.Map with { Purpose = null, Grid = board.Map.Grid with { ScaleBasis = null } },
            Tokens = board.Tokens.Select(t => t with { Size = null }).ToArray()
        };
    }
    private static BoardMapView BoardMapOption(MapAssetView map) =>
        new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid) { Purpose = map.Purpose };

    private BoardSourceOption[] BoardSources(Campaign c, string mapId, int contract)
    {
        var sources = new List<BoardSourceOption>();
        if (contract >= 39)
            sources.AddRange(PartyEngine.Characters(c).Select(p => new BoardSourceOption("player", p.Id, "", p.Character.Name, "Approved actual party character; DM chooses placement, never clone or reset.")));
        else if (PartyEngine.HasCharacter(c)) sources.Add(new("player", c.ActingActorId, "", c.ActingCharacter.Name, "Existing own character; never clone or reset."));
        foreach (var npc in ContentRuntime.World(c).Npcs.Where(n => n.SceneId == c.SceneId))
            sources.Add(new("npc", npc.Id, "", npc.Name, "One actual person; an existing instance is reused."));
        if (ContentRuntime.AvailableEncounter(c) is { } encounter && c.RuntimeEncounters?.Any(e => e.Definition.Id == encounter.Id) != true)
            foreach (var enemy in encounter.Enemies)
                sources.Add(new("enemy", enemy.Id, encounter.Id, enemy.Name, "Imported encounter template; each new spawn creates a distinct instance. Use existing IDs when reappearing."));
        var sourceMaps = contract >= 42
            ? mapCatalog.List(c.Id, false, false, true, c.SceneId).Maps.Where(m => m.CurrentScene && m.Status == "ready").Select(m => m.Id).ToArray()
            : [mapId];
        foreach (var e in (c.Board?.Entities ?? []).Where(e => sourceMaps.Any(id => SharedBoard.PlacementOn(e, id) is not null) && SharedBoard.CanView(c, e, true)))
            sources.Add(new("existing", e.Id, "", e.Appearance.Name, "Use existingId plus source.kind=existing; all state is retained."));
        return sources.Take(128).ToArray();
    }
    private (HarnessToolOutcome Outcome, Resolution? Resolution) ExecuteHarnessBoard(Campaign c, string runId, string input,
        string commandId, HarnessToolRequest request, BoardMapView? suppliedMap, int toolContractVersion, bool opening = false)
    {
        if (request.Name == "map_state_read")
        {
            HarnessJson.Read<EmptyHarnessArgs>(request.Arguments);
            var (context, _) = CaptureHarnessBoard(c, toolContractVersion);
            if (toolContractVersion >= 42)
                return (ToolOutcome(c, new { version = c.Version, board = context.State, maps = context.Maps, sources = context.Sources,
                    context.Coordinates, notice = "Maps carry their own actual purpose/scale/basis. map_select changes the shared image without moving tokens; the next model request freezes that exact map image." }), null);
            return (ToolOutcome(c, new { version = c.Version, board = context.State, sources = context.Sources,
                context.Coordinates, notice = "The next model request automatically supplies a fresh same-version board image when rendering succeeds." }), null);
        }
        if (request.Name == "token_read")
        {
            var args = HarnessJson.Read<HarnessTokenArgs>(request.Arguments);
            var entity = SharedBoard.Find(c, args.EntityId);
            var mapIds = toolContractVersion >= 42
                ? mapCatalog.List(c.Id, false, false, true, c.SceneId).Maps.Where(m => m.CurrentScene && m.Status == "ready").Select(m => m.Id).ToArray()
                : entity.Placement is { } placement && BoardMap(c, placement.MapId, publicOnly: true).CurrentScene ? [placement.MapId] : [];
            if (!mapIds.Any(mapId => SharedBoard.PlacementOn(entity, mapId) is not null))
                throw new GameException("board_token_not_found", "当前场景未提供此单位。", 404);
            return (ToolOutcome(c, SharedBoard.Detail(c, args.EntityId, publicOnly: true)), null);
        }
        BoardCommandRequest command = request.Name switch
        {
            "token_spawn" => Spawn(HarnessJson.Read<HarnessSpawnArgs>(request.Arguments)),
            "token_move" => Move(HarnessJson.Read<HarnessMoveArgs>(request.Arguments)),
            "token_update" => Update(HarnessJson.Read<HarnessUpdateArgs>(request.Arguments)),
            "token_remove" => Remove(HarnessJson.Read<HarnessRemoveArgs>(request.Arguments)),
            _ => throw HarnessJson.Conflict("harness_tool_unavailable")
        };
        BoardCommandRequest Spawn(HarnessSpawnArgs a) => new(commandId, c.Version, a.MapId, "spawn", Spawns: a.Spawns);
        BoardCommandRequest Move(HarnessMoveArgs a) => new(commandId, c.Version, a.MapId, "move", a.EntityId, Destination: a.Destination, Path: a.Path, Snap: a.Snap);
        BoardCommandRequest Update(HarnessUpdateArgs a) => new(commandId, c.Version, a.MapId, "update", a.EntityId, Appearance: a.Appearance);
        BoardCommandRequest Remove(HarnessRemoveArgs a) => new(commandId, c.Version, a.MapId, "remove", a.EntityId);
        var map = BoardMap(c, command.MapId, publicOnly: true);
        if (!map.CurrentScene) throw new GameException("board_scene_mismatch", "AI只能操作当前场景的公开棋盘。", 409);
        if (command.Spawns is { } spawns)
        {
            var sources = BoardSources(c, map.Id, toolContractVersion);
            foreach (var spawn in spawns)
            {
                if (spawn is null || spawn.Source is null) throw new GameException("invalid_board_command", "缺少单位来源。");
                string sourceId = spawn.Source.Kind == "existing" ? spawn.ExistingId : spawn.Source.Id;
                if (spawn.Source.Kind != "custom" && !sources.Any(s => s.Kind == spawn.Source.Kind && s.Id == sourceId && s.EncounterId == spawn.Source.EncounterId))
                    throw new GameException("board_source_unavailable", "请使用当前场景提供的准确来源，不要猜测编号。", 409);
            }
        }
        if (suppliedMap is null || suppliedMap.Id != map.Id || suppliedMap.Version != map.Version)
            throw new GameException("stale_board_map", "棋盘依据的地图版本已变化，请刷新。", 409);
        command = command with { ExpectedMapVersion = suppliedMap.Version };
        SharedBoard.ValidateCommand(command);
        if (opening)
        {
            HarnessOpenings.Require(c);
            if (toolContractVersion < 39 || command.Operation != "spawn" || command.Spawns is not { Length: 1 } first ||
                first[0].ExistingId.Length != 0 || first[0].Source.Kind != "player" || first[0].ActorId != c.ActingActorId ||
                c.Board?.Entities.Any(e => e.ActorId == c.ActingActorId && SharedBoard.PlacementOn(e, map.Id) is { OnMap: true }) == true)
                throw new GameException("opening_placement_unavailable", "入场只能为本人补充一次当前图初始位置，不能改动既有站位或其他单位。", 409);
            var (initial, _) = ExecuteBoardCommand(c, map, command, narrator: true, controlPlayers: true, namingVersion: toolContractVersion);
            c.Version++;
            c.StateOnlyVersions.Add(c.Version);
            return (ToolOutcome(c, new { version = c.Version, result = initial, board = ProjectHarnessBoard(c, map, toolContractVersion) }),
                new Resolution("resolved", "board.spawn", "DM已保存初始站位。", null, []));
        }
        if (toolContractVersion < 39 && NeedsPlayerBoardIntent(c, command) && (toolContractVersion < 28 || !DirectPlayerBoardIntent(c, runId, input, command, toolContractVersion)))
            return ProposePlayerBoard(c, runId, input, command, map);
        var (result, combatResolution) = ExecuteBoardCommand(c, map, command, narrator: true, controlPlayers: toolContractVersion >= 39 && command.Operation != "update",
            namingVersion: toolContractVersion);
        var (intent, root) = HarnessRoot(c, runId, input);
        var resolution = combatResolution is not null ? combatResolution with { IntentId = runId } : new Resolution(result.Status == "pending" ? "needs_adjudication" : "resolved", "board." + command.Operation,
            result.Status == "pending" ? "移动意图待结算，实际位置未改变。" : "已保存棋盘操作；未验证地形或支付资源。", null, [], result.RulingId, IntentId: runId);
        RecordIntent(c, intent, resolution, root ? "intent.request" : resolution.Kind);
        ActionUnderstanding.Complete(c, resolution, intent.ResultOrigin);
        return (ToolOutcome(c, new { version = c.Version, result, board = ProjectHarnessBoard(c, map, toolContractVersion) }, WaitFor(resolution)), resolution);
    }
}
