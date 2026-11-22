using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class SharedBoardIntentTests
{
    public static async Task PlayerIntentIsFrozenAndConfirmed()
    {
        string mapId = "", entityId = "";
        var model = new Model((_, _) => Tool("token_move", new { mapId, entityId, destination = new { x = .7, y = .6 } }));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id; var map = SharedBoardTests.Install(h, id); mapId = map.Id;
            var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, mapId, "spawn", Spawns:
                [new("", "creature", new("player", "player"), new("ignored"), .2, .3, "player")]));
            entityId = placed.Result.EntityIds.Single();
            // Even an erroneous model response to a non-movement question cannot move the player.
            var run = await StartHistorical(h, id, new(Id(), (await h.Get(id))!.Version, "这里只问一下附近有什么，不移动。"), 30);
            run = await Settled(h, id, run.Id); Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind);
            var s = (await h.Get(id))!; Check.Equal(1, s.PendingIntent!.Options.Length);
            var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
            Check.Equal(.2, board.Tokens.Single().X); Check.Equal(1, model.Calls);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version))).StatusCode);
            var confirm = new IntentResponseRequest(Id(), s.Version, s.PendingIntent.Id, "choose", s.PendingIntent.Options.Single().Id);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var committed = await Post<ActionResponse>(h, id, "intents/respond", confirm);
            Check.Equal("resolved", committed.Resolution.Status);
            board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
            Check.Equal(.7, board.Tokens.Single().X); Check.Equal(1, model.Calls);
            var replay = await Post<ActionResponse>(h, id, "intents/respond", confirm); Check.True(replay.Replayed);
            Check.Equal(committed.Snapshot.Version, replay.Snapshot.Version);
            Check.Equal(0, board.RecentOperations.Length);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task LegacyBoardRootsAreReadOnlyAndRemainPrivate()
    {
        await using var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("Read-only fixture must not call model"))));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var guest = await HarnessBoundaryTests.Guest(h, owner);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        int root = 0, hidden = 0; string actionId = Id();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            void Add(string intentId, bool published)
            {
                int sequence = c.Version + 1;
                var result = new Resolution("resolved", "board.spawn", "已摆放", null, [], IntentId: intentId);
                var origin = new ActionOrigin("旧版棋盘输入", "自由行动", "natural", "", "本人", c.SceneId, "场景", []);
                var first = new GameEvent(Id(), ++c.Version, "board.spawn", "已摆放", "", "system", DateTimeOffset.UtcNow,
                    result, c.ActingActorId, Origin: origin);
                var next = first with { Id = Id(), Sequence = ++c.Version, Kind = "board.move", Resolution = result with { Kind = "board.move" } };
                c.Events.Add(first); c.Events.Add(next);
                c.PendingIntents.Add(new() { Id = intentId, ActorId = c.ActingActorId, RootSequence = sequence, Source = "harness",
                    Text = origin.Input, Status = "completed", Published = published, Narrative = "旧版完整正文", NarrativeSource = "harness",
                    PrivateText = "PRIVATE_BOARD_ROOT", Result = next.Resolution, ResultOrigin = origin,
                    HarnessSteps = [new(first.Sequence, result, origin), new(next.Sequence, next.Resolution!, origin)] });
                Check.True(!ActivityRecords.IsRoot(first)); Check.True(ActivityRecords.IsRoot(c, first));
                Check.True(!ActivityRecords.IsRoot(c, next));
                Check.True(!ActivityRecords.IsRoot(c, first with { ActorId = "unrelated" }));
                Check.True(!ActivityRecords.IsRoot(c, first with { Resolution = result with { IntentId = Id() } }));
                if (published) root = sequence; else hidden = sequence;
            }
            Add(actionId, true); Add(Id(), false);
            return Task.FromResult(true);
        }, default);
        string db = Directory.GetFiles(h.Root, "*.sqlite", SearchOption.AllDirectories).Single(p => p.Contains(id));
        string hash = JsonFiles.Hash(File.ReadAllBytes(db));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var detail = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{id}/activity/{root}"))!;
        Check.Equal(actionId, detail.ActionId); Check.Equal("旧版完整正文", detail.Narrative);
        Check.Equal(2, detail.Steps!.Length); Check.Equal("PRIVATE_BOARD_ROOT", detail.PrivateText);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
        Check.Equal(1, page.Entries.Count(e => e.ActionId == actionId));
        Check.True(page.Entries.All(e => e.Sequence != hidden));
        detail = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{id}/activity/{root}"))!;
        Check.Equal("旧版完整正文", detail.Narrative); Check.Equal("", detail.PrivateText);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/activity/{hidden}")).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/activity/{root + 1}")).StatusCode);
        Check.Equal(hash, JsonFiles.Hash(File.ReadAllBytes(db)));
    }

    public static async Task ExplicitOwnPlacementExecutesOnceWithoutSecondConsent()
    {
        string mapId = "", entityId = "", operation = "move"; double x = .5; int phase = 0;
        var model = new Model((_, _) =>
        {
            if (++phase > 1) return Tool("world_record", new NarrativeHarnessArgs("已按本人明确位置保存棋子。", []));
            return operation == "move" ? Tool("token_move", new { mapId, entityId, destination = new { x, y = .5 } }) :
                Tool("token_spawn", new { mapId, spawns = new[] { new { existingId = "", kind = "creature", source = new { kind = "player", id = "player" }, actorId = "player", appearance = new { name = "本人" }, x = .5, y = .5 } } });
        });
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h); string id = owner.Snapshot.Id; mapId = SharedBoardTests.Install(h, id).Id;
        var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, mapId, "spawn", Spawns:
            [new("", "creature", new("player", "player"), new("本人"), .2, .3, "player")]));
        entityId = placed.Result.EntityIds.Single();
        var run = await Start(h, (await h.Get(id))!, "把我的棋子移到地图中央。");
        run = await Settled(h, id, run.Id); Check.Equal("completed", run.Status); Check.Equal(2, model.Calls);
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
        Check.Equal(.5, board.Tokens.Single().X); Check.Equal(0, board.RecentOperations.Length);
        Check.True((await h.Get(id))!.PendingIntent is null);
        var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
        var entry = activity.Entries.Single(e => e.ActionId == run.IntentId);
        Check.Equal("intent.request", entry.Kind); Check.Equal("已按本人明确位置保存棋子。", entry.Narrative);
        Check.Equal("board.move", entry.Steps!.Single().Result.Kind);
        var detail = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{id}/activity/{entry.Sequence}"))!;
        Check.Equal(entry.Narrative, detail.Narrative);
        phase = 0; operation = "spawn";
        run = await Start(h, (await h.Get(id))!, "请把我的棋子放到地图中央");
        run = await Settled(h, id, run.Id); Check.Equal("completed", run.Status);
        board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
        Check.Equal(1, board.Tokens.Length); Check.Equal(entityId, board.Tokens.Single().Id);
        // Coordinates invented by the model cannot consume the player's different target.
        phase = 0; operation = "move"; x = .7;
        run = await StartHistorical(h, id, new(Id(), (await h.Get(id))!.Version, "把我的棋子移到地图坐标(0.6,0.5)"), 30);
        run = await Settled(h, id, run.Id); Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind);
        board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
        Check.Equal(.5, board.Tokens.Single().X); Check.Equal(0, board.RecentOperations.Length);
    }

    public static async Task RestrictedCharacterCannotDirectlyCreateFirstPlacement()
    {
        string mapId = "";
        var model = new Model((_, _) => Tool("token_spawn", new { mapId, spawns = new[] { new { existingId = "", kind = "creature",
            source = new { kind = "player", id = "player" }, actorId = "player", appearance = new { name = "本人" }, x = .5, y = .5 } } }));
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h); string id = owner.Snapshot.Id; mapId = SharedBoardTests.Install(h, id).Id;
        await Post<ActionResponse>(h, id, "characters/adjust", new AdjustCharacterRequest(Id(), owner.Snapshot.Version, "player",
            "隔离回归：人物受擒抱但尚未有棋子", "test fixture", [new("condition", "Grappled", 1)]));
        var run = await StartHistorical(h, id, new(Id(), (await h.Get(id))!.Version, "把我的棋子放到地图中央"), 38);
        run = await Settled(h, id, run.Id); Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind);
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
        Check.Equal(0, board.Tokens.Length); Check.Equal(1, model.Calls);
    }

    public static async Task MapVersionsAndMissingCoordinates()
    {
        await using var h = await Host.Start(); var owner = await h.Create(); string id = owner.Snapshot.Id;
        var map = SharedBoardTests.Install(h, id);
        var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
            [new("", "object", new("custom"), new("Object"), .2, .3)]));
        string entity = placed.Result.EntityIds.Single(); int version = placed.Board.Version;
        var invalid = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", new
        { requestId = Id(), expectedVersion = version, expectedMapVersion = map.Version, mapId = map.Id, operation = "move", entityId = entity, destination = new { x = .8 } });
        Check.Equal(HttpStatusCode.BadRequest, invalid.StatusCode); Check.Equal(version, (await h.Get(id))!.Version);
        var move = new BoardCommandRequest(Id(), version, map.Id, "move", entity, Destination: new(.61, .62), Snap: true, ExpectedMapVersion: map.Version);
        var maps = h.App.Services.GetRequiredService<MapCatalog>();
        var newer = maps.ConfigureGrid(id, map.Id, new(Id(), map.Version, new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet" }));
        newer = maps.Publish(id, map.Id, new(Id(), newer.Version, true, true));
        var rejected = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", move);
        Check.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        Check.Equal("stale_board_map", JsonDocument.Parse(await rejected.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
        Check.Equal(version, (await h.Get(id))!.Version);
        var applied = await Post<BoardCommandResponse>(h, id, "board/commands", move with { RequestId = Id(), ExpectedMapVersion = newer.Version });
        Check.Equal(0, applied.Board.RecentOperations.Length);
        Check.Equal(.5625, applied.Board.Tokens.Single().X); Check.Equal(224d / 384, applied.Board.Tokens.Single().Y);
    }

    public static async Task ModelMapRaceRefreshesBeforeWrite()
    {
        Host? host = null; MapAssetView? map = null; string id = "", entityId = "";
        var model = new Model((call, request) =>
        {
            if (call == 1)
            {
                var maps = host!.App.Services.GetRequiredService<MapCatalog>();
                map = maps.ConfigureGrid(id, map!.Id, new(Id(), map.Version, new() { Type = "square", CellPixels = 32, Distance = 5, Units = "feet" }));
                map = maps.Publish(id, map.Id, new(Id(), map.Version, true, true));
                return Tool("token_move", new { mapId = map.Id, entityId, destination = new { x = .6, y = .5 }, snap = true });
            }
            var frame = HarnessExecutionProtocolTests.Frame(request);
            Check.Equal(map!.Version, frame.GetProperty("board").GetProperty("state").GetProperty("map").GetProperty("version").GetInt32());
            if (call == 2)
            {
                var reply = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content).RootElement;
                Check.Equal("refresh_required", reply.GetProperty("protocol").GetProperty("phase").GetString());
                Check.Equal(.2, frame.GetProperty("board").GetProperty("state").GetProperty("tokens")[0].GetProperty("x").GetDouble());
                return Tool("token_move", new { mapId = map.Id, entityId, destination = new { x = .6, y = .5 }, snap = true });
            }
            return Tool("world_record", new NarrativeHarnessArgs("已根据新地图重新提交并保存位置。", []));
        });
        await using var h = await Host.Start(configure: Configure(model)); host = h;
        var owner = await Create(h); id = owner.Snapshot.Id; map = SharedBoardTests.Install(h, id);
        var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
            [new("", "object", new("custom"), new("Object"), .2, .3)]));
        entityId = placed.Result.EntityIds.Single();
        var run = await Start(h, (await h.Get(id))!, "移动物体。"); run = await Settled(h, id, run.Id);
        Check.Equal("completed", run.Status); Check.Equal(3, model.Calls);
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{map.Id}/board"))!;
        Check.Equal(0, board.RecentOperations.Length);
        Check.Equal(.59375, board.Tokens.Single().X);
    }
}
