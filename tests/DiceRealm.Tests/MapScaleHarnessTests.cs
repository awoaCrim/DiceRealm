using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class MapScaleHarnessTests
{
    private static MapAssetView Install(Host h, string campaign, string purpose, double distance)
    {
        var catalog = h.App.Services.GetRequiredService<MapCatalog>();
        var map = SharedBoardTests.Install(h, campaign, png: SharedBoardTests.MapPng(1000, 800));
        map = catalog.ConfigureGrid(campaign, map.Id, new(Id(), map.Version,
            new() { Type = "square", CellPixels = 100, Distance = distance, Units = "feet", ScaleBasis = new("dm", "隔离本场尺度") }, purpose));
        return catalog.Publish(campaign, map.Id, new(Id(), map.Version, true, true));
    }

    public static async Task SelectMapReceiptAndFrozenImage()
    {
        const string source = "local-encounter", quote = "仓房旁站着一具骷髅。";
        string localId = "", townId = "", actor = "", entityId = ""; int localVersion = 0;
        Exception? modelFailure = null;
        var model = new Model((call, request) =>
        {
            try
            {
            var previousTool = request.Messages.LastOrDefault(m => m.Role == "tool");
            if (previousTool?.IsError == true) throw new Exception("Previous tool failed: " + previousTool.Content);
            var board = HarnessExecutionProtocolTests.Frame(request).GetProperty("board");
            var map = board.GetProperty("state").GetProperty("map");
            Check.Equal(call <= 2 ? townId : localId, map.GetProperty("id").GetString());
            Check.Equal(call <= 2 ? "settlement" : "tactical", map.GetProperty("purpose").GetString());
            Check.Equal(call <= 2 ? 50d : 5d, map.GetProperty("grid").GetProperty("distance").GetDouble());
            Check.Equal("dm", map.GetProperty("grid").GetProperty("scaleBasis").GetProperty("kind").GetString());
            Check.Equal(2, board.GetProperty("maps").GetArrayLength());
            Check.True(request.Messages.Last().Images.Length > 0);
            if (call is 1 or 3 or 5) return Tool("context_read");
            if (call == 2) return Tool("map_select", new { mapId = localId, mapVersion = localVersion });
            if (call == 4)
            {
                Check.Equal(0, board.GetProperty("state").GetProperty("tokens").GetArrayLength()); // Selecting did not teleport.
                return Tool("token_spawn", new { mapId = localId, spawns = new[] {
                    new { existingId = entityId, kind = "creature", source = new { kind = "existing" }, appearance = new { name = "unchanged" }, x = .125, y = .3125 }
                } });
            }
            if (call == 6)
            {
                var player = board.GetProperty("state").GetProperty("tokens").EnumerateArray().Single();
                Check.Equal(entityId, player.GetProperty("id").GetString()); Check.Equal(.125, player.GetProperty("x").GetDouble());
                return Tool("encounter_prepare", new HarnessEncounterPrepareV42(localId, source, quote, "采用已保存局部尺度，明确布置敌方。",
                    [new("xmm:skeleton", "石牙", "engage", .375, .3125)], []));
            }
            Check.Equal(7, call);
            Check.Equal(2, board.GetProperty("state").GetProperty("tokens").GetArrayLength());
            return Tool("world_record", new NarrativeHarnessArgs("局部站位已经记录。", []));
            }
            catch (Exception ex) { modelFailure = ex; throw; }
        });
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(h, TestContent.Document with { InitialKnowledge = [new(source, "clue", "局部敌情", quote, "harbor", "host")] });
            string id = owner.Snapshot.Id;
            var local = Install(h, id, "tactical", 10); localId = local.Id; localVersion = local.Version;
            var town = Install(h, id, "settlement", 50); townId = town.Id;
            actor = owner.Snapshot.Party!.SelfActorId;
            var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version,
                townId, "spawn", Spawns: [new("", "creature", new("player", actor), new("self"), .2, .7, actor)], ExpectedMapVersion: town.Version));
            entityId = placed.Result.EntityIds.Single();
            var input = new HarnessInputRequest(Id(), placed.Board.Version, "使用已有仓房局部图，明确布置我的位置与已知敌人，暂不开战。");
            // This test freezes the v42 preparation-and-layout contract; v46 prepares perception first.
            var run = await StartHistorical(h, id, input, 42);
            run = await Settled(h, id, run.Id, 1600);
            if (modelFailure is not null) throw new Exception("Scripted model assertion failed", modelFailure);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error + "/calls=" + model.Calls); Check.Equal(7, model.Calls);
            var library = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
            Check.Equal(localId, library.SelectedMapId);
            Check.Equal(50d, library.Maps.Single(m => m.Id == townId).Grid.Distance);
            Check.Equal(10d, library.Maps.Single(m => m.Id == localId).Grid.Distance);
            var townBoard = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{townId}/board"))!;
            Check.Equal(.2, townBoard.Tokens.Single().X); Check.Equal(entityId, townBoard.Tokens.Single().Id);
            var before = (await h.Get(id))!;
            var select = new SelectMapRequest(Id(), before.Version, town.Version);
            var selected = await Post<SelectMapResponse>(h, id, $"maps/{townId}/select", select);
            Check.Equal(townId, selected.SelectedMapId);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/maps/{localId}/select", select with { RequestId = Id(), ExpectedMapVersion = local.Version })).StatusCode);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<SelectMapResponse>(h, id, $"maps/{townId}/select", select)).Replayed);
            Check.Equal(townId, (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!.SelectedMapId);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed); Check.Equal(7, model.Calls);
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                Check.Equal(2, c.Board!.Entities.Count); Check.True(RuntimeEncounters.Current(c)!.PreservesMapScale);
                Check.Equal(.1, MapScale.FeetPerPixel(RuntimeEncounters.Current(c)!.Layout!.Grid));
                return Task.FromResult(true);
            }, default);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task FrozenMetadataVersions()
    {
        var model = new Model((_, _) => throw new Exception("No model calls"));
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var local = Install(h, id, "tactical", 10);
        string actor = owner.Snapshot.Party!.SelfActorId;
        var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version,
            local.Id, "spawn", Spawns: [new("", "creature", new("player", actor), new("self"), .2, .3, actor)], ExpectedMapVersion: local.Version));
        var game = h.App.Services.GetRequiredService<GameService>();
        foreach (int contract in new[] { 27, 35, 41, 42, 50, 51 })
        {
            var frame = await game.ReadHarnessExecution(id, owner.AccessToken, actor, Id(), "查看当前地图", placed.Board.Version, default, contract);
            HarnessExecutionProtocol.Validate(frame, placed.Board.Version, contract);
            var board = frame.Board!;
            Check.Equal(local.Id, board.State!.Map.Id);
            Check.Equal(.1, MapScale.FeetPerPixel(board.State.Map.Grid));
            if (contract < 42)
            {
                Check.True(board.Maps is null && board.State.Map.Purpose is null && board.State.Map.Grid.ScaleBasis is null);
                Check.True(board.State.Tokens.All(t => t.Size is null));
            }
            else
            {
                Check.Equal("tactical", board.State.Map.Purpose); Check.Equal("dm", board.State.Map.Grid.ScaleBasis!.Kind);
                Check.Equal(contract >= 51 ? 5d : 10d, board.Maps!.Single().Grid.Distance); Check.Equal(5d, board.State.Map.Grid.Distance);
                if (contract >= 51)
                {
                    Check.Equal(board.State.Map.Grid, board.Maps!.Single().Grid);
                    Check.True(board.Notice.Contains("effective grid"));
                    Check.Equal(10d, local.Grid.Distance); // The original asset calibration is not rewritten.
                }
                Check.True(board.State.Tokens.Single().Size is not null);
            }
        }
        Check.Equal(placed.Board.Version, (await h.Get(id))!.Version); Check.Equal(0, model.Calls);
    }

    private static AutomaticMapResponse ReadMap(HarnessToolOutcome outcome)
    {
        using var json = JsonDocument.Parse(outcome.Reply.Content);
        return new(json.RootElement.GetProperty("version").GetInt32(),
            HarnessJson.Read<AutomaticMapView>(json.RootElement.GetProperty("map")));
    }

    private sealed class Images : IMapImageGenerator
    {
        public bool Enabled => true;
        public string CacheIdentity => "per-map-scale-isolated";
        public int Calls;
        public Task<byte[]> Generate(MapGenerationJob asset, CancellationToken cancellationToken)
        { Calls++; return Task.FromResult(SharedBoardTests.MapPng(1200, 800)); }
    }

    public static async Task LocalRequestBesideTownAndReplay()
    {
        var images = new Images(); var model = new Model((_, _) => throw new Exception("No text provider calls expected"));
        var configure = Configure(model); var h = await Host.Start(images: images, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var town = Install(h, id, "settlement", 50);
            var game = h.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            string command = Id(), fingerprint = "isolated-original-request";
            Task<HarnessToolOutcome> Request(string key, string fp, string kind = "battle") => game.HarnessTool(id, owner.AccessToken, auth.ActorId,
                Id(), "需要仓房外的局部战术图。", auth.Version, key, fp,
                new("map_request", HarnessJson.Element(new { kind, purpose = "tactical", tacticalScale = new { longEdgeFeet = 120d } }), "map"),
                [], default, auth.Profile, 42, contextAlreadyRead: true);
            var first = await Request(command, fingerprint);
            var response = ReadMap(first);
            Check.True(response.Map.Id != town.Id); Check.True(response.Map.Status is "pending" or "generating");
            var catalog = h.App.Services.GetRequiredService<MapCatalog>();
            await AssetTests.Until(() => Task.FromResult(catalog.Get(id, response.Map.Id, true).Status == "ready"));
            var local = catalog.Get(id, response.Map.Id, true);
            Check.Equal("tactical", local.Purpose); Check.Equal("dm", local.Grid.ScaleBasis!.Kind); Check.True(!local.Grid.Uncalibrated && local.Published);
            Check.Equal(1200, local.Width); Check.Equal(800, local.Height);
            Check.Equal(120d, local.Width * MapScale.FeetPerPixel(local.Grid));
            Check.Equal(50d, catalog.Get(id, town.Id, true).Grid.Distance);
            Check.Equal(first.Reply.Content, (await Request(command, fingerprint)).Reply.Content);
            var reused = ReadMap(await Request(Id(), "isolated-second", "dungeon"));
            Check.Equal(local.Id, reused.Map.Id); Check.Equal("ready", reused.Map.Status); Check.Equal(1, images.Calls);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, configure: configure);
            game = h.App.Services.GetRequiredService<GameService>();
            Check.Equal(first.Reply.Content, (await Request(command, fingerprint)).Reply.Content);
            Check.Equal(1, images.Calls); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
