using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class RuntimeEncounterHttpTests
{
    public static async Task PersonalDiscoveryExecutionFrames()
    {
        var dice = new SequenceDice(15);
        await using var h = await Host.Start(dice: dice, configure: Configure(new Model((_, _) => throw new Exception("No model call expected"))));
        var owner = await Create(h, TestContent.Document);
        var guest = await HarnessBoundaryTests.Guest(h, owner); var peer = await HarnessBoundaryTests.Guest(h, owner);
        string id = owner.Snapshot.Id;
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
        var peerAuth = await game.AuthorizeHarness(id, peer.AccessToken, default);
        var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512)) with { CurrentScene = true };
        var actors = new List<string>();
        foreach (var user in new[] { owner, guest, peer }) actors.Add((await game.AuthorizeHarness(id, user.AccessToken, default)).ActorId);
        // Initial placement uses today's DM entry point; the frames below remain v36/v37.
        var placementAuth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        await game.HarnessTool(id, owner.AccessToken, placementAuth.ActorId, Id(), "DM安排初始站位。", placementAuth.Version, Id(), Id(),
            new("token_spawn", HarnessJson.Element(new HarnessSpawnArgs(map.Id, actors.Select((actor, i) =>
                new BoardSpawn("", "creature", new("player", actor), new("本人"), 1.5 / 12, (i + 1.5) / 8, actor)).ToArray())), "placement"),
            [], default, placementAuth.Profile, 40, contextAlreadyRead: true,
            suppliedBoardMap: new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid));
        auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
        peerAuth = await game.AuthorizeHarness(id, peer.AccessToken, default);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, guest.AccessToken, true, c =>
        {
            // Explicit isolated mechanical fixture: a real saved hidden result, discovered by one seat.
            var placements = new[] { new EncounterPlacement("xmm:goblin-warrior", "PERSONAL_HIDDEN_UNIT", "ranged",
                new(5.5 / 12, 2.5 / 8), "three-quarters-cover", "隔离夹具：掩护后脱离视线。") };
            var setup = RuntimeEncounters.Prepare(c, map, new() { Type = "square", CellPixels = 64 }, "隔离战场", c.SceneId,
                "隔离来源", "测试战术标尺", placements, [new(3, 2, "three-quarters-cover")]);
            RuntimeEncounters.Establish(c, map, setup, placements, new RulesEngine(dice));
            EncounterConcealment.Search(c, setup.Definition.Id, Id(), 25);
            c.Version++;
            c.Events.Add(new(Id(), c.Version, "observe", "隔离机械夹具", "", "system", DateTimeOffset.UtcNow, null));
            return Task.FromResult(true);
        }, default);
        auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
        peerAuth = await game.AuthorizeHarness(id, peer.AccessToken, default);
        foreach (int contract in new[] { 36, 37 })
        {
            var frame = await game.ReadHarnessExecution(id, guest.AccessToken, auth.ActorId, Id(), "观察当前处境", auth.Version, default, contract);
            HarnessExecutionProtocol.Validate(frame, auth.Version, contract);
            Check.Equal("actor", frame.Board!.State!.Tokens.Single(t => t.Name == "PERSONAL_HIDDEN_UNIT").Visibility);
            var other = await game.ReadHarnessExecution(id, peer.AccessToken, peerAuth.ActorId, Id(), "观察当前处境", peerAuth.Version, default, contract);
            HarnessExecutionProtocol.Validate(other, peerAuth.Version, contract);
            Check.True(!other.Board!.State!.Tokens.Any(t => t.Name == "PERSONAL_HIDDEN_UNIT"));
        }
        Check.Equal(1, dice.Count);
    }

    public static async Task RealPiSearchGroupConsentRestartAndPrivacy()
    {
        const string source = "ambush-source", secret = "PRIVATE_ENCOUNTER_TWO_GOBLINS";
        string mapId = ""; string[] actors = [];
        string Encounter(HarnessModelRequest r) => Regex.Match(string.Join("\n", r.Messages.Select(m => m.Content)), @"runtime-[0-9a-f-]{36}").Value;
        var model = new Model((call, request) =>
        {
            Check.Equal(Preset.SystemPrompt, request.System);
            var frame = HarnessExecutionProtocolTests.Frame(request);
            Check.Equal(HarnessDmChecklist.InstructionsFor(35), frame.GetProperty("dmChecklist").GetProperty("instructions").GetString()!);
            Check.Equal(1, request.Messages.Count(m => m.Content.Contains("# 本次调用：完整主持行动检查")));
            return call switch
            {
            1 => Tool("encounter_prepare", new HarnessEncounterPrepare(mapId, source, secret, "隔离测试DM明确设定战术标尺，不声明为作者地理。",
                new(64, 0, 0), [new("xmm:goblin-warrior", secret + "_A", "ranged", 5.5 / 12, 2.5 / 8, "three-quarters-cover", "测试DM确认伏兵在掩护后且脱离队员视线。"),
                    new("xmm:goblin-warrior", secret + "_B", "ranged", 5.5 / 12, 4.5 / 8, "three-quarters-cover", "测试DM确认伏兵在掩护后且脱离队员视线。")],
                [new(3, 2, "three-quarters-cover"), new(3, 3, "three-quarters-cover"), new(3, 4, "three-quarters-cover")])),
            2 => Tool("check_request", new HarnessCheckArgs("wisdom", "Perception", "normal", source, secret, EncounterId: Encounter(request))),
            3 => Tool("encounter_engage", new HarnessEncounterEngage(Encounter(request), "测试已触发实际敌对交锋，不是仅因搜寻就开战。", actors)),
            4 => Text("交锋已经开始，请按当前先攻顺序行动。"),
            _ => throw new Exception("Unexpected model call " + call)
            };
        });
        var dice = new SequenceDice(15, 14, 1, 18, 17, 18, 17, 18, 17, 1, 1, 1, 1, 1, 1);
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var document = TestContent.Document with { InitialKnowledge = [new(source, "clue", "主持伏兵依据", secret, "harbor", "host")] };
            var owner = await Create(h, document); var guest = await HarnessBoundaryTests.Guest(h, owner); var peer = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id;
            var users = new[] { owner, guest, peer }; var game = h.App.Services.GetRequiredService<GameService>();
            var auths = new List<HarnessAuthorization>();
            foreach (var user in users) auths.Add(await game.AuthorizeHarness(id, user.AccessToken, default));
            actors = auths.Select(a => a.ActorId).ToArray();
            var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512)); mapId = map.Id;
            // Setup through the current DM tool; the historical v35 search below remains frozen.
            var placementAuth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            await game.HarnessTool(id, owner.AccessToken, placementAuth.ActorId, Id(), "DM安排初始站位。", placementAuth.Version, Id(), Id(),
                new("token_spawn", HarnessJson.Element(new HarnessSpawnArgs(mapId, actors.Select((actor, i) =>
                    new BoardSpawn("", "creature", new("player", actor), new("本人"), 1.5 / 12, (2.5 + i) / 8, actor)).ToArray())), "placement"),
                [], default, placementAuth.Profile, 39, contextAlreadyRead: true,
                suppliedBoardMap: new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var run = await StartHistorical(h, id, new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "我留在原地，仔细搜寻周围的动静。"), 35);
            run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "waiting" && run.Wait?.Kind == "roll", "Search did not reach consent: " + run.Error);
            Check.Equal(2, model.Calls); Check.Equal(2, dice.Count); // NPC Hide only; player has not rolled
            Check.True((await h.Get(id))!.Combat is null);
            async Task AssertHidden()
            {
                foreach (var viewer in new[] { guest, peer })
                {
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", viewer.AccessToken);
                    foreach (string route in new[] { "", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100", "/maps/" + mapId + "/board" })
                        Check.True(!(await h.Http.GetStringAsync($"/api/v1/campaigns/{id}" + route)).Contains(secret), "Hidden roster leaked via " + route);
                }
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            }
            await AssertHidden();
            var s0 = (await h.Get(id))!; var searchRequest = new RollResponseRequest(Id(), s0.Version, s0.PendingRoll!.Id, "roll");
            var preview = s0.PendingRoll.Preview!;
            Check.True(preview.Opposed && !preview.HasDc); Check.Equal(0, preview.Dc);
            Check.Equal("wisdom", preview.Ability); Check.Equal("Perception", preview.Skill);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var searched = await Post<ActionResponse>(h, id, "rolls/respond", searchRequest);
            Check.Equal(preview.Modifier, searched.Resolution.Check!.Modifier); Check.Equal(preview.Mode, searched.Resolution.Check.Mode);
            Check.Equal(3, dice.Count); Check.True(!searched.Resolution.Check!.HasDc);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", searchRequest)).Replayed); Check.Equal(3, dice.Count);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), searched.Snapshot.Version));
            run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "waiting" && run.Wait?.Kind == "roll", "Engagement did not reach consent: " + run.Error);
            Check.Equal(3, model.Calls); Check.Equal(3, dice.Count); Check.True((await h.Get(id))!.Combat is null);
            await AssertHidden();
            // Each player confirms their own request; restart with one still unconfirmed.
            foreach (var user in new[] { guest, owner })
            {
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", user.AccessToken);
                var s = (await h.Get(id))!;
                await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"));
                Check.Equal(3, dice.Count); Check.True((await h.Get(id))!.Combat is null);
            }
            root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", peer.AccessToken);
            var beforeLast = (await h.Get(id))!;
            var lastRequest = new RollResponseRequest(Id(), beforeLast.Version, beforeLast.PendingRoll!.Id, "roll");
            var started = await Post<ActionResponse>(h, id, "rolls/respond", lastRequest);
            Check.Equal(10, dice.Count); Check.Equal(3, started.Snapshot.Combat!.Units.Length);
            Check.True(!JsonSerializer.Serialize(started).Contains(secret));
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", lastRequest)).Replayed); Check.Equal(10, dice.Count);
            await AssertHidden();
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), started.Snapshot.Version));
            run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "completed", run.Error);
            Check.Equal(4, model.Calls); Check.Equal(10, dice.Count);
            var stored = h.App.Services.GetRequiredService<CampaignStore>();
            await stored.Access(id, owner.AccessToken, false, c =>
            {
                Check.Equal(JsonSerializer.Serialize(document, JsonFiles.Options), JsonSerializer.Serialize(c.Adventure, JsonFiles.Options));
                Check.Equal(2, c.Combat!.Units.Count(u => u.Team == "enemy"));
                Check.True(c.Combat.Log.Where(e => e.Kind == "initiative" && c.Combat.Units.Any(u => u.Id == e.ActorId && u.Team == "enemy")).All(e => e.Audience is { Length: 0 }));
                return Task.FromResult(true);
            }, default);
            // The actual actions/rolls boundary must route combat.search, not fall through to exploration.
            var turn = (await h.Get(id))!; int searchingActor = Array.IndexOf(actors, turn.Combat!.ActiveActorId);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", users[searchingActor].AccessToken);
            var proposed = await h.Act((await h.Get(id))!, "combat.search");
            Check.Equal("awaiting_roll", proposed.Resolution.Status); Check.Equal(10, dice.Count);
            var combatPreview = proposed.Snapshot.PendingRoll!.Preview!;
            Check.True(combatPreview.Opposed && combatPreview.DifficultyClasses is { Length: > 0 });
            var combatSearchRequest = new RollResponseRequest(Id(), proposed.Snapshot.Version, proposed.Snapshot.PendingRoll!.Id, "roll");
            var combatSearch = await Post<ActionResponse>(h, id, "rolls/respond", combatSearchRequest);
            Check.Equal(11, dice.Count); Check.Equal("combat.search", combatSearch.Resolution.Kind);
            var recordedSearch = combatSearch.Resolution.CombatLog!.Single(e => e.Kind == "combat.search").Check!;
            Check.True(recordedSearch.DifficultyClasses!.SequenceEqual(combatPreview.DifficultyClasses!));
            Check.True(!combatSearch.Snapshot.Combat!.Units.Single(u => u.Id == actors[searchingActor]).ActionAvailable);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", combatSearchRequest)).Replayed); Check.Equal(11, dice.Count);
            // Engineering commands advance the party turns; these are not claimed as natural-player acceptance.
            for (int i = 0; i < 3; i++)
            {
                var snapshot = (await h.Get(id))!; int actorIndex = Array.IndexOf(actors, snapshot.Combat!.ActiveActorId);
                Check.True(actorIndex >= 0); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", users[actorIndex].AccessToken);
                snapshot = (await h.Get(id))!; await h.Act(snapshot, "combat.end_turn");
            }
            Check.Equal(15, dice.Count);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", peer.AccessToken);
            var after = (await h.Get(id))!; Check.Equal(5, after.Combat!.Units.Length);
            Check.Equal(2, after.Combat.Log.Count(e => e.Kind == "attack"));
            Check.Equal(3, after.Combat.Log.Count(e => e.Kind == "initiative"));
            Check.True(after.Combat.Log.Where(e => e.Kind == "attack").All(e => !e.Attack!.Hit));
        }
        finally { await h.DisposeAsync(); }
    }
}
