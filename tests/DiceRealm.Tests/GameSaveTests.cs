using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class GameSaveTests
{
    internal static void ConfigurePi(Microsoft.AspNetCore.Builder.WebApplicationBuilder b)
    {
        b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
        b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
    }
    internal static string Url(string id, string route = "") => $"/api/v1/campaigns/{id}" + (route.Length == 0 ? "" : "/" + route);
    internal static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    internal static void Timeline(Host h, string value)
    {
        h.Http.DefaultRequestHeaders.Remove("X-DiceRealm-Timeline");
        if (value.Length > 0) h.Http.DefaultRequestHeaders.Add("X-DiceRealm-Timeline", value);
    }
    internal static string Branch(JsonElement snapshot) => snapshot.TryGetProperty("timelineId", out var value) ? value.GetString() ?? "" : "";
    internal static Task<JsonElement> Get(Host h, string id, string route = "") => h.Http.GetFromJsonAsync<JsonElement>(Url(id, route));
    internal static Task<JsonElement> Write(Host h, string id, string route, object body) => Post<JsonElement>(h, id, route, body);
    internal static async Task<JsonElement> Save(Host h, string id, string name)
    {
        var s = await Get(h, id);
        return await Write(h, id, "adventure/saves", new { requestId = Id(), expectedVersion = s.GetProperty("version").GetInt32(), name });
    }
    internal static async Task<JsonElement> Load(Host h, string id, JsonElement entry)
    {
        var s = await Get(h, id);
        var response = await Write(h, id, $"adventure/saves/{entry.GetProperty("id").GetString()}/load", new
        { requestId = Id(), expectedVersion = s.GetProperty("version").GetInt32(), expectedSaveRevision = entry.GetProperty("revision").GetInt32() });
        Timeline(h, Branch(response.GetProperty("snapshot"))); return response;
    }
    internal static async Task<JsonElement> Entry(Host h, string id, string saveId) =>
        (await Get(h, id, "adventure/saves")).GetProperty("entries").EnumerateArray().Single(e => e.GetProperty("id").GetString() == saveId).Clone();
    internal static async Task Error(HttpResponseMessage response, HttpStatusCode status, string? code = null)
    {
        string body = await response.Content.ReadAsStringAsync();
        Check.True(response.StatusCode == status, $"Expected {status}; got {response.StatusCode}: {body}");
        if (code is not null) Check.Equal(code, JsonDocument.Parse(body).RootElement.GetProperty("code").GetString());
    }
    // Explicit isolated fixture writes use the same authoritative store transaction as game commands.
    internal static Task Mutate(Host h, CreatedCampaign owner, Action<Campaign> change, string text = "SAVE_TEST_FIXTURE") =>
        h.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
        {
            change(c); c.Version++;
            c.Events.Add(new(Id(), c.Version, "observe", text, "", "authored", DateTimeOffset.UtcNow, null));
            return Task.FromResult(true);
        });

    public static async Task AuthoritySlotsReplayAndTimeline()
    {
        var model = new Model((_, _) => throw new Exception("Save control must not call a model"));
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h); var guest = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
        Auth(h, owner.AccessToken); var s = await Get(h, id);
        var request = new { requestId = Id(), expectedVersion = s.GetProperty("version").GetInt32(), name = "港口初遇" };
        var results = await Task.WhenAll(Write(h, id, "adventure/saves", request), Write(h, id, "adventure/saves", request));
        Check.Equal(1, results.Count(r => r.GetProperty("replayed").GetBoolean()));
        string saveId = results[0].GetProperty("saveId").GetString()!; var entry = await Entry(h, id, saveId);
        Check.Equal("港口初遇", entry.GetProperty("name").GetString()); Check.Equal("manual", entry.GetProperty("kind").GetString());
        Check.Equal(2, entry.GetProperty("party").GetArrayLength());
        Check.True(!entry.GetRawText().Contains(owner.AccessToken) && !entry.GetRawText().Contains(guest.AccessToken));
        await Error(await h.Http.PostAsJsonAsync(Url(id, "adventure/saves"), new { request.requestId, request.expectedVersion, name = "换内容" }), HttpStatusCode.Conflict, "idempotency_conflict");
        Auth(h, guest.AccessToken);
        await Error(await h.Http.GetAsync(Url(id, "adventure/saves")), HttpStatusCode.Forbidden);
        foreach (var (route, body) in new (string, object)[] {
            ("adventure/saves", request),
            ($"adventure/saves/{saveId}/load", new { requestId = Id(), request.expectedVersion, expectedSaveRevision = 1 }),
            ($"adventure/saves/{saveId}/delete", new { requestId = Id(), expectedSaveRevision = 1 }),
            ("adventure/restart", new { requestId = Id(), request.expectedVersion }) })
            await Error(await h.Http.PostAsJsonAsync(Url(id, route), body), HttpStatusCode.Forbidden);
        Auth(h, owner.AccessToken);
        await Mutate(h, owner, c => c.Character = c.Character.Required() with { HitPoints = 1 });
        s = await Get(h, id);
        var overwrite = new { requestId = Id(), expectedVersion = s.GetProperty("version").GetInt32(), name = "伤后档", saveId, expectedSaveRevision = 1 };
        await Write(h, id, "adventure/saves", overwrite);
        entry = await Entry(h, id, saveId); Check.Equal(2, entry.GetProperty("revision").GetInt32());
        await Error(await h.Http.PostAsJsonAsync(Url(id, "adventure/saves"), new { requestId = Id(), overwrite.expectedVersion, name = "过期覆盖", saveId, expectedSaveRevision = 1 }), HttpStatusCode.Conflict);
        var load = new { requestId = Id(), expectedVersion = s.GetProperty("version").GetInt32(), expectedSaveRevision = 2 };
        var restored = await Write(h, id, $"adventure/saves/{saveId}/load", load); string first = Branch(restored.GetProperty("snapshot"));
        Check.True(first.Length > 0); Check.Equal(1, restored.GetProperty("snapshot").GetProperty("character").GetProperty("hitPoints").GetInt32());
        // The lost response is retried with its original (empty) timeline, before any refresh.
        var replay = await Write(h, id, $"adventure/saves/{saveId}/load", load);
        Check.True(replay.GetProperty("replayed").GetBoolean()); Check.Equal(first, Branch(await Get(h, id)));
        await Error(await h.Http.PostAsJsonAsync(Url(id, "harness/runs"), new HarnessInputRequest(Id(), load.expectedVersion, "旧页面迟到行动")), HttpStatusCode.Conflict, "campaign_timeline_changed");
        Timeline(h, first); s = await Get(h, id);
        var restart = new { requestId = Id(), expectedVersion = s.GetProperty("version").GetInt32() };
        var fresh = await Write(h, id, "adventure/restart", restart); string second = Branch(fresh.GetProperty("snapshot"));
        Check.True(second.Length > 0 && second != first);
        Check.True(fresh.GetProperty("snapshot").GetProperty("character").GetProperty("hitPoints").GetInt32() > 1);
        Check.True((await Write(h, id, "adventure/restart", restart)).GetProperty("replayed").GetBoolean());
        Timeline(h, ""); Check.True((await Write(h, id, $"adventure/saves/{saveId}/load", load)).GetProperty("replayed").GetBoolean());
        Check.Equal(second, Branch(await Get(h, id)));
        Timeline(h, second);
        var entries = (await Get(h, id, "adventure/saves")).GetProperty("entries");
        Check.Equal(2, entries.EnumerateArray().Count(e => e.GetProperty("kind").GetString() == "recovery"));
        var delete = new { requestId = Id(), expectedSaveRevision = 2 };
        await Write(h, id, $"adventure/saves/{saveId}/delete", delete);
        Check.True((await Write(h, id, $"adventure/saves/{saveId}/delete", delete)).GetProperty("replayed").GetBoolean());
        Check.True(!(await Get(h, id, "adventure/saves")).GetProperty("entries").EnumerateArray().Any(e => e.GetProperty("id").GetString() == saveId));
        Auth(h, guest.AccessToken); Check.Equal(second, Branch(await Get(h, id))); Check.Equal(0, model.Calls);
    }

    public static async Task NewAdmissionAfterRestoreNeedsNoPriorTimeline()
    {
        await using var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("No model"))));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        await Post<ActionResponse>(h, id, "room", new ConfigureRoomRequest(Id(), (await h.Get(id))!.Version, true, "restore-room-password"));
        var room = (await h.Http.GetFromJsonAsync<RoomView>(Url(id, "room")))!;
        string inviteToken = new string('b', 64);
        await Post<ActionResponse>(h, id, "invitations", new InviteRequest(Id(), (await h.Get(id))!.Version, inviteToken));
        var saved = await Save(h, id, "入房前"); await Load(h, id, await Entry(h, id, saved.GetProperty("saveId").GetString()!));
        string branch = Branch(await Get(h, id)); Timeline(h, "");
        var roomRequest = new JoinRoomRequest(room.RoomNumber, "restore-room-password", Id(), new string('c', 64), FullCreationTests.Named("读档后房号加入"));
        await Error(await h.Http.PostAsJsonAsync("/api/v1/rooms/join", roomRequest with { Password = "incorrect-password" }), HttpStatusCode.Unauthorized);
        var response = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", roomRequest); Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var guest = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Check.Equal(branch, guest.Snapshot.TimelineId);
        var replay = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", roomRequest); Check.Equal(HttpStatusCode.OK, replay.StatusCode);
        Check.Equal(guest.Snapshot.Party!.SelfActorId, (await replay.Content.ReadFromJsonAsync<CreatedCampaign>())!.Snapshot.Party!.SelfActorId);
        var invited = await Post<CreatedCampaign>(h, id, "join", new JoinCampaignRequest(Id(), inviteToken, new string('d', 64), "邀请加入", Build: FullCreationTests.Named("邀请加入")));
        Check.Equal(branch, invited.Snapshot.TimelineId);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "harness/runs"), new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "旧时间线行动")), HttpStatusCode.Conflict, "campaign_timeline_changed");
        Timeline(h, branch); await Post<ActionResponse>(h, id, "seats/revoke", new RevokeSeatRequest(Id(), (await h.Get(id))!.Version, guest.Snapshot.Party.SelfActorId));
        Timeline(h, ""); await Error(await h.Http.PostAsJsonAsync("/api/v1/rooms/join", roomRequest), HttpStatusCode.Unauthorized);
    }

    public static async Task CompleteHistoryMapWorkspaceAndCurrentSeats()
    {
        var model = new Model((_, _) => throw new Exception("Restoration must not call a model"));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h); var b = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
            Auth(h, owner.AccessToken); string actorB = b.Snapshot.Party!.SelfActorId;
            await KnowledgeVisibilityTests.Record(h, owner, KnowledgeVisibilityTests.Story("OLD_PUBLIC", KnowledgeVisibilityTests.Message([actorB], "B_ONLY_OLD_SECRET")));
            await Mutate(h, owner, c => { for (int i = 0; i < 110; i++) { c.Version++; c.Events.Add(new(Id(), c.Version, "observe", "OLD_COLD_" + i, "", "authored", DateTimeOffset.UtcNow, null)); } });
            var map = SharedBoardTests.Install(h, id);
            var workspace = (await h.Http.GetFromJsonAsync<HarnessWorkspace>(Url(id, "harness/workspace")))!;
            workspace = (await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", new SaveHarnessDraftRequest(Id(), workspace.Version, Preset with { Version = 2, SystemPrompt = "OLD_DRAFT" }, []))).Workspace;
            var before = (await h.Get(id))!; var saved = await Save(h, id, "完整旧进度"); string saveId = saved.GetProperty("saveId").GetString()!;
            // Save is durable across the process; current credentials and revocations are not rewindable progress.
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model)); Auth(h, owner.AccessToken);
            var newcomer = await HarnessBoundaryTests.Guest(h, owner); Auth(h, owner.AccessToken);
            await Post<ActionResponse>(h, id, "seats/revoke", new RevokeSeatRequest(Id(), (await h.Get(id))!.Version, actorB));
            await Mutate(h, owner, c => { c.Character = c.Character.Required() with { HitPoints = 1, Inventory = [] }; c.Facts.Add("FUTURE_FACT"); });
            var maps = h.App.Services.GetRequiredService<MapCatalog>(); maps.Publish(id, map.Id, new(Id(), map.Version, false, false));
            workspace = (await h.Http.GetFromJsonAsync<HarnessWorkspace>(Url(id, "harness/workspace")))!;
            await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", new SaveHarnessDraftRequest(Id(), workspace.Version, Preset with { Version = 3, SystemPrompt = "FUTURE_DRAFT" }, []));
            await Load(h, id, await Entry(h, id, saveId));
            var after = (await h.Get(id))!; Check.Equal(before.Version, after.Version); Check.Equal(before.Character.Required().HitPoints, after.Character.Required().HitPoints);
            Check.Equal(before.Character.Inventory.Length, after.Character.Inventory.Length); Check.True(!after.Facts.Contains("FUTURE_FACT"));
            var cold = await Get(h, id, "journal?after=0&limit=100"); Check.True(cold.GetRawText().Contains("OLD_COLD_0")); Check.True(cold.GetRawText().Contains("B_ONLY_OLD_SECRET"));
            Check.True(maps.Get(id, map.Id, true).Published);
            workspace = (await h.Http.GetFromJsonAsync<HarnessWorkspace>(Url(id, "harness/workspace")))!; Check.Equal("OLD_DRAFT", workspace.Draft.Preset.SystemPrompt);
            Auth(h, b.AccessToken); await Error(await h.Http.GetAsync(Url(id)), HttpStatusCode.Unauthorized);
            Auth(h, newcomer.AccessToken); var joined = await Get(h, id); Check.Equal(newcomer.Snapshot.Party!.SelfActorId, joined.GetProperty("party").GetProperty("selfActorId").GetString());
            Check.True(!(await Get(h, id, "journal?after=0&limit=100")).GetRawText().Contains("B_ONLY_OLD_SECRET"));
            Check.True(joined.GetProperty("character").GetProperty("hitPoints").GetInt32() > 0); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task UnknownCallSurvivesSaveLoadAndServiceRestart()
    {
        var model = new Model((_, _) => throw new HttpRequestException("unknown-provider-outcome"));
        var h = await Host.Start(configure: Configure(model, extra: ConfigurePi));
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var run = await Start(h, owner.Snapshot); run = await Settled(h, id, run.Id, maximumPolls: 3000);
            Check.Equal("unknown", run.Status); Check.Equal(1, model.Calls);
            var saved = await Save(h, id, "调用结果未知"); string saveId = saved.GetProperty("saveId").GetString()!;
            var s = (await h.Get(id))!;
            var restarted = await Write(h, id, "adventure/restart", new { requestId = Id(), expectedVersion = s.Version }); Timeline(h, Branch(restarted.GetProperty("snapshot")));
            await Load(h, id, await Entry(h, id, saveId)); string branch = Branch(await Get(h, id));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model)); Auth(h, owner.AccessToken); Timeline(h, branch);
            run = (await h.Http.GetFromJsonAsync<HarnessRunView>(Url(id, $"harness/runs/{run.Id}")))!;
            Check.Equal("unknown", run.Status);
            await Error(await h.Http.PostAsJsonAsync(Url(id, $"harness/runs/{run.Id}/resume"), new HarnessResumeRequest(Id(), (await h.Get(id))!.Version)), HttpStatusCode.Conflict);
            Check.Equal(1, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task RealPiWaitingRollRestoresWithoutAutomaticCalls()
    {
        var dice = new SequenceDice(18); var model = AdventureModel();
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: ConfigurePi));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot); run = await Settled(h, id, run.Id, maximumPolls: 3000);
        Check.Equal("waiting", run.Status); Check.Equal("roll", run.Wait!.Kind); Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
        var saved = await Save(h, id, "待投掷"); var entry = await Entry(h, id, saved.GetProperty("saveId").GetString()!);
        var s = (await h.Get(id))!;
        await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, run.Wait.Id, "cancel"));
        await h.Http.PostAsync(Url(id, $"harness/runs/{run.Id}/cancel"), null);
        await Load(h, id, entry); s = (await h.Get(id))!;
        Check.Equal(run.Wait.Id, s.PendingRoll!.Id); Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
        var restored = await h.Http.GetFromJsonAsync<HarnessRunView>(Url(id, $"harness/runs/{run.Id}")); Check.Equal("waiting", restored!.Status);
        var roll = new RollResponseRequest(Id(), s.Version, run.Wait.Id, "roll");
        var rolled = await Post<ActionResponse>(h, id, "rolls/respond", roll); Check.Equal(1, dice.Count);
        var rolledSave = await Save(h, id, "已投掷未续接"); var rolledEntry = await Entry(h, id, rolledSave.GetProperty("saveId").GetString()!);
        await Load(h, id, rolledEntry); Check.Equal(1, dice.Count); Check.Equal(2, model.Calls);
        Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed); Check.Equal(1, dice.Count);
        s = (await h.Get(id))!; await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version));
        restored = await Settled(h, id, run.Id); Check.Equal("completed", restored.Status); Check.Equal(4, model.Calls); Check.Equal(1, dice.Count);
    }
}
