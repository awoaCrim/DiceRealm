using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class SharedBoardCombatTests
{
    private static Task<T> Post<T>(Host h, string id, string path, object request) => SharedBoardTests.BoardPost<T>(h, id, path, request);
    private sealed class Dice : IDice
    {
        public int Count;
        public int Roll(int sides) { Count++; return sides == 20 ? 15 : Math.Min(4, sides); }
    }
    private static BoardPoint Point(int x, int y) => new((16 + (x + .5) * 64) / 768, (y + .5) * 64 / 512);
    private static async Task<CampaignSnapshot> Confirm(Host h, CampaignSnapshot s) =>
        (await Post<ActionResponse>(h, s.Id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
    private static Task<BoardView?> Board(Host h, string id, string map) => h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{map}/board");

    public static async Task ActualMapEncounterAndReentry()
    {
        var dice = new Dice(); Host h = await Host.Start(dice: dice);
        try
        {
            var document = StandardCombatTests.Document("withdraw");
            document = document with { Scenes = document.Scenes.Select(s => s.Encounter is null ? s : s with
            { Encounter = s.Encounter with { Repeatable = true, OnStart = [], Victory = new("隔离遭遇结束", []) } }).ToArray() };
            var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("共享棋盘战斗", "Arden", Adventure: document,
                Prompts: TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden")));
            Check.Equal(HttpStatusCode.Created, response.StatusCode);
            var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; string id = owner.Snapshot.Id;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var maps = h.App.Services.GetRequiredService<MapCatalog>();
            var map = maps.Create(id, new(Id(), ImportedMapTests.Spec()));
            map = maps.Import(id, map.Id, new(Id(), map.Version), SharedBoardTests.MapPng(768, 512));
            map = maps.ConfigureScenes(id, map.Id, new(Id(), map.Version, ["causeway"]), ["causeway"]);
            map = maps.ConfigureGrid(id, map.Id, new(Id(), map.Version, new() { Type = "square", CellPixels = 64, OffsetX = 16, OffsetY = 0, Distance = 5, Units = "feet", Uncalibrated = false }));
            map = maps.Publish(id, map.Id, new(Id(), map.Version, true, true));
            string encounter = document.Scenes.Single(s => s.Id == "causeway").Encounter!.Id;
            var startPoint = Point(1, 2); var aPoint = Point(3, 2); var bPoint = Point(8, 5);
            var created = await Post<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
                [new("", "creature", new("player", "player"), new("self"), startPoint.X, startPoint.Y, "player"),
                 new("", "creature", new("enemy", "guardian", encounter), new("同模板 A"), aPoint.X, aPoint.Y),
                 new("", "creature", new("enemy", "guardian", encounter), new("同模板 B"), bPoint.X, bPoint.Y)]));
            string player = created.Result.EntityIds[0], a = created.Result.EntityIds[1], b = created.Result.EntityIds[2];
            var s = (await h.Get(id))!;
            var proposed = await h.Act(s, "combat.start"); s = proposed.Snapshot;
            Check.Equal("awaiting_roll", proposed.Resolution.Status); Check.Equal(0, dice.Count); Check.True(s.Combat is null);
            s = await Confirm(h, s); Check.Equal(3, dice.Count);
            Check.Equal(11, s.Combat!.Width); Check.Equal(8, s.Combat.Height); Check.Equal(map.Id, s.Combat.BoardLayout!.MapId);
            Check.Equal(player, s.Combat.Units.Single(u => u.Id == "player").BoardEntityId);
            Check.True(s.Combat.Units.Any(u => u.Id == a) && s.Combat.Units.Any(u => u.Id == b));
            Check.Equal(startPoint.X, (await Board(h, id, map.Id))!.Tokens.Single(t => t.Id == player).X);
            var destination = Point(2, 2);
            var move = new BoardCommandRequest(Id(), s.Version, map.Id, "move", player, Destination: destination);
            var moved = await Post<BoardCommandResponse>(h, id, "board/commands", move);
            Check.Equal("applied", moved.Result.Status); Check.True(Math.Abs(destination.X - moved.Board.Tokens.Single(t => t.Id == player).X) < 1e-12);
            s = (await h.Get(id))!; Check.Equal(2, s.Combat!.Units.Single(u => u.Id == "player").X);
            Check.Equal(25, s.Combat.Units.Single(u => u.Id == "player").MovementRemaining); Check.Equal(3, dice.Count);
            Check.True((await Post<BoardCommandResponse>(h, id, "board/commands", move)).Replayed); Check.Equal(3, dice.Count);
            var attacked = await h.Act(s, "combat.attack", a); s = attacked.Snapshot; Check.Equal("awaiting_roll", attacked.Resolution.Status);
            Check.Equal(50, (await Board(h, id, map.Id))!.Tokens.Single(t => t.Id == a).HitPoints);
            s = await Confirm(h, s);
            var activeBoard = (await Board(h, id, map.Id))!; int hp = activeBoard.Tokens.Single(t => t.Id == a).HitPoints!.Value;
            Check.True(hp is > 0 and < 50); Check.Equal(50, activeBoard.Tokens.Single(t => t.Id == b).HitPoints);
            var detail = (await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{a}"))!;
            Check.Equal(hp, detail.Statistics!.HitPoints); Check.Equal(hp, s.Combat!.Units.Single(u => u.Id == a).HitPoints);
            int count = dice.Count; string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            s = (await h.Get(id))!; Check.Equal(hp, s.Combat!.Units.Single(u => u.Id == a).HitPoints); Check.Equal(count, dice.Count);
            for (int step = 0; step < 20 && s.Combat!.Status == "active"; step++)
            {
                var action = s.Combat.Standard?.Wait is not null ? new Intent("combat.react", "pass") : new Intent("combat.end_turn", "");
                s = (await h.Act(s, action.Kind, action.Target)).Snapshot;
            }
            Check.Equal("victory", s.Combat!.Status);
            var closed = (await Board(h, id, map.Id))!;
            Check.Equal(hp, closed.Tokens.Single(t => t.Id == a).HitPoints); Check.Equal(50, closed.Tokens.Single(t => t.Id == b).HitPoints);
            Check.True(!closed.Tokens.Single(t => t.Id == a).OnMap && !closed.Tokens.Single(t => t.Id == b).OnMap);
            Check.True(Math.Abs(destination.X - closed.Tokens.Single(t => t.Id == player).X) < 1e-12);
            var returned = await Post<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), s.Version, map.Id, "spawn", Spawns:
                [new(a, "creature", new("existing"), new("ignored"), aPoint.X, aPoint.Y), new(b, "creature", new("existing"), new("ignored"), bPoint.X, bPoint.Y)]));
            Check.Equal(hp, returned.Board.Tokens.Single(t => t.Id == a).HitPoints);
            s = (await h.Get(id))!; s = (await h.Act(s, "combat.start")).Snapshot; Check.Equal(count, dice.Count);
            s = await Confirm(h, s); Check.Equal(count + 3, dice.Count);
            Check.Equal(hp, s.Combat!.Units.Single(u => u.Id == a).HitPoints); Check.Equal(50, s.Combat.Units.Single(u => u.Id == b).HitPoints);
            Check.Equal(2, s.Combat.Units.Single(u => u.Id == "player").X);
        }
        finally { await h.DisposeAsync(); }
    }
}
