using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class MapScaleTests
{
    private static MapAssetView Local() => new(Guid.NewGuid().ToString(), "隔离局部图", "dungeon", "player", 4, "ready", true,
        1000, 800, 1000, 800, new() { Type = "square", CellPixels = 100, Distance = 10, Units = "feet", ScaleBasis = new("source", "测试原图说明") },
        "", "fixture-map", "", 0, default, CurrentScene: true) { Purpose = "tactical" };

    public static Task PhysicalSubdivisionAndUnknown()
    {
        var map = Local(); var original = map.Grid;
        var logical = MapScale.TacticalGrid(map);
        Check.Equal(50d, logical.CellPixels); Check.Equal(5d, logical.Distance);
        Check.Equal(original.Distance / original.CellPixels, logical.Distance / logical.CellPixels);
        var layout = BoardCombat.Layout(map);
        Check.Equal(20, layout.Width); Check.Equal(16, layout.Height); Check.Equal(logical, layout.Grid);
        Check.Equal(original, map.Grid);
        Check.Equal(logical, MapScale.TacticalGrid(map with { Grid = logical }));
        foreach (var purpose in new[] { "region", "settlement", "schematic" })
            Check.Throws<GameException>(() => BoardCombat.Layout(map with { Purpose = purpose }));
        Check.Throws<GameException>(() => MapScale.TacticalGrid(map with { Grid = original with { Uncalibrated = true } }));
        Check.Throws<GameException>(() => MapScale.TacticalGrid(map with { Grid = original with { ScaleBasis = new("unknown", "尚未确定") } }));
        var meters = map with { Grid = original with { Type = "none", Distance = 3.048, Units = "meters" } };
        Check.True(Math.Abs(MapScale.TacticalGrid(meters).CellPixels - 50) < 1e-10);
        Check.True(Math.Abs(MapScale.FeetPerPixel(meters.Grid) - .1) < 1e-12);
        Check.True(Math.Abs(MapScale.FeetPerPixel(original with { Units = "miles", Distance = 1 }) - 52.8) < 1e-12);
        Check.True(Math.Abs(MapScale.FeetPerPixel(original with { Units = "kilometers", Distance = 1 }) - 1000 / .3048 / 100) < 1e-10);
        var offset = BoardCombat.Layout(map with { Grid = original with { OffsetX = 10, OffsetY = -10 } });
        Check.Equal(10d, offset.Grid.OffsetX); Check.Equal(-10d, offset.Grid.OffsetY);
        Check.Equal(19, offset.Width); Check.Equal(15, offset.Height);
        // New optional fields must not alter historical request fingerprints.
        var old = JsonSerializer.Serialize(new ConfigureMapGridRequest("old", 1, new()), JsonFiles.Options);
        Check.True(!old.Contains("purpose") && !old.Contains("scaleBasis"));
        return Task.CompletedTask;
    }

    public static Task SameInstancesAcrossMapsAndCombat()
    {
        var local = Local(); var town = local with { Id = Guid.NewGuid().ToString(), Purpose = "settlement", Grid = local.Grid with { Distance = 50 } };
        var c = TestContent.Campaign("causeway");
        c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s with { Encounter = null }).ToArray() };
        var player = SharedBoard.Execute(c, town, new("town", c.Version, town.Id, "spawn", Spawns:
            [new("", "creature", new("player", c.ActingActorId), new("self"), .2, .7, c.ActingActorId)]));
        string playerId = player.EntityIds.Single();
        SharedBoard.Execute(c, local, new("local", c.Version, local.Id, "spawn", Spawns:
            [new(playerId, "creature", new("existing"), new("ignored"), .125, .3125)]));
        Check.Equal(1, c.Board!.Entities.Count);
        Check.Equal(.2, SharedBoard.Project(c, town).Tokens.Single().X);
        Check.Equal(.125, SharedBoard.Project(c, local).Tokens.Single().X);
        var saved = JsonSerializer.Serialize(c.Board, JsonFiles.Options);
        var placements = new[] { new EncounterPlacement("xmm:skeleton", "石牙", "engage", new(.375, .3125)) };
        Check.Throws<GameException>(() => RuntimeEncounters.Prepare(c, town, new() { Type = "square", CellPixels = 50 }, "test", c.SceneId, "test", "test", placements, namingVersion: 42));
        Check.Throws<GameException>(() => RuntimeEncounters.Prepare(c, local, local.Grid with { Distance = 5 }, "test", c.SceneId, "test", "test", placements, namingVersion: 42));
        Check.Equal(saved, JsonSerializer.Serialize(c.Board, JsonFiles.Options));
        var setup = RuntimeEncounters.Prepare(c, local, MapScale.TacticalGrid(local), "test", c.SceneId, "test", "test", placements, namingVersion: 42);
        setup = RuntimeEncounters.Establish(c, local, setup, placements, new RulesEngine(new SequenceDice()));
        Check.True(setup.PreservesMapScale);
        Check.Equal(local.Title, SharedBoard.Project(c, local).Map.Title);
        Check.Equal(.1, MapScale.FeetPerPixel(SharedBoard.Project(c, local).Map.Grid));
        var preparation = BoardCombat.Prepare(c, setup.Definition, local)!;
        Check.Equal(20, preparation.Layout.Width);
        Check.Equal(playerId, preparation.Units.Single(u => u.Team == "party").BoardEntityId);
        string enemyId = preparation.Units.Single(u => u.Team == "enemy").BoardEntityId!;
        var enemy = SharedBoard.Find(c, enemyId);
        c.Board.Entities[c.Board.Entities.IndexOf(enemy)] = enemy with { Statistics = enemy.Statistics! with { HitPoints = 7 } };
        SharedBoard.Execute(c, town, new("overview", c.Version, town.Id, "spawn", Spawns:
            [new(enemyId, "creature", new("existing"), new("ignored"), .4, .7)]));
        Check.Equal(7, SharedBoard.Project(c, local).Tokens.Single(t => t.Id == enemyId).HitPoints);
        Check.Equal("M", SharedBoard.Project(c, local).Tokens.Single(t => t.Id == enemyId).Size);
        Check.Equal(7, BoardCombat.Prepare(c, setup.Definition, local)!.Units.Single(u => u.Team == "enemy").HitPoints);
        c.Board.SelectedMaps = new() { [c.SceneId] = local.Id };
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        SharedBoard.ValidateState(c); RuntimeEncounters.ValidateState(c);
        Check.Equal(local.Id, SharedBoard.SelectedMapId(c));
        Check.Equal(.2, SharedBoard.Project(c, town).Tokens.Single(t => t.Id == playerId).X);
        Check.Equal(.375, SharedBoard.Project(c, local).Tokens.Single(t => t.Id == enemyId).X);
        SharedBoard.Execute(c, town, new("overview-move", c.Version, town.Id, "move", playerId, Destination: new(.25, .65)));
        Check.Equal(.25, SharedBoard.Project(c, town).Tokens.Single(t => t.Id == playerId).X);
        Check.Equal(.125, SharedBoard.Project(c, local).Tokens.Single(t => t.Id == playerId).X);
        SharedBoard.ValidateState(c);
        var origin = SharedBoard.PlacementOn(SharedBoard.Find(c, playerId), town.Id)!;
        c.Board!.Moves.Add(new(Id(), playerId, c.ActingActorId, c.SceneId, origin,
            origin with { X = .5 }, Id(), "pending"));
        Check.Equal(1, SharedBoard.Project(c, town).PendingMoves.Length);
        Check.Equal(0, SharedBoard.Project(c, local).PendingMoves.Length);
        return Task.CompletedTask;
    }

    public static async Task DefaultCurrentMapCombatAndConsentRestart()
    {
        var dice = new SequenceDice(18, 1, 1);
        var h = await Host.Start(dice: dice);
        try
        {
            var document = StandardCombatTests.Document("withdraw");
            var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("当前图开战", "Arden",
                Adventure: document, Prompts: TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden")));
            Check.Equal(HttpStatusCode.Created, response.StatusCode);
            var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; string id = owner.Snapshot.Id;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var maps = h.App.Services.GetRequiredService<MapCatalog>();
            MapAssetView Install(string title)
            {
                var m = maps.Create(id, new(Id(), ImportedMapTests.Spec() with { Title = title }));
                m = maps.Import(id, m.Id, new(Id(), m.Version), SharedBoardTests.MapPng(1000, 800));
                m = maps.ConfigureScenes(id, m.Id, new(Id(), m.Version, ["causeway"]), ["causeway"]);
                m = maps.ConfigureGrid(id, m.Id, new(Id(), m.Version, Local().Grid, "tactical"));
                return maps.Publish(id, m.Id, new(Id(), m.Version, true, true));
            }
            var older = Install("旧局部图"); var current = Install("当前局部图");
            string encounter = document.Scenes.Single(s => s.Id == "causeway").Encounter!.Id;
            var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version,
                current.Id, "spawn", Spawns: [new("", "creature", new("player", "player"), new("self"), .125, .3125, "player"),
                    new("", "creature", new("enemy", "guardian", encounter), new("石牙"), .375, .3125),
                    new("", "creature", new("enemy", "guardian", encounter), new("灰皮"), .625, .5125)]));
            await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), placed.Board.Version,
                older.Id, "spawn", Spawns: [new(placed.Result.EntityIds[0], "creature", new("existing"), new("ignored"), .8, .8)]));
            var library = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
            Check.Equal(current.Id, library.SelectedMapId);
            var proposed = await h.Act((await h.Get(id))!, "combat.start");
            Check.Equal("awaiting_roll", proposed.Resolution.Status);
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                Check.True(c.Board!.SelectedMaps is null);
                Check.Equal(older.Id, c.Board.Entities.Single(e => e.ActorId == c.ActingActorId).Placement!.MapId);
                Check.True(c.PendingRolls.Single(r => r.Status == "pending").UseCurrentBoardMap);
                return Task.FromResult(true);
            }, default);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var ready = (await h.Get(id))!;
            var started = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), ready.Version, ready.PendingRoll!.Id, "roll"));
            Check.Equal("active", started.Snapshot.Combat!.Status);
            Check.Equal(current.Id, started.Snapshot.Combat.BoardLayout!.MapId);
            Check.Equal(20, started.Snapshot.Combat.Width);
            // A missing frozen image cannot silently turn another valid map into the active battlefield.
            maps = h.App.Services.GetRequiredService<MapCatalog>();
            maps.ConfigureGrid(id, current.Id, new(Id(), current.Version, current.Grid, "tactical"));
            library = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
            Check.True(string.IsNullOrEmpty(library.SelectedMapId));
            Check.True(maps.CapturePlayerBoard(id, "causeway", [], current.Id, allowFallback: false) is null);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task MetadataHttpRestartAndReplay()
    {
        var h = await Host.Start();
        try
        {
            var owner = await h.Create(); string id = owner.Snapshot.Id;
            var town = SharedBoardTests.Install(h, id); var local = SharedBoardTests.Install(h, id);
            var townGrid = new MapGrid { Type = "none", CellPixels = 128, Distance = 50, Units = "meters", ScaleBasis = new("source", "原图比例尺：此线段50米") };
            var localGrid = new MapGrid { Type = "square", CellPixels = 100, Distance = 10, Units = "feet", OffsetX = 4, OffsetY = 6, ScaleBasis = new("dm", "本场局部空间采用") };
            var townRequest = new ConfigureMapGridRequest(Id(), town.Version, townGrid, "settlement");
            var localRequest = new ConfigureMapGridRequest(Id(), local.Version, localGrid, "tactical");
            town = await Post<MapAssetView>(h, id, $"maps/{town.Id}/grid", townRequest);
            local = await Post<MapAssetView>(h, id, $"maps/{local.Id}/grid", localRequest);
            Check.True(!town.Published && !local.Published);
            Check.Equal("settlement", town.Purpose); Check.Equal("tactical", local.Purpose);
            Check.Equal(townGrid, town.Grid); Check.Equal(localGrid, local.Grid);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{town.Id}/grid", townRequest with { RequestId = Id() })).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{town.Id}/grid", townRequest with { Purpose = "region" })).StatusCode);
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{local.Id}/grid", new ConfigureMapGridRequest(Id(), local.Version, localGrid with { ScaleBasis = new("unknown", "未确定") }, "tactical"))).StatusCode);
            town = await Post<MapAssetView>(h, id, $"maps/{town.Id}/publish", new PublishMapRequest(Id(), town.Version, true, true));
            local = await Post<MapAssetView>(h, id, $"maps/{local.Id}/publish", new PublishMapRequest(Id(), local.Version, true, true));
            var guest = await HarnessBoundaryTests.Guest(h, owner);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{town.Id}/grid", new ConfigureMapGridRequest(Id(), town.Version, townGrid, "region"))).StatusCode);
            var published = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
            Check.Equal(townGrid, published.Maps.Single(m => m.Id == town.Id).Grid);
            Check.Equal(localGrid, published.Maps.Single(m => m.Id == local.Id).Grid);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<MapAssetView>(h, id, $"maps/{town.Id}/grid", townRequest);
            Check.Equal(town.Version, replay.Version); Check.True(replay.Published); Check.Equal(townGrid, replay.Grid);
            var restored = h.App.Services.GetRequiredService<MapCatalog>().Get(id, local.Id, true);
            Check.Equal(localGrid, restored.Grid); Check.Equal("tactical", restored.Purpose);
            var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{local.Id}/board"))!;
            Check.Equal("tactical", board.Map.Purpose); Check.Equal(.1, MapScale.FeetPerPixel(board.Map.Grid));
            var snapshot = (await h.Get(id))!;
            await Post<DiceRealm.Server.Application.SelectMapResponse>(h, id, $"maps/{town.Id}/select",
                new DiceRealm.Server.Application.SelectMapRequest(Id(), snapshot.Version, town.Version));
            await Post<MapAssetView>(h, id, $"maps/{town.Id}/grid", new ConfigureMapGridRequest(Id(), town.Version, townGrid, "settlement"));
            var fallback = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
            Check.Equal(local.Id, fallback.SelectedMapId);
            var capture = h.App.Services.GetRequiredService<MapCatalog>().CapturePlayerBoard(id, "harbor", [], town.Id);
            Check.Equal(local.Id, capture!.Map.Id); Check.True(capture.Png.Length > 0);
        }
        finally { await h.DisposeAsync(); }
    }
}
