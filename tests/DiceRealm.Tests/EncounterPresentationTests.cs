using System.Net;
using System.Net.Http.Json;
using System.Text.RegularExpressions;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class EncounterPresentationTests
{
    public static async Task RealPiNarrationGateAndRecovery()
    {
        foreach (int recoveryMode in new[] { 0, 1, 2 }) await Scenario(recoveryMode);
    }

    private static async Task Scenario(int recoveryMode)
    {
        const string source = "ambush-source", secret = "PRIVATE_DISCOVERED_GOBLIN";
        const string story = "你在灌木后辨认出一名地精，它正握着短弓。";
        string mapId = ""; bool recover = recoveryMode > 0;
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var publicWritten = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releasePublic = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string Encounter(HarnessModelRequest r) => Regex.Match(string.Join("\n", r.Messages.Select(m => m.Content)), @"runtime-[0-9a-f-]{36}").Value;
        var model = new Model(async (call, request, ct) =>
        {
            if (call == 1) return Tool("encounter_prepare", new HarnessEncounterPrepare(mapId, source, secret,
                "隔离测试DM采用方格战术标尺。", new(64, 0, 0),
                [new("xmm:goblin-warrior", secret, "ranged", 5.5 / 12, 2.5 / 8, "three-quarters-cover", "伏兵在灌木后脱离视线。")],
                [new(3, 2, "three-quarters-cover"), new(3, 3, "three-quarters-cover"), new(3, 4, "three-quarters-cover")]));
            if (call == 2) return Tool("check_request", new HarnessCheckArgs("wisdom", "Perception", "normal", source, secret, EncounterId: Encounter(request)));
            if (call == 3)
            {
                reached.TrySetResult(); await release.Task.WaitAsync(ct);
                if (recoveryMode == 1) throw new HttpRequestException("isolated narrative provider failure");
                if (recoveryMode == 2) return Text("队伍停在路边，周围的树叶轻轻晃动。"); // Generic narrative_commit is not private discovery delivery.
                return Tool("encounter_read");
            }
            if (recover && call == 4) return Tool("encounter_read");
            int deliveryCall = recover ? 5 : 4;
            if (call == deliveryCall)
            {
                Check.True(request.Messages.Any(m => m.Role == "tool" && m.Content.Contains("unpresentedIds")), "DM cannot see pending discovery evidence");
                return Tool("world_record", new NarrativeHarnessArgs("队伍停在路边，周围的树叶轻轻晃动。", [], Complete: false));
            }
            Check.Equal(deliveryCall + 1, call);
            publicWritten.TrySetResult(); await releasePublic.Task.WaitAsync(ct);
            return Tool("world_record", new NarrativeHarnessArgs("树枝在风中摇摆。", [], Private: story));
        });
        var dice = new SequenceDice(10, 20);
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var document = TestContent.Document with { InitialKnowledge = [new(source, "clue", "伏兵依据", secret, "harbor", "host")] };
            var owner = await Create(h, document); var guest = await HarnessBoundaryTests.Guest(h, owner); var peer = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id;
            var game = h.App.Services.GetRequiredService<GameService>();
            var actors = new List<string>();
            foreach (var seat in new[] { owner, guest, peer }) actors.Add((await game.AuthorizeHarness(id, seat.AccessToken, default)).ActorId);
            var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512)); mapId = map.Id;
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "DM安排初始站位。", auth.Version, Id(), Id(),
                new("token_spawn", HarnessJson.Element(new HarnessSpawnArgs(mapId, actors.Select((actor, i) =>
                    new BoardSpawn("", "creature", new("player", actor), new("本人"), 1.5 / 12, (2.5 + i) / 8, actor)).ToArray())), "placement"),
                [], default, auth.Profile, 40, contextAlreadyRead: true,
                suppliedBoardMap: new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            // v41 froze an independent encounter grid; v42 uses the map's saved scale.
            var run = await StartHistorical(h, id, new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "我留在原地仔细观察灌木。 "), 41);
            run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "waiting" && run.Wait?.Kind == "roll", run.Status + "/" + run.Error);
            Check.Equal(1, dice.Count); Check.Equal(2, model.Calls);
            string entityId = "";
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            { entityId = c.Board!.Entities.Single(e => e.Appearance.Name == secret).Id; return Task.FromResult(true); }, default);
            async Task AssertPresentation(bool presented)
            {
                foreach (var viewer in new[] { guest, peer })
                {
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", viewer.AccessToken);
                    bool canSee = presented && viewer.AccessToken == guest.AccessToken;
                    var board = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/maps/{mapId}/board");
                    Check.Equal(canSee, board.Contains(secret));
                    var detail = await h.Http.GetAsync($"/api/v1/campaigns/{id}/board/tokens/{entityId}");
                    Check.Equal(canSee ? HttpStatusCode.OK : HttpStatusCode.NotFound, detail.StatusCode);
                    if (canSee)
                    {
                        var token = (await detail.Content.ReadFromJsonAsync<BoardTokenDetail>())!;
                        Check.Equal("goblin", token.IconKey); Check.True(token.Source is null);
                    }
                    foreach (string route in new[] { "", "/events?after=0&limit=100", "/activity?after=0&limit=100" })
                    {
                        string json = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}" + route);
                        if (!canSee) Check.True(!json.Contains(secret), "Pending discovery leaked via " + route);
                    }
                }
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                Check.True((await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/maps/{mapId}/board")).Contains(secret));
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            }
            await AssertPresentation(false);
            var s = (await h.Get(id))!;
            var roll = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
            var rolled = await Post<ActionResponse>(h, id, "rolls/respond", roll);
            Check.Equal(2, dice.Count); Check.True(rolled.Resolution.Check!.Total >= 16);
            await AssertPresentation(false);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            await AssertPresentation(false);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed); Check.Equal(2, dice.Count);
            var resume = new HarnessResumeRequest(Id(), rolled.Snapshot.Version);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(30));
            await AssertPresentation(false); // Actual in-flight model request, not a guessed delay.
            release.TrySetResult();
            if (recover)
            {
                run = await Settled(h, id, run.Id, 3000);
                Check.Equal(recoveryMode == 1 ? "unknown" : "completed", run.Status); await AssertPresentation(false);
                root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
                await AssertPresentation(false);
                run = await StartHistorical(h, id, new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "接着描述刚才已经发现的动静，不再搜寻。 "), 41);
            }
            await publicWritten.Task.WaitAsync(TimeSpan.FromSeconds(30));
            await AssertPresentation(false); // A public-only world_record does not release private discoveries.
            releasePublic.TrySetResult(); run = await Settled(h, id, run.Id, 3000);
            if (!recover) Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            Check.Equal("completed", run.Status); Check.Equal(2, dice.Count);
            await AssertPresentation(true);
            var activity = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/activity?after=0&limit=100");
            Check.True(activity.Contains(story), "Discovery story was not delivered with the token");
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", peer.AccessToken);
            Check.True(!(await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/activity?after=0&limit=100")).Contains(story));
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                var encounter = RuntimeEncounters.Current(c)!;
                Check.Equal(1, encounter.Observations!.Length); Check.True(encounter.Observations[0].UnpresentedIds is null);
                Check.Equal(1, encounter.Concealment!.Single().KnownActors.Length);
                var entity = c.Board!.Entities.Single(e => e.Id == entityId);
                Check.Equal("goblin", BoardArt.Icon(entity with { Appearance = entity.Appearance with { IconKey = "" } }));
                Check.Equal("", BoardArt.Default("与地精同行的陌生人", "custom"));
                Check.Equal("wolf", BoardArt.Icon(entity with { Appearance = entity.Appearance with { IconKey = "wolf" } }));
                EncounterConcealment.Validate(c, encounter); return Task.FromResult(true);
            }, default);
            Check.Equal(recover ? 6 : 5, model.Calls);
        }
        finally { release.TrySetResult(); releasePublic.TrySetResult(); await h.DisposeAsync(); }
    }
}
