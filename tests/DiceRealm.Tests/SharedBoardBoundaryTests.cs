using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class SharedBoardBoundaryTests
{
    private static Task<T> Post<T>(Host h, string id, string path, object request) => SharedBoardTests.BoardPost<T>(h, id, path, request);
    public static async Task RulingAndBuildBoundaries()
    {
        var dice = new SequenceDice(); await using var h = await Host.Start(dice: dice);
        var owner = await h.Create(); string id = owner.Snapshot.Id; var map = SharedBoardTests.Install(h, id);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        var result = await Post<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("player", "player"), new("self"), .2, .3, "player"),
             new("", "creature", new("custom"), new("Built NPC"), .5, .3, Build: FullCreationTests.Named("Built NPC"))]));
        string playerId = result.Result.EntityIds[0], npcId = result.Result.EntityIds[1];
        var detail = (await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{npcId}"))!;
        Check.True(detail.Character is { Build: not null }); Check.Equal("", detail.ActorId);
        Check.Equal(0, (await h.Get(id))!.Party!.Members.Count(m => m.Character?.Name == "Built NPC"));
        Check.Equal(detail.Character!.HitPoints, detail.Statistics!.HitPoints);
        var forbidden = new BoardCommandRequest(Id(), result.Board.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("custom"), new("Forged NPC"), .4, .4, Character: detail.Character with { HitPoints = 9999 })]);
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", forbidden with { ExpectedMapVersion = map.Version })).StatusCode);
        await store.Access(id, owner.AccessToken, true, c =>
        {
            c.Character = c.Character! with { Conditions = ["Restrained"] };
            FixtureEvent(c); return Task.FromResult(true);
        }, default);
        var snapshot = (await h.Get(id))!;
        var move = new BoardCommandRequest(Id(), snapshot.Version, map.Id, "move", playerId, Destination: new(.4, .6), Path: [new(.3, .4)]);
        result = await Post<BoardCommandResponse>(h, id, "board/commands", move);
        Check.Equal("pending", result.Result.Status); Check.Equal(.2, result.Board.Tokens.Single(t => t.Id == playerId).X);
        Check.Equal(1, result.Board.PendingMoves.Length);
        var replay = await Post<BoardCommandResponse>(h, id, "board/commands", move);
        Check.True(replay.Replayed); Check.Equal(1, replay.Board.PendingMoves.Length);
        Check.Equal(result.Result.RulingId, replay.Result.RulingId);
        var respawn = new BoardCommandRequest(Id(), result.Board.Version, map.Id, "spawn", Spawns:
            [new(playerId, "creature", new("existing"), new("ignored"), .9, .9)]);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", respawn with { ExpectedMapVersion = map.Version })).StatusCode);
        var ruling = new ResolveRulingRequest(Id(), result.Board.Version, result.Result.RulingId, "board_move", "原移动限制已处理后结算原意图", "隔离测试裁定");
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rulings/respond", ruling)).StatusCode);
        Check.Equal(result.Board.Version, (await h.Get(id))!.Version);
        await store.Access(id, owner.AccessToken, true, c =>
        {
            c.Character = c.Character! with { Conditions = [] };
            FixtureEvent(c); return Task.FromResult(true);
        }, default);
        snapshot = (await h.Get(id))!;
        var settled = await Post<ActionResponse>(h, id, "rulings/respond", ruling with { ExpectedVersion = snapshot.Version });
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{map.Id}/board"))!;
        Check.Equal(.4, board.Tokens.Single(t => t.Id == playerId).X); Check.Equal(0, board.PendingMoves.Length);
        Check.Equal("resolved", settled.Resolution.Status); Check.True(settled.Resolution.Summary.Contains("实际落点"));
        var guest = await HarnessBoundaryTests.Guest(h, owner with { Snapshot = settled.Snapshot });
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        detail = (await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{npcId}"))!;
        Check.True(detail.Character is not null && detail.Character.Build is null && detail.Source is null);
        Check.True(!detail.CanControl); Check.Equal(0, dice.Count);
    }

    public static async Task StateOnlyCommandsAndLegacyHistory()
    {
        var h = await Host.Start();
        try
        {
            var owner = await h.Create(); string id = owner.Snapshot.Id, path = $"/api/v1/campaigns/{id}";
            var originalEvents = HarnessJson.Serialize(owner.Snapshot.Events);
            var map = SharedBoardTests.Install(h, id);
            var spawn = new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
                [new("", "object", new("custom"), new("Current object"), .1, .1)]);
            var result = await Post<BoardCommandResponse>(h, id, "board/commands", spawn);
            string entityId = result.Result.EntityIds.Single();
            BoardCommandRequest? lastMove = null;
            // More than 100 state-only versions must not evict the last actual story event.
            for (int i = 0; i < 105; i++)
            {
                lastMove = new(Id(), result.Board.Version, map.Id, "move", entityId, Destination: new(.2 + i * .001, .3));
                result = await Post<BoardCommandResponse>(h, id, "board/commands", lastMove);
            }
            Check.Equal(0, result.Board.RecentOperations.Length);
            var sheet = (await h.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            var gear = sheet.Equipment.First(e => e.Available);
            var equip = new CharacterPlayRequest(Id(), result.Board.Version, "equip", gear.Id, gear.Equipped ? 0 : 1);
            var equipped = await Post<ActionResponse>(h, id, "character/commands", equip);
            Check.Equal(!gear.Equipped, equipped.Snapshot.Character!.Inventory.Single(i => i.Id == gear.Id).Equipped);
            Check.Equal(originalEvents, HarnessJson.Serialize(equipped.Snapshot.Events));
            int version = equipped.Snapshot.Version;
            var journal = (await h.Http.GetFromJsonAsync<JournalPage>(path + "/journal?after=1&limit=2"))!;
            Check.Equal(0, journal.Events.Length); Check.Equal(version, journal.NextAfter); Check.True(!journal.HasMore);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>(path + "/activity?after=1&limit=2"))!;
            Check.Equal(0, activity.Entries.Length); Check.Equal(version, activity.NextAfter); Check.True(!activity.HasMore);
            var export = await h.Http.GetStringAsync(path + "/journal/export");
            Check.Equal(owner.Snapshot.Events.Length + 1, export.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
            string dbPath = Path.Combine(h.Root, "campaigns", id + ".sqlite");
            string Scalar(string sql)
            {
                using var db = new SqliteConnection("Data Source=" + dbPath + ";Mode=ReadOnly;Pooling=False"); db.Open();
                using var cmd = db.CreateCommand(); cmd.CommandText = sql;
                return Convert.ToString(cmd.ExecuteScalar())!;
            }
            Check.Equal(owner.Snapshot.Events.Length.ToString(), Scalar("SELECT count(*) FROM events"));
            Check.Equal("0", Scalar("SELECT count(*) FROM receipts WHERE json_type(json,'$.boardHistory') IS NOT NULL"));
            using (var state = JsonDocument.Parse(Scalar("SELECT json FROM state")))
            {
                Check.True(!state.RootElement.GetProperty("board").TryGetProperty("recentOperations", out _));
                Check.True(!state.RootElement.TryGetProperty("stateOnlyVersions", out _));
            }
            string beforeRestart = JsonFiles.Hash(File.ReadAllBytes(dbPath));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<BoardCommandResponse>(h, id, "board/commands", lastMove!);
            Check.True(replay.Replayed); Check.Equal(result.Result.OperationId, replay.Result.OperationId);
            Check.Equal(version, replay.Board.Version); Check.Equal(lastMove!.Destination!.X, replay.Board.Tokens.Single().X);
            Check.True((await Post<ActionResponse>(h, id, "character/commands", equip)).Replayed);
            Check.Equal(beforeRestart, JsonFiles.Hash(File.ReadAllBytes(dbPath)));
            Check.Equal(originalEvents, HarnessJson.Serialize((await h.Get(id))!.Events));
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/character/commands", equip with { Value = gear.Equipped ? 1 : 0 })).StatusCode);

            // Old history is retained on disk for compatibility, but never projected or extended.
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            string legacy = "";
            await store.Access(id, owner.AccessToken, true, c =>
            {
                var entity = c.Board!.Entities.Single();
                var old = new BoardOperation(Id(), c.Version, c.ActingActorId, "move",
                    [new(entity.Id, entity.Placement! with { X = .1 }, entity.Placement, entity.Appearance, entity.Appearance)]);
                c.Board = new() { Entities = c.Board.Entities, Moves = c.Board.Moves, RecentOperations = [old] };
                legacy = HarnessJson.Serialize(c.Board.RecentOperations);
                return Task.FromResult(true);
            }, default);
            result = await Post<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), version, map.Id, "move", entityId, Destination: new(.7, .4)));
            Check.Equal(0, result.Board.RecentOperations.Length); Check.Equal(.7, result.Board.Tokens.Single().X);
            await store.Access(id, owner.AccessToken, false, c =>
            {
                Check.Equal(legacy, HarnessJson.Serialize(c.Board!.RecentOperations!));
                return Task.FromResult(true);
            }, default);
            Check.Equal("0", Scalar("SELECT count(*) FROM receipts WHERE json_type(json,'$.boardHistory') IS NOT NULL"));
        }
        finally { await h.DisposeAsync(); }
    }

    private static void FixtureEvent(Campaign c)
    {
        c.Version++; c.Events.Add(new(Id(), c.Version, "fixture.rule", "isolated rule-owner state change", "", "test", DateTimeOffset.UtcNow, null));
    }
}
