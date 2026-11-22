using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class NpcNamingTests
{
    private static string Json(object value) => JsonSerializer.Serialize(value, JsonFiles.Options);
    private static BoardSpawn Custom(string name, string kind = "creature") => new("", kind, new("custom"), new(name), .3, .4);
    private static MapAssetView Map() => new(Id(), "命名隔离图", "scene", "player", 3, "ready", true,
        768, 512, 768, 512, new() { Type = "none", Uncalibrated = true }, "", "fixture-image", "", 0, default, CurrentScene: true);
    private static AdventureDocument Document(bool standard = true)
    {
        var document = standard ? StandardCombatTests.Document() : TestContent.Document;
        return document with { StartSceneId = "causeway", Scenes = document.Scenes.Select(s => s.Id != "causeway" ? s : s with
        { Encounter = s.Encounter! with { When = new(), OnStart = [], Enemies = s.Encounter.Enemies.Select(e => e with { Name = "守卫1" }).ToArray() } }).ToArray() };
    }

    public static Task RuntimeNamesAndHiddenIdentity()
    {
        var map = Map(); var c = TestContent.Campaign("causeway");
        c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s with { Encounter = null }).ToArray() };
        SharedBoard.Execute(c, map, new(Id(), c.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("player", c.ActingActorId), new("ignored"), .125, .3125, c.ActingActorId)]));
        var placements = new[] {
            new EncounterPlacement("xmm:goblin-warrior", "地精伏兵1", "ranged", new(5.5 / 12, 2.5 / 8), "three-quarters-cover", "隔离夹具：处于密集掩护后的视线外"),
            new EncounterPlacement("xmm:goblin-warrior", "Goblin Warrior #2", "ranged", new(5.5 / 12, 4.5 / 8), "three-quarters-cover", "隔离夹具：处于密集掩护后的视线外") };
        var grid = new MapGrid { Type = "square", CellPixels = 64 };
        var terrain = new[] { new BattleCell(3, 2, "three-quarters-cover"), new BattleCell(3, 3, "three-quarters-cover") };
        var dice = new SequenceDice(15, 12, 20, 1); string before = Json(c);
        var old = RuntimeEncounters.Prepare(c, map, grid, "交锋", c.SceneId, "夹具依据", "夹具标尺", placements, terrain, namingVersion: 40);
        Check.True(old.Definition.Enemies.Select(e => e.Name).SequenceEqual(placements.Select(p => p.Name)));
        var setup = RuntimeEncounters.Prepare(c, map, grid, "交锋", c.SceneId, "夹具依据", "夹具标尺", placements, terrain);
        Check.Equal(before, Json(c)); Check.Equal(0, dice.Count);
        var names = setup.Definition.Enemies.Select(e => e.Name).ToArray();
        Check.Equal(2, names.Distinct().Count()); Check.True(names.All(n => !NpcNames.IsGeneric(n)));
        Check.True(setup.Definition.Enemies.Select(e => e.RulesId).SequenceEqual(old.Definition.Enemies.Select(e => e.RulesId)));
        setup = RuntimeEncounters.Establish(c, map, setup, placements, new RulesEngine(dice)); c.Version++;
        Check.Equal(2, dice.Count); Check.Equal(1, SharedBoard.Project(c, map, true).Tokens.Length);
        Check.True(c.Board!.Entities.Where(e => e.Source.Kind == "enemy").Select(e => e.Appearance.Name).SequenceEqual(names));
        var restored = JsonSerializer.Deserialize<Campaign>(Json(c), JsonFiles.Options)!;
        RuntimeEncounters.ValidateState(restored); SharedBoard.ValidateState(restored);
        Check.True(restored.RuntimeEncounters![0].Definition.Enemies.Select(e => e.Name).SequenceEqual(names));
        restored.RuntimeEncounters[0] = restored.RuntimeEncounters[0] with { EngagementReason = "隔离测试明确交锋" };
        restored.BoardMapContext = map;
        new CombatEngine(dice).Resolve(restored, "combat.start", "");
        Check.Equal(4, dice.Count); // two original Hide checks + PC and shared identical-monster initiative
        Check.True(restored.Combat!.Units.Where(u => u.Team == "enemy").Select(u => u.Name).SequenceEqual(names));
        string saved = Json(restored); _ = SharedBoard.Project(restored, map, true); Check.Equal(saved, Json(restored));
        return Task.CompletedTask;
    }

    public static async Task HttpIdentityReplayAndRestart()
    {
        var dice = new SequenceDice(); var h = await Host.Start(dice: dice);
        try
        {
            var owner = await h.Create(); string id = owner.Snapshot.Id; var map = SharedBoardTests.Install(h, id);
            string firstFallback = NpcNames.ForCreation("地精", new HashSet<string>());
            var npc = TestContent.Document.Npcs.First();
            var request = new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
                [Custom("伏兵1"), Custom(firstFallback), Custom("Twin"), Custom("Twin"), Custom("吕三2"), Custom("守卫1", "object"),
                 new("", "creature", new("npc", npc.Id), new("ignored display"), .4, .5),
                 new("", "creature", new("custom"), new("地精"), .5, .5, Build: FullCreationTests.Named("具名构筑")),
                 new("", "creature", new("player", "player"), new("ignored player"), .1, .1, "player")], ExpectedMapVersion: map.Version);
            var created = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", request);
            string[] ids = created.Result.EntityIds; string[] names = ids.Select(key => created.Board.Tokens.Single(t => t.Id == key).Name).ToArray();
            Check.True(!NpcNames.IsGeneric(names[0]) && names[0] != firstFallback);
            Check.Equal(firstFallback, names[1]); Check.Equal("Twin", names[2]); Check.Equal("Twin", names[3]); Check.True(ids[2] != ids[3]);
            Check.Equal("吕三2", names[4]); Check.Equal("守卫1", names[5]); Check.Equal(npc.Name, names[6]); Check.Equal("具名构筑", names[7]);
            Check.Equal(owner.Snapshot.Character!.Name, names[8]);
            var respawn = new BoardCommandRequest(Id(), created.Board.Version, map.Id, "spawn", Spawns:
                [new(ids[0], "creature", new("existing"), new("另一名字"), .7, .7)], ExpectedMapVersion: map.Version);
            var same = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", respawn);
            Check.Equal(names[0], same.Board.Tokens.Single(t => t.Id == ids[0]).Name);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", request);
            Check.True(replay.Replayed); Check.True(ids.SequenceEqual(replay.Result.EntityIds));
            Check.True(names.SequenceEqual(ids.Select(key => replay.Board.Tokens.Single(t => t.Id == key).Name)));
            var snapshot = (await h.Get(id))!;
            _ = await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{map.Id}/board");
            Check.Equal(snapshot.Version, (await h.Get(id))!.Version); Check.Equal(0, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }

    public static Task CombatRenameAndLegacyStart()
    {
        foreach (bool standard in new[] { false, true })
        foreach (int version in new[] { 40, 41 })
        {
            var c = TestContent.Campaign("causeway"); c.Adventure = Document(standard);
            var dice = new SequenceDice(20, 1, 1, 1); string source = Json(c.Adventure);
            new CombatEngine(dice).Resolve(c, "combat.start", "", version);
            var enemy = c.Combat!.Units.First(u => u.Team == "enemy");
            Check.Equal(version < 41, NpcNames.IsGeneric(enemy.Name)); Check.Equal(source, Json(c.Adventure));
            Check.Equal(1 + c.Adventure.Scenes.Single(s => s.Id == "causeway").Encounter!.Enemies.Length, dice.Count);
        }
        var map = Map(); var boardCampaign = TestContent.Campaign();
        var spawn = SharedBoard.Execute(boardCampaign, map, new(Id(), boardCampaign.Version, map.Id, "spawn", Spawns: [Custom("Twin"), Custom("Twin")]));
        var a = spawn.EntityIds[0]; var b = spawn.EntityIds[1];
        boardCampaign.Combat = new() { Id = Id(), Status = "active", Units = [new() { Id = a, BoardEntityId = a, Name = "Twin", Team = "enemy" },
            new() { Id = b, BoardEntityId = b, Name = "Twin", Team = "enemy" }], Log = [new(1, 1, "attack", a, "Twin原战报")] };
        string history = Json(boardCampaign.Combat.Log);
        SharedBoard.Execute(boardCampaign, map, new(Id(), boardCampaign.Version, map.Id, "update", a, Appearance: new("铁齿·格鲁克")));
        Check.Equal("铁齿·格鲁克", boardCampaign.Combat.Units[0].Name); Check.Equal("Twin", boardCampaign.Combat.Units[1].Name);
        Check.Equal(history, Json(boardCampaign.Combat.Log));
        SharedBoard.Execute(boardCampaign, map, new(Id(), boardCampaign.Version, map.Id, "update", a, Appearance: new("旧版外观名")), namingVersion: 40);
        Check.Equal("铁齿·格鲁克", boardCampaign.Combat.Units[0].Name);
        boardCampaign.Combat.Status = "victory";
        SharedBoard.Execute(boardCampaign, map, new(Id(), boardCampaign.Version, map.Id, "update", a, Appearance: new("后来的名字")));
        Check.Equal("铁齿·格鲁克", boardCampaign.Combat.Units[0].Name); Check.Equal(history, Json(boardCampaign.Combat.Log));
        return Task.CompletedTask;
    }

    public static async Task PendingInitiativeKeepsCreationPolicy()
    {
        foreach (bool legacy in new[] { false, true })
        {
            var dice = new SequenceDice(20, 1); var h = await Host.Start(dice: dice);
            try
            {
                var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("命名确认", "Arden", Adventure: Document(),
                    Prompts: TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden")));
                Check.Equal(HttpStatusCode.Created, response.StatusCode); var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                var staged = await h.Act(owner.Snapshot, "combat.start"); string id = owner.Snapshot.Id;
                Check.Equal(0, dice.Count);
                if (legacy)
                {
                    // Model an old persisted consent by deleting the new optional field, not by changing a public request.
                    await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
                    {
                        var old = JsonNode.Parse(Json(c.PendingRolls))!.AsArray();
                        foreach (var roll in old) roll!.AsObject().Remove("npcNamingVersion");
                        var rolls = JsonSerializer.Deserialize<List<PendingRoll>>(old.ToJsonString(), JsonFiles.Options)!;
                        Check.True(rolls.All(r => r.NpcNamingVersion == 0)); c.PendingRolls.Clear(); c.PendingRolls.AddRange(rolls);
                        return Task.FromResult(true);
                    }, default);
                }
                string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice);
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                var s = (await h.Get(id))!; var request = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
                var done = await Post<ActionResponse>(h, id, "rolls/respond", request);
                Check.Equal(legacy, NpcNames.IsGeneric(done.Snapshot.Combat!.Units.Single(u => u.Team == "enemy").Name));
                Check.Equal(2, dice.Count); Check.True((await Post<ActionResponse>(h, id, "rolls/respond", request)).Replayed); Check.Equal(2, dice.Count);
                Check.True(!Json(done.Snapshot).Contains("npcNamingVersion"));
            }
            finally { await h.DisposeAsync(); }
        }
    }

    public static async Task RealPiOldAndNewNames()
    {
        foreach (int version in new[] { 40, 41 })
        {
            string mapId = "", name = "", entityId = "";
            var model = new Model((call, request) =>
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                if (call == 1) return Tool("token_spawn", new { mapId, spawns = new[] { new { existingId = "", kind = "creature", source = new { kind = "custom" }, appearance = new { name = "守卫1" }, x = .3, y = .4 } } });
                var token = frame.GetProperty("board").GetProperty("state").GetProperty("tokens").EnumerateArray().Single();
                name = token.GetProperty("name").GetString()!; entityId = token.GetProperty("id").GetString()!;
                Check.Equal(version == 40, NpcNames.IsGeneric(name));
                if (call == 2) return Tool("token_read", new { entityId });
                if (call == 3) return Tool("world_record", new NarrativeHarnessArgs("守卫在路边。", [new("", "npc", "守卫1", "路边遇见的守卫。", "known", "harbor")]));
                Check.Equal(41, version); Check.Equal(4, call);
                var failure = request.Messages.Last(m => m.Role == "tool"); Check.True(failure.IsError == true && failure.Content.Contains("invalid_world_memory"));
                return Tool("world_record", new NarrativeHarnessArgs(name + "在路边。", [new("", "npc", name, "路边遇见的守卫。", "known", "harbor")]));
            });
            var configure = Configure(model, extra: b => { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
            var h = await Host.Start(configure: configure);
            try
            {
                var owner = await Create(h); string id = owner.Snapshot.Id; mapId = SharedBoardTests.Install(h, id).Id;
                var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "隔离命名协议回归");
                var run = await StartHistorical(h, id, input, version); run = await Settled(h, id, run.Id, 2400);
                Check.Equal("completed", run.Status); Check.Equal(version == 40 ? 3 : 4, model.Calls);
                var state = (await h.Get(id))!; Check.True(state.WorldMemory!.Any(m => m.Kind == "npc" && m.Name == name));
                Check.True(!state.Events.Any(e => e.Narrative == "守卫在路边。") || version == 40);
                string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
                Check.Equal(version == 40 ? 3 : 4, model.Calls);
                var detail = (await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{entityId}"))!; Check.Equal(name, detail.Name);
            }
            finally { await h.DisposeAsync(); }
        }
    }
}
