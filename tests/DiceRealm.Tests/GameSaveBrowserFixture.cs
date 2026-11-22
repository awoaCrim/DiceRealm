using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Isolated native-player fixture. Save/load/restart and player actions are exercised through
// the real clients; files below only provide reproducible injury/death scenario state.
internal static class GameSaveBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var model = new Model((call, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request); var self = frame.GetProperty("self");
            string actor = self.GetProperty("actorId").GetString()!, name = self.GetProperty("name").GetString()!;
            var board = frame.GetProperty("board").GetProperty("state"); string map = board.GetProperty("map").GetProperty("id").GetString()!;
            if (!board.GetProperty("tokens").EnumerateArray().Any(t => t.GetProperty("actorId").GetString() == actor))
                return Tool("token_spawn", new { mapId = map, spawns = new[] { new { existingId = "", kind = "creature", source = new { kind = "player", id = actor }, appearance = new { name }, x = .5, y = .5, actorId = actor } } });
            if (request.Tools.Any(t => t.Name == "opening_commit"))
                return Tool("opening_commit", new OpeningNarrativeArgs(frame.GetProperty("opening").GetProperty("writePublic").GetBoolean() ? "你们在港口集合，准备沿着小路出发。" : "", "行囊里夹着一张手写便笺：灯塔下见。"));
            return Tool("world_record", KnowledgeVisibilityTests.Story(name + "在港口观察了片刻，记下潮水与远处灯塔的位置。第" + call + "次观察。",
                KnowledgeVisibilityTests.Message([actor], "你独自读到便笺背面的短句：月落之前。")));
        });
        var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: GameSaveTests.ConfigurePi));
        AccountTests.SeedAdminFixture(h);
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(1200, 800));
        await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("player", PartyEngine.HostId), new("Arden"), .5, .5, ActorId: PartyEngine.HostId)]));
        await Post<ActionResponse>(h, id, "room", new ConfigureRoomRequest(Id(), (await h.Get(id))!.Version, true, "saves-ui-fixture"));
        var room = await h.Http.GetFromJsonAsync<RoomView>(GameSaveTests.Url(id, "room"));
        JsonFiles.Write(statePath, new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root, processId = Environment.ProcessId,
            campaignId = id, hostToken = owner.AccessToken, mapId = map.Id, roomNumber = room!.RoomNumber, sharedPassword = "saves-ui-fixture", fixture = "game-saves-isolated-real-pi-fake-text" });
        Console.WriteLine("Game save fixture ready. New player joins through UI. No paid providers.");
        while (!File.Exists(statePath + ".stop"))
        {
            foreach (string scenario in new[] { "injure", "dead-player", "all-dead" })
            {
                string input = statePath + "." + scenario;
                if (!File.Exists(input) || File.Exists(input + ".done")) continue;
                await GameSaveTests.Mutate(h, owner, c =>
                {
                    foreach (var (actor, character) in PartyEngine.Characters(c).ToArray())
                    {
                        if (actor == PartyEngine.HostId && scenario != "all-dead") continue;
                        PartyEngine.SetCharacter(c, actor, character with { HitPoints = scenario == "injure" ? 1 : 0, Conditions = scenario == "injure" ? [] : ["Dead", "Unconscious", "Prone"] });
                    }
                }, "隔离验收状态：" + scenario);
                File.WriteAllText(input + ".done", "applied");
            }
            try { JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 }); }
            catch (IOException) { } catch (UnauthorizedAccessException) { }
            await Task.Delay(300);
        }
        JsonFiles.Write(statePath + ".result", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
    }
}
