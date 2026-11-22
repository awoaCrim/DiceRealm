using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class MapIndependentPerceptionTests
{
    public static Task PreparationBindingAndState()
    {
        foreach (bool calibrated in new[] { false, true })
        foreach (bool anotherMap in new[] { false, true })
        {
            var grid = new MapGrid { Type = "square", CellPixels = 64, Distance = 5, Units = "feet", ScaleBasis = new("dm", "隔离战术尺度") };
            var map = new MapAssetView(Id(), "隔离地图", "scene", "player", 3, "ready", true, 768, 512, 768, 512,
                calibrated ? grid : new() { Type = "none", Uncalibrated = true }, "", "fixture-image-hash", "", 0, default,
                CurrentScene: true) { Purpose = calibrated ? "tactical" : "schematic" };
            var c = TestContent.Campaign("causeway");
            c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s with { Encounter = null }).ToArray() };
            c.Board = null; // No player placement is required to observe from the scene.
            string source = JsonSerializer.Serialize(c.Adventure, JsonFiles.Options);
            var positions = new[] {
                new EncounterPlacement("xmm:goblin-warrior", "枯牙", "ranged", new(5.5 / 12, 2.5 / 8), "three-quarters-cover", "隔离来源：灌木后脱离视线。"),
                new EncounterPlacement("xmm:goblin-warrior", "石耳", "ranged", new(5.5 / 12, 4.5 / 8), "three-quarters-cover", "隔离来源：灌木后脱离视线。") };
            var dice = new SequenceDice(10, 11, 20, 1, 1);
            var setup = RuntimeEncounters.Prepare(c, map, null, "隔离遭遇", c.SceneId, "隔离真实来源", "场景掩护及位置", positions, [], 46);
            Check.True(setup.Layout is null && c.Board is null && dice.Count == 0);
            setup = RuntimeEncounters.Establish(c, map, setup, positions, new RulesEngine(dice));
            Check.Equal(2, dice.Count); Check.True(c.Combat is null && setup.Layout is null);
            Check.True(setup.Definition.Enemies.All(e => e.X == -1 && e.Y == -1));
            Check.True(CombatAgentSessions.DelegatableEncounter(c) is null);
            Check.Equal(map.Grid, RuntimeEncounters.TacticalMap(c, map).Grid);
            string before = JsonSerializer.Serialize(c, JsonFiles.Options);
            Check.Throws<GameException>(() => RuntimeEncounters.Prepare(c, map, null, "重复", c.SceneId, "隔离真实来源", "不可重建", positions, [], 46));
            Check.Throws<GameException>(() => BoardCombat.Prepare(c, setup.Definition, map));
            EncounterConcealment.RefreshSight(c, map);
            Check.Equal(before, JsonSerializer.Serialize(c, JsonFiles.Options)); Check.Equal(2, dice.Count);
            RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
            c = JsonSerializer.Deserialize<Campaign>(before, JsonFiles.Options)!;
            RuntimeEncounters.ValidateState(c);
            var damaged = JsonSerializer.Deserialize<Campaign>(before, JsonFiles.Options)!;
            damaged.RuntimeEncounters![0] = damaged.RuntimeEncounters[0] with { ObservationMapId = null };
            Check.Throws<GameException>(() => RuntimeEncounters.ValidateState(damaged));
            var originalIds = c.Board!.Entities.Select(e => e.Id).ToArray();
            var originalStealth = HarnessJson.Serialize(RuntimeEncounters.Current(c)!.Concealment);
            c.Board.Entities[0] = c.Board.Entities[0] with { Statistics = c.Board.Entities[0].Statistics! with { HitPoints = 3, TemporaryHitPoints = 2, Conditions = ["Poisoned"] } };
            var tactical = map with { Id = anotherMap ? Id() : map.Id, Version = 5, Purpose = "tactical", Grid = grid };
            SharedBoard.Execute(c, tactical, new(Id(), c.Version, tactical.Id, "spawn", Spawns:
                [new("", "creature", new("player", c.ActingActorId), new("本人"), 1.5 / 12, 2.5 / 8, c.ActingActorId)], ExpectedMapVersion: tactical.Version));
            var binding = positions.Select(p => p with { HidingCover = null, HidingReason = null }).ToArray();
            before = JsonSerializer.Serialize(c, JsonFiles.Options);
            Check.Throws<GameException>(() => RuntimeEncounters.BindLayout(c, tactical, setup.Definition.Id, "缺少实际掩护", binding, []));
            Check.Equal(before, JsonSerializer.Serialize(c, JsonFiles.Options)); Check.Equal(2, dice.Count);
            // Concrete diagnostics never change the original instance/roll/party position.
            foreach (string obstacle in new[] { "blocked", "half-cover", "three-quarters-cover" })
            {
                string message = "";
                try { RuntimeEncounters.BindLayout(c, tactical, setup.Definition.Id, "冲突诊断", binding, [new(5, 2, obstacle)], 51); }
                catch (GameException error) { Check.Equal("encounter_setup_unavailable", error.Code); message = error.Message; }
                Check.True(message.Contains("格(5,2)") && message.Contains(originalIds[0]) && message.Contains(obstacle));
                Check.True(message.Contains(tactical.Id) && message.Contains("version=5") && message.Contains("cellPixels=64") && message.Contains("size=12x8"));
                Check.Equal(before, JsonSerializer.Serialize(c, JsonFiles.Options)); Check.Equal(2, dice.Count);
            }
            var overlapping = binding.ToArray(); overlapping[1] = overlapping[1] with { Position = overlapping[0].Position };
            string overlap = "";
            try { RuntimeEncounters.BindLayout(c, tactical, setup.Definition.Id, "重叠诊断", overlapping, [], 51); }
            catch (GameException error) { Check.Equal("encounter_setup_unavailable", error.Code); overlap = error.Message; }
            Check.True(overlap.Contains("格(5,2)单位重叠") && originalIds.All(overlap.Contains));
            Check.Equal(before, JsonSerializer.Serialize(c, JsonFiles.Options)); Check.Equal(2, dice.Count);
            // A real personal result, including pending delivery, must survive the later binding.
            EncounterConcealment.Search(c, setup.Definition.Id, "personal-search", 16, waitForNarrative: true);
            string discovery = HarnessJson.Serialize(RuntimeEncounters.Current(c)!.Observations);
            var bound = RuntimeEncounters.BindLayout(c, tactical, setup.Definition.Id, "真实局部掩护", binding,
                [new(3, 2, "three-quarters-cover"), new(3, 3, "three-quarters-cover"), new(3, 4, "three-quarters-cover"), new(5, 2, "difficult")], 51);
            Check.Equal(2, dice.Count); Check.Equal(setup.Definition.Id, bound.Definition.Id);
            Check.Equal(discovery, HarnessJson.Serialize(bound.Observations));
            Check.Equal(1, bound.Concealment!.Count(e => e.KnownActors.Contains(c.ActingActorId)));
            Check.Equal(originalStealth, HarnessJson.Serialize(setup.Concealment)); // Original fixture remains unchanged after reload.
            Check.True(originalIds.SequenceEqual(c.Board.Entities.Where(e => e.Source.Kind == "enemy").Select(e => e.Id)));
            Check.Equal(3, c.Board.Entities[0].Statistics!.HitPoints); Check.Equal(2, c.Board.Entities[0].Statistics!.TemporaryHitPoints);
            Check.Equal("Poisoned", c.Board.Entities[0].Statistics!.Conditions!.Single());
            Check.Equal(positions[0].Position.X, SharedBoard.PlacementOn(c.Board.Entities[0], map.Id)!.X);
            RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
            Check.Equal(source, JsonSerializer.Serialize(c.Adventure, JsonFiles.Options));
            Check.Throws<GameException>(() => RuntimeEncounters.BindLayout(c, tactical, setup.Definition.Id, "重复绑定", binding, []));
            var prepared = BoardCombat.Prepare(c, bound.Definition, tactical)!;
            Check.Equal(3, prepared.Units.Single(u => u.Id == originalIds[0]).HitPoints);
            c.RuntimeEncounters![0] = bound with { EngagementReason = "隔离真实交锋", SurprisedActors = [] };
            c.BoardMapContext = tactical;
            new CombatEngine(dice).Resolve(c, "combat.start", ""); c.Version++;
            Check.Equal(4, dice.Count); Check.Equal(3, c.Combat!.Units.Single(u => u.Id == originalIds[0]).HitPoints);
            RuntimeEncounters.ValidateState(c); StandardCombatEngine.ValidateState(c); SharedBoard.ValidateState(c);
        }
        BindingRefreshesActualSight();
        return Task.CompletedTask;
    }

    private static void BindingRefreshesActualSight()
    {
        var map = new MapAssetView(Id(), "隔离地图", "scene", "player", 3, "ready", true, 768, 512, 768, 512,
            new() { Type = "none", Uncalibrated = true }, "", "fixture-hash", "", 0, default, CurrentScene: true);
        var c = TestContent.Campaign("causeway");
        c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s with { Encounter = null }).ToArray() };
        var peer = new PartyMember { Id = Id(), TokenHash = "fixture", Character = c.Character! with { Id = Id() } };
        c.PartyMembers.Add(peer);
        var positions = new[] { new EncounterPlacement("xmm:goblin-warrior", "石耳", "ranged", new(5.5 / 12, 2.5 / 8),
            "three-quarters-cover", "隔离隐匿") };
        var dice = new SequenceDice(10);
        var setup = RuntimeEncounters.Prepare(c, map, null, "隔离视线", c.SceneId, "隔离来源", "场景依据", positions, [], 46);
        RuntimeEncounters.Establish(c, map, setup, positions, new RulesEngine(dice));
        EncounterConcealment.Search(c, setup.Definition.Id, "own-search", 20, waitForNarrative: true);
        string own = c.ActingActorId;
        Check.True(!RuntimeEncounters.Current(c)!.Concealment![0].KnownActors.Contains(peer.Id));
        var tactical = map with { Purpose = "tactical", Version = 4, Grid = new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet", ScaleBasis = new("dm", "隔离尺度") } };
        SharedBoard.Execute(c, tactical, new(Id(), c.Version, tactical.Id, "spawn", Spawns:
            [new("", "creature", new("player", own), new("本人"), 1.5 / 12, 2.5 / 8, own),
             new("", "creature", new("player", peer.Id), new("同伴"), 4.5 / 12, 2.5 / 8, peer.Id)], ExpectedMapVersion: tactical.Version), narrator: true, controlPlayers: true);
        var bound = RuntimeEncounters.BindLayout(c, tactical, setup.Definition.Id, "原隐匿已结束；同伴在无遮挡一侧",
            positions.Select(p => p with { HidingCover = null, HidingReason = null }).ToArray(), []);
        Check.True(bound.Concealment![0].KnownActors.Contains(peer.Id)); Check.Equal(1, dice.Count);
        Check.True(bound.Observations![0].UnpresentedIds is { Length: 1 }); // Original pending story is not silently delivered.
        c.ActingActorId = peer.Id;
        Check.True(SharedBoard.Project(c, tactical, true).Tokens.Any(t => t.Name == "石耳"));
        c.ActingActorId = own; RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
    }

    public static async Task BindingReceiptAndRestart()
    {
        const string source = "binding-evidence", quote = "隔离伏兵在灌木后观察道路。";
        var dice = new SequenceDice(14);
        var model = new Model((_, _) => throw new Exception("No provider needed for tool-boundary verification"));
        var configure = Configure(model); var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h, TestContent.Document with { InitialKnowledge = [new(source, "clue", "伏兵依据", quote, "harbor", "host")] });
            string id = owner.Snapshot.Id, actor = owner.Snapshot.Party!.SelfActorId;
            var catalog = h.App.Services.GetRequiredService<MapCatalog>();
            var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512));
            map = catalog.ConfigureGrid(id, map.Id, new(Id(), map.Version, new() { Type = "none", Uncalibrated = true }, "schematic"));
            map = catalog.Publish(id, map.Id, new(Id(), map.Version, true, true));
            string observationMap = map.Id;
            var game = h.App.Services.GetRequiredService<GameService>();
            string runId = Id();
            async Task<HarnessToolOutcome> Invoke(object args, string command, int version, int contract = 46)
            {
                var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
                var json = HarnessJson.Element(args);
                return await game.HarnessTool(id, owner.AccessToken, actor, runId, "按真实来源准备观察。", version, command, HarnessJson.Fingerprint(json),
                    new("encounter_prepare", json, "prepare"), [], default, auth.Profile, contract, contextAlreadyRead: true,
                    suppliedBoardMap: new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid));
            }
            async Task Refused(Func<Task<HarnessToolOutcome>> call, string code)
            {
                try { await call(); throw new Exception("Expected rejection: " + code); }
                catch (GameException error) { Check.Equal(code, error.Code); }
            }
            var enemies = new[] { new HarnessEncounterEnemy("xmm:goblin-warrior", "枯牙", "ranged", 5.5 / 12, 2.5 / 8,
                "three-quarters-cover", "隔离作者资料：灌木掩护后脱离视线。") };
            int initialVersion = (await h.Get(id))!.Version;
            await Refused(() => Invoke(new HarnessEncounterPrepareV42(map.Id, source, quote, "旧版尺度要求", enemies, []), Id(), initialVersion, 45), "board_combat_scale_unsupported");
            Check.Equal(0, dice.Count); Check.Equal(initialVersion, (await h.Get(id))!.Version);
            var first = await Invoke(new HarnessEncounterPrepareV46(map.Id, source, quote, "场景依据", enemies, []), Id(), initialVersion);
            using var json = JsonDocument.Parse(first.Reply.Content);
            var setup = HarnessJson.Read<RuntimeEncounter>(json.RootElement.GetProperty("encounter"));
            Check.True(setup.Layout is null); Check.Equal(1, dice.Count);
            string originalStealth = HarnessJson.Serialize(setup.Concealment);
            string entityId = setup.Concealment!.Single().EntityId;
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
            {
                c.Board!.Entities[0] = c.Board.Entities[0] with { Statistics = c.Board.Entities[0].Statistics! with { HitPoints = 3 } };
                c.Version++; c.Events.Add(new(Id(), c.Version, "fixture.damage", "隔离已有伤势", "", "test", DateTimeOffset.UtcNow, null));
                return Task.FromResult(true);
            }, default);
            map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512));
            map = catalog.ConfigureGrid(id, map.Id, new(Id(), map.Version, new() { Type = "square", CellPixels = 64, Distance = 5,
                Units = "feet", ScaleBasis = new("dm", "隔离局部尺度") }, "tactical"));
            map = catalog.Publish(id, map.Id, new(Id(), map.Version, true, true));
            await Post<SelectMapResponse>(h, id, $"maps/{map.Id}/select", new SelectMapRequest(Id(), (await h.Get(id))!.Version, map.Version));
            await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), (await h.Get(id))!.Version,
                map.Id, "spawn", Spawns: [new("", "creature", new("player", actor), new("本人"), 1.5 / 12, 2.5 / 8, actor)], ExpectedMapVersion: map.Version));
            int before = (await h.Get(id))!.Version;
            runId = Id();
            var args = new HarnessEncounterPrepareV46(map.Id, source, quote, "新图实际位置与掩护", enemies.Select(e => e with { HidingCover = "", HidingReason = "" }).ToArray(), [], setup.Definition.Id);
            await Refused(() => Invoke(args, Id(), before), "encounter_setup_unavailable");
            Check.Equal(before, (await h.Get(id))!.Version); Check.Equal(1, dice.Count);
            args = args with { Terrain = [new(3, 2, "three-quarters-cover")] };
            string command = Id();
            var bound = await Invoke(args, command, before);
            Check.Equal(bound.Reply.Content, (await Invoke(args, command, before)).Reply.Content); Check.Equal(1, dice.Count);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            game = h.App.Services.GetRequiredService<GameService>();
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(bound.Reply.Content, (await Invoke(args, command, before)).Reply.Content);
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                var current = RuntimeEncounters.Current(c)!;
                Check.Equal(map.Id, current.Layout!.MapId); Check.Equal(originalStealth, HarnessJson.Serialize(current.Concealment));
                Check.Equal(1, c.Board!.Entities.Count(e => e.Source.Kind == "enemy"));
                var enemy = c.Board.Entities.Single(e => e.Id == entityId);
                Check.Equal(3, enemy.Statistics!.HitPoints); Check.True(SharedBoard.PlacementOn(enemy, observationMap) is { OnMap: true });
                Check.True(SharedBoard.PlacementOn(enemy, map.Id) is { OnMap: true });
                RuntimeEncounters.ValidateState(c); return Task.FromResult(true);
            }, default);
            Check.Equal(1, dice.Count); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task RealPiConsentRestartAndPrivacy()
    {
        foreach (bool calibrated in new[] { false, true }) await Scenario(calibrated);
        await Scenario(false, 50);
        await Scenario(false, 50, failedConcealment: true);
    }

    private static async Task Scenario(bool calibrated, int contract = 46, bool failedConcealment = false)
    {
        const string source = "ambush-evidence", quote = "PRIVATE_MAP_INDEPENDENT_AMBUSH", enemyName = "枯牙";
        const string story = "你从灌木的缝隙中辨认出握弓的枯牙。";
        string mapId = "", actor = "", entityId = ""; Exception? modelFailure = null;
        var model = new Model((call, request) =>
        {
            try
            {
                Check.Equal(Preset.SystemPrompt, request.System);
                Check.True(request.Messages.LastOrDefault(m => m.Role == "tool")?.IsError != true);
                var frame = HarnessExecutionProtocolTests.Frame(request);
                Check.True(frame.GetProperty("dmChecklist").GetProperty("instructions").GetString()!.Contains("必要侦察和战术地图校准相互独立"));
                if (call == 1) return Tool("encounter_prepare", new HarnessEncounterPrepareV46(mapId, source, quote, "隔离场景灌木提供掩护，不推算战术距离。",
                    [new("xmm:goblin-warrior", enemyName, "ranged", .6, .4, "three-quarters-cover", "隔离作者资料：伏兵位于灌木后并脱离视线。")], []));
                if (call == 2)
                {
                    string encounter = Regex.Match(string.Join("\n", request.Messages.Select(m => m.Content)), @"runtime-[0-9a-f-]{36}").Value;
                    Check.True(encounter.Length > 0);
                    return Tool("check_request", new HarnessCheckArgs("wisdom", "Perception", "normal", source, quote, EncounterId: encounter));
                }
                Check.Equal(3, call);
                if (failedConcealment) return Tool("ask_player", new { question = "无需掷骰的观察已记录，接下来做什么？" });
                return Tool("world_record", new NarrativeHarnessArgs("同伴停下脚步，仔细观察四周。", [],
                    PrivateMessages: [new([actor], story, [entityId])]));
            }
            catch (Exception error) { modelFailure = error; throw; }
        });
        var dice = new SequenceDice(failedConcealment ? 1 : 10, 20);
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h, TestContent.Document with { InitialKnowledge = [new(source, "clue", "伏兵依据", quote, "harbor", "host")] });
            var guest = await HarnessBoundaryTests.Guest(h, owner); var peer = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id;
            var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512));
            var catalog = h.App.Services.GetRequiredService<MapCatalog>();
            map = catalog.ConfigureGrid(id, map.Id, new(Id(), map.Version, calibrated
                ? new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet", ScaleBasis = new("dm", "隔离真实比例") }
                : new MapGrid { Type = "none", Uncalibrated = true }, calibrated ? "tactical" : "schematic"));
            map = catalog.Publish(id, map.Id, new(Id(), map.Version, true, true)); mapId = map.Id;
            string originalMap = HarnessJson.Serialize(map);
            actor = (await h.App.Services.GetRequiredService<GameService>().AuthorizeHarness(id, guest.AccessToken, default)).ActorId;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var input = new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "警惕的观察四周");
            var initialFrame = await h.App.Services.GetRequiredService<GameService>().ReadHarnessExecution(id, guest.AccessToken, actor, Id(), input.Text, input.ExpectedVersion, default, 46);
            HarnessExecutionProtocol.Validate(initialFrame, input.ExpectedVersion, 46);
            _ = HarnessTools.ForVersion(46);
            var run = await StartHistorical(h, id, input, contract);
            run = await Settled(h, id, run.Id, 3000);
            if (modelFailure is not null) throw new Exception("Scripted model failed", modelFailure);
            if (failedConcealment)
            {
                Check.Equal("player", run.Wait!.Kind); Check.Equal(1, dice.Count);
                Check.True((await h.Get(id))!.PendingRoll is null);
                await h.App.Services.GetRequiredService<CampaignStore>().Access(id, guest.AccessToken, false, c =>
                {
                    var enemy = RuntimeEncounters.Current(c)!.Concealment!.Single();
                    Check.True(!enemy.Stealth.Success && enemy.KnownActors.Contains(actor));
                    Check.True(!EncounterConcealment.PresentedTo(c, enemy.EntityId, actor));
                    return Task.FromResult(true);
                }, default);
                return;
            }
            Check.True(run.Status == "waiting" && run.Wait?.Kind == "roll", run.Status + "/" + run.Error + "/modelCalls=" + model.Calls);
            Check.Equal(1, dice.Count); Check.Equal(2, model.Calls);
            var snapshot = (await h.Get(id))!;
            Check.True(snapshot.Combat is null && snapshot.PendingRoll!.Preview!.Opposed && !snapshot.PendingRoll.Preview.HasDc);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, actor, run.Id)!;
            Check.Equal(contract, saved.ToolContractVersion);
            if (contract >= 50)
            {
                Check.True(snapshot.PendingRoll!.Preview!.DifficultyClasses!.SequenceEqual(new[] { 16 }));
                Check.True(snapshot.PendingRoll.Description.Contains("DC 16"));
            }
            else Check.True(snapshot.PendingRoll!.Preview!.DifficultyClasses is null);
            Check.True(!saved.Steps.Any(s => s.ToolName is "map_request" or "map_select"));
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                Check.True(RuntimeEncounters.Current(c)!.Layout is null);
                Check.Equal(1, c.Board!.Entities.Count); // No player tokens, yet real opposition exists.
                entityId = c.Board.Entities.Single().Id;
                RuntimeEncounters.ValidateState(c); return Task.FromResult(true);
            }, default);
            async Task AssertPrivate(bool delivered)
            {
                foreach (var viewer in new[] { guest, peer })
                {
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", viewer.AccessToken);
                    bool expected = delivered && viewer.AccessToken == guest.AccessToken;
                    string board = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/maps/{mapId}/board");
                    Check.Equal(expected, board.Contains(enemyName));
                    Check.Equal(expected ? HttpStatusCode.OK : HttpStatusCode.NotFound,
                        (await h.Http.GetAsync($"/api/v1/campaigns/{id}/board/tokens/{entityId}")).StatusCode);
                    var activity = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/activity?after=0&limit=100");
                    Check.Equal(expected, activity.Contains(story)); Check.True(!activity.Contains(quote));
                }
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            }
            await AssertPrivate(false);
            var roll = new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll");
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", peer.AccessToken);
            Check.True(!(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", roll)).IsSuccessStatusCode);
            Check.Equal(1, dice.Count);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            var result = await Post<ActionResponse>(h, id, "rolls/respond", roll);
            Check.Equal(2, dice.Count); Check.True(!result.Resolution.Check!.HasDc);
            if (contract >= 50) Check.True(result.Resolution.Check.DifficultyClasses!.SequenceEqual(snapshot.PendingRoll!.Preview!.DifficultyClasses!));
            else Check.True(result.Resolution.Check.DifficultyClasses is null);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed); Check.Equal(2, dice.Count);
            await AssertPrivate(false); // Saved discovery still waits for actual private delivery.
            var resume = new HarnessResumeRequest(Id(), result.Snapshot.Version);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            run = await Settled(h, id, run.Id, 3000);
            if (modelFailure is not null) throw new Exception("Scripted model failed", modelFailure);
            Check.Equal("completed", run.Status); Check.Equal(3, model.Calls); Check.Equal(2, dice.Count);
            await AssertPrivate(true);
            Check.Equal(originalMap, HarnessJson.Serialize(h.App.Services.GetRequiredService<MapCatalog>().Get(id, mapId, true)));
            root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed);
            await AssertPrivate(true); Check.Equal(3, model.Calls); Check.Equal(2, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }
}
