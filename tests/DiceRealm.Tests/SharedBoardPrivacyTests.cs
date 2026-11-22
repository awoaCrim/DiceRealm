using System.Net.Http.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class SharedBoardPrivacyTests
{
    public static async Task RevealDoesNotPublishHiddenHistory()
    {
        await using var h = await Host.Start(); var owner = await h.Create(); string id = owner.Snapshot.Id;
        var map = SharedBoardTests.Install(h, id);
        var result = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
            [new("", "object", new("custom"), new("Hidden object", Visibility: "gm"), .98765, .12345)]));
        string entity = result.Result.EntityIds.Single(), hiddenSpawn = result.Result.OperationId;
        result = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), result.Board.Version, map.Id, "move", entity, Destination: new(.87654, .23456)));
        string hiddenMove = result.Result.OperationId;
        result = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), result.Board.Version, map.Id, "update", entity, Appearance: new("Public object", Visibility: "player")));
        string reveal = result.Result.OperationId;
        var guest = await HarnessBoundaryTests.Guest(h, owner with { Snapshot = (await h.Get(id))! });
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{map.Id}/board"))!;
        Check.Equal(1, board.Tokens.Length);
        Check.True(!board.RecentOperations.Any(o => o.Id == hiddenSpawn || o.Id == hiddenMove));
        Check.Equal(0, board.RecentOperations.Length);
        Check.Equal(.87654, board.Tokens.Single().X);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        result = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), board.Version, map.Id, "move", entity, Destination: new(.4, .5)));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{map.Id}/board"))!;
        Check.Equal(0, board.RecentOperations.Length);
        Check.Equal(.4, board.Tokens.Single().X);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        int version = board.Version;
        bool rejected = false;
        try
        {
            await store.Access(id, owner.AccessToken, true, c =>
            {
                c.Board!.Entities.Add(c.Board.Entities[0]);
                return Task.FromResult(true);
            }, default);
        }
        catch (GameException) { rejected = true; }
        Check.True(rejected);
        board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{map.Id}/board"))!;
        Check.Equal(version, board.Version); Check.Equal(1, board.Tokens.Length); Check.Equal(.4, board.Tokens[0].X);
    }
}
