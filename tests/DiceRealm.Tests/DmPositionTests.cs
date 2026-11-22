using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class DmPositionTests
{
    public static async Task OpeningPlacesOnceBeforeNarrative()
    {
        string mapId = "";
        var model = new Model((call, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            Check.True(frame.GetProperty("opening").GetProperty("instruction").GetString()!.Contains("DM-chosen"));
            Check.True(request.Tools.Any(t => t.Name == "token_spawn"));
            Check.True(!request.Tools.Any(t => t.Name == "token_move"));
            if (call is 1 or 4) return Tool("opening_commit", new OpeningNarrativeArgs("Arden站在门边，光线落在脚下。", "你想起了来时收到的口信。"));
            if (call == 2) Check.True(request.Messages.Last(m => m.Role == "tool").Content.Contains("opening_placement_required"));
            return Tool("token_spawn", new HarnessSpawnArgs(mapId, [new("", "creature", new("player", "player"), new("ignored"), .21, .34, "player")]));
        });
        var dice = new SequenceDice();
        var h = await Host.Start(dice: dice, configure: Configure(model));
        try
        {
            var owner = await Create(h, TestContent.Document with { Opening = new("harbor", ["harbor"]) });
            string id = owner.Snapshot.Id; mapId = SharedBoardTests.Install(h, id).Id;
            var command = new StartOpeningRequest(Id(), owner.Snapshot.Version);
            var opening = await Post<AdventureSessionView>(h, id, "adventure/opening", command);
            var run = await Settled(h, id, opening.SessionId);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error); Check.Equal(4, model.Calls);
            Check.True(model.Requests.Last().Messages.Any(m => m.Role == "tool" && m.Content.Contains("opening_placement_unavailable")));
            var after = (await h.Get(id))!;
            Check.Equal(owner.Snapshot.Version + 2, after.Version); Check.Equal(0, dice.Count);
            Check.True(after.PendingIntent is null && after.PendingRoll is null && after.Opening?.Needed == false);
            var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
            Check.Equal(1, board.Tokens.Length); Check.Equal(.21, board.Tokens[0].X);
            var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            Check.True(page.Entries.Length == 0, "Initial position must not invent a player action.");
            string root = h.Root; await h.DisposeAsync();
            h = await Host.Start(root, dice: dice, configure: Configure(model));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<AdventureSessionView>(h, id, "adventure/opening", command)).Replayed);
            Check.Equal(after.Version, (await h.Get(id))!.Version); Check.Equal(4, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task PartyPlacementAndMovementWithoutConsent()
    {
        string mapId = "", guestActor = "", guestEntity = "";
        var model = new Model((call, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            Check.True(frame.GetProperty("narrativeContract").GetString()!.Contains("不含骰点、DC"));
            if (call == 1)
            {
                var sources = frame.GetProperty("board").GetProperty("sources");
                Check.True(sources.EnumerateArray().Any(s => s.GetProperty("id").GetString() == guestActor));
                return Tool("token_spawn", new HarnessSpawnArgs(mapId,
                    [new("", "creature", new("player", "player"), new("owner"), .2, .3, "player"),
                     new("", "creature", new("player", guestActor), new("guest"), .4, .3, guestActor)]));
            }
            guestEntity = frame.GetProperty("board").GetProperty("state").GetProperty("tokens").EnumerateArray()
                .Single(t => t.GetProperty("actorId").GetString() == guestActor).GetProperty("id").GetString()!;
            if (call is 2 or 3) return Tool("token_move", new { mapId, entityId = guestEntity, destination = new { x = call == 2 ? .6 : .7, y = .5 }, path = new[] { new { x = .5, y = .4 } } });
            return Tool("world_record", new NarrativeHarnessArgs("Arden与同伴停在路旁。", [], Private: "你望见路旁的灯火。"));
        });
        var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var guest = await HarnessBoundaryTests.Guest(h, owner); guestActor = guest.Snapshot.Party!.SelfActorId;
        var map = SharedBoardTests.Install(h, id); mapId = map.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var before = (await h.Get(id))!;
        var manual = new BoardCommandRequest(Id(), before.Version, mapId, "spawn", Spawns:
            [new("", "creature", new("player", guestActor), new("guest"), .9, .9, guestActor)], ExpectedMapVersion: map.Version);
        using (var denied = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", manual))
        {
            Check.Equal(HttpStatusCode.Conflict, denied.StatusCode);
            Check.True((await denied.Content.ReadAsStringAsync()).Contains("board_dm_placement_required"));
        }
        Check.Equal(before.Version, (await h.Get(id))!.Version);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var input = new HarnessInputRequest(Id(), before.Version, "观察眼前的道路。");
        var run = await Post<HarnessRunView>(h, id, "harness/runs", input);
        run = await Settled(h, id, run.Id);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + model.Failure); Check.Equal(4, model.Calls);
        var after = (await h.Get(id))!;
        Check.True(after.PendingIntent is null && after.PendingRoll is null); Check.Equal(0, dice.Count);
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
        Check.Equal(2, board.Tokens.Length); Check.Equal(.7, board.Tokens.Single(t => t.ActorId == guestActor).X);
        Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed); Check.Equal(4, model.Calls);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var ownMove = new BoardCommandRequest(Id(), after.Version, mapId, "move", guestEntity, Destination: new(.8, .5), ExpectedMapVersion: map.Version);
        var moved = await Post<BoardCommandResponse>(h, id, "board/commands", ownMove);
        Check.Equal(.8, moved.Board.Tokens.Single(t => t.ActorId == guestActor).X);
        using var crossSeat = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", ownMove with
        { RequestId = Id(), ExpectedVersion = moved.Board.Version, EntityId = board.Tokens.Single(t => t.ActorId == "player").Id });
        Check.Equal(HttpStatusCode.Forbidden, crossSeat.StatusCode);
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
        try
        {
            await game.HarnessTool(id, guest.AccessToken, guestActor, Id(), "old", auth.Version, Id(), Id(),
                new("token_move", HarnessJson.Element(new { mapId, entityId = board.Tokens.Single(t => t.ActorId == "player").Id, destination = new { x = .9, y = .9 } }), "old"),
                [], default, auth.Profile, 38, contextAlreadyRead: true, suppliedBoardMap: board.Map);
            throw new Exception("v38 unexpectedly gained cross-player authority");
        }
        catch (GameException e) { Check.Equal("forbidden", e.Code); }
        Check.Equal(moved.Board.Version, (await h.Get(id))!.Version);
    }
}
