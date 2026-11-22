using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessReadTests
{
    private static string ActivePath(string id) => $"/api/v1/campaigns/{id}/harness/runs/active";
    private static Task<HarnessActiveRuns?> Active(Host host, string id) => host.Http.GetFromJsonAsync<HarnessActiveRuns>(ActivePath(id));

    public static async Task OwnSeatDiscoveryAndSafeProgress()
    {
        var model = new Model((_, request) => request.Messages.Any(message => message.Role == "tool")
            ? Tool("ask_player", new { question = "请说明目标。" }) : Tool("skills_read", new { id = "private-skill" }));
        await using var host = await Host.Start(configure: Configure(model));
        var owner = await Create(host, skills: [new("private-skill", "PRIVATE_DESCRIPTION_SENTINEL", "PRIVATE_SKILL_SENTINEL")]);
        var guest = await HarnessBoundaryTests.Guest(host, owner);
        string id = owner.Snapshot.Id;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Check.Equal(0, (await Active(host, id))!.Runs.Length);
        var run = await Start(host, (await host.Get(id))!, "OWNER_PRIVATE_INPUT");
        run = await Settled(host, id, run.Id);
        var listed = (await Active(host, id))!.Runs.Single();
        Check.Equal(run.Id, listed.Id);
        Check.Equal("OWNER_PRIVATE_INPUT", listed.Input);
        Check.Equal(run.IntentId, listed.IntentId);
        Check.Equal(Preset.Id, listed.Binding!.PresetId);
        Check.Equal(Preset.Version, listed.Binding.PresetVersion);
        Check.Equal("private-skill", listed.Binding.SkillIds.Single());
        Check.Equal(64, listed.Binding.ProfileHash.Length);
        Check.Equal(4, listed.Progress!.Length);
        Check.True(listed.Progress.Select(step => step.Number).SequenceEqual(new[] { 1, 2, 3, 4 }));
        Check.Equal("skills_read", listed.Progress[1].Tool);
        Check.Equal("ask_player", listed.Progress[3].Tool);
        Check.Equal("player", listed.Progress[3].WaitKind);
        Check.True(owner.Snapshot.Version < listed.Version); // guest creation/approval, not a read side effect
        Check.True(listed.Progress.Where(step => step.Kind == "model").All(step => step.Version is null && step.Tool == ""));
        using var projection = JsonDocument.Parse(HarnessJson.Serialize(listed));
        var progressKeys = new[] { "number", "kind", "status", "tool", "version", "waitKind" }.Order().ToArray();
        foreach (var step in projection.RootElement.GetProperty("progress").EnumerateArray())
            Check.True(step.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(progressKeys));
        string json = HarnessJson.Serialize(listed);
        Check.True(!json.Contains("PRIVATE_SKILL_SENTINEL") && !json.Contains("PRIVATE_DESCRIPTION_SENTINEL") && !json.Contains("systemPrompt"));
        Check.True(!json.Contains("fingerprint") && !json.Contains("commandId") && !json.Contains(owner.AccessToken));

        // Discovery only reads this actor's hot directory. It neither resumes nor rewrites it.
        string path = Directory.GetFiles(Path.Combine(host.Root, "harness"), run.Id + ".json", SearchOption.AllDirectories).Single();
        var before = File.ReadAllBytes(path);
        var snapshot = (await host.Get(id))!;
        using var response = await host.Http.GetAsync(ActivePath(id) + "?actorId=" + guest.Snapshot.Party!.SelfActorId);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        Check.True(response.Headers.CacheControl?.NoStore == true);
        Check.Equal("OWNER_PRIVATE_INPUT", (await response.Content.ReadFromJsonAsync<HarnessActiveRuns>())!.Runs.Single().Input);
        Check.True(before.SequenceEqual(File.ReadAllBytes(path)));
        Check.Equal(snapshot.Version, (await host.Get(id))!.Version);
        Check.Equal(2, model.Calls);

        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(0, (await Active(host, id))!.Runs.Length);
        Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}")).StatusCode);
        var guestRun = await Start(host, (await host.Get(id))!, "GUEST_PRIVATE_INPUT");
        await Settled(host, id, guestRun.Id);
        Check.Equal("GUEST_PRIVATE_INPUT", (await Active(host, id))!.Runs.Single().Input);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Check.Equal("OWNER_PRIVATE_INPUT", (await Active(host, id))!.Runs.Single().Input);
        snapshot = (await host.Get(id))!;
        await Post<ActionResponse>(host, id, "seats/revoke", new RevokeSeatRequest(Id(), snapshot.Version, guest.Snapshot.Party.SelfActorId));
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(ActivePath(id))).StatusCode);
        var foreign = await Create(host);
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(ActivePath(id))).StatusCode);
        Check.Equal(4, model.Calls);
        Check.True(foreign.Snapshot.Id != id);
    }

    public static async Task RestartLegacyMetadataAndUnknownDiscovery()
    {
        var model = new Model((_, _) => Tool("ask_player", new { question = "等待本人回答。" }));
        var host = await Host.Start(configure: Configure(model));
        bool disposed = false;
        try
        {
            var owner = await Create(host);
            string id = owner.Snapshot.Id;
            var run = await Start(host, owner.Snapshot);
            run = await Settled(host, id, run.Id);
            string root = host.Root;
            await host.DisposeAsync(); disposed = true;
            string path = Directory.GetFiles(Path.Combine(root, "harness"), run.Id + ".json", SearchOption.AllDirectories).Single();
            var saved = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            foreach (var step in saved["steps"]!.AsArray()) { step!.AsObject().Remove("toolName"); step.AsObject().Remove("toolRequest"); }
            File.WriteAllText(path, saved.ToJsonString(JsonFiles.Options));
            var original = File.ReadAllBytes(path);
            host = await Host.Start(root, configure: Configure(model, extra: builder => builder.Configuration["Harness:Enabled"] = "false")); disposed = false;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var restored = (await Active(host, id))!.Runs.Single();
            Check.Equal("waiting", restored.Status);
            Check.True(restored.Progress!.All(step => step.Tool == ""));
            Check.Equal(run.Binding!.ProfileHash, restored.Binding!.ProfileHash);
            Check.True(original.SequenceEqual(File.ReadAllBytes(path)));
            Check.Equal(1, model.Calls); // GET works with execution disabled, without upgrading old files
            var hostProgress = (await host.Http.GetFromJsonAsync<AdventureProgress>($"/api/v1/campaigns/{id}/adventure/progress"))!.Runs.Single();
            Check.Equal(run.IntentId, hostProgress.ActionId); Check.Equal(run.Version, hostProgress.Version);
            Check.True(original.SequenceEqual(File.ReadAllBytes(path)));

            // Crash after the model started: discovery shows the incomplete slot, without
            // converting it into a safe-to-retry operation or spending another model call.
            var store = host.App.Services.GetRequiredService<HarnessRunStore>();
            var crashed = store.Read(id, PartyEngine.HostId, run.Id)!;
            crashed.Status = "running"; crashed.Wait = null;
            crashed.Steps.RemoveAt(1);
            crashed.Steps[0].Status = "started"; crashed.Steps[0].Result = null;
            store.Save(crashed);
            var interrupted = (await Active(host, id))!.Runs.Single();
            Check.Equal("interrupted", interrupted.Status);
            Check.Equal("model", interrupted.Progress!.Single().Kind);
            Check.Equal("started", interrupted.Progress!.Single().Status);
            Check.Equal(1, model.Calls);
            // Terminal-but-not-yet-cold records from older versions are filtered, not moved on GET.
            saved = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            saved["status"] = "unknown"; saved["error"] = "harness_model_unknown";
            File.WriteAllText(path, saved.ToJsonString(JsonFiles.Options));
            original = File.ReadAllBytes(path);
            Check.Equal(0, (await Active(host, id))!.Runs.Length);
            var unknown = (await host.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id}/harness/runs/{run.Id}"))!;
            Check.Equal("unknown", unknown.Status);
            Check.True(original.SequenceEqual(File.ReadAllBytes(path)));
            Check.Equal(1, model.Calls);
            // Corrupt labels are never echoed as arbitrary tool names, nor repaired by GET.
            saved["steps"]![0]!["toolName"] = "PRIVATE_UNTRUSTED_LABEL";
            File.WriteAllText(path, saved.ToJsonString(JsonFiles.Options));
            original = File.ReadAllBytes(path);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.GetAsync(ActivePath(id))).StatusCode);
            Check.True(original.SequenceEqual(File.ReadAllBytes(path)));
        }
        finally { if (!disposed) await host.DisposeAsync(); }
    }

    public static async Task HostProgressAndChatIdentity()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (_, _, ct) => { entered.TrySetResult(); await release.Task.WaitAsync(ct); return Text("公开最终输出"); });
        await using var host = await Host.Start(configure: Configure(model));
        var owner = await Create(host);
        var guest = await HarnessBoundaryTests.Guest(host, owner);
        string id = owner.Snapshot.Id, path = $"/api/v1/campaigns/{id}/adventure/progress";
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var run = await Start(host, (await host.Get(id))!, "PRIVATE_INPUT_SENTINEL");
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync(path)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var before = (await host.Get(id))!.Version;
            var progress = (await host.Http.GetFromJsonAsync<AdventureProgress>(path))!.Runs.Single();
            Check.Equal(guest.Snapshot.Party!.SelfActorId, progress.ActorId);
            Check.Equal("running", progress.Status); Check.True(!progress.Succeeded);
            Check.Equal(run.IntentId, progress.ActionId); Check.Equal(before, progress.Version);
            Check.Equal("PRIVATE_INPUT_SENTINEL", progress.Input); // Host-only submitted action precedes published activity.
            string stepPath = $"{path}/steps/1?actorId={progress.ActorId}&actionId={progress.ActionId}";
            var inFlight = (await host.Http.GetFromJsonAsync<AdventureStepDetail>(stepPath))!;
            Check.Equal("started", inFlight.Status); Check.True(inFlight.Response is null);
            var pendingPage = (await host.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after=0&limit=100"))!;
            Check.True(pendingPage.Entries.All(e => e.ActionId != progress.ActionId));
            Check.Equal("started", progress.Steps.Single().Status);
            var raw = await host.Http.GetStringAsync(path);
            foreach (string secret in new[] { "systemPrompt", "binding", "fingerprint", "commandId", "arguments", owner.AccessToken, guest.AccessToken }) Check.True(!raw.Contains(secret));
            Check.Equal(before, (await host.Get(id))!.Version); Check.Equal(1, model.Calls);
            Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}")).StatusCode);
            release.TrySetResult();
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            run = await Settled(host, id, run.Id);
            var session = (await host.Http.GetFromJsonAsync<AdventureSessionView>($"/api/v1/campaigns/{id}/adventure/sessions/{run.Id}"))!;
            var page = (await host.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after=0&limit=100"))!;
            Check.Equal(run.IntentId, session.ActionId); Check.True(page.Entries.Any(e => e.ActionId == session.ActionId));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            progress = (await host.Http.GetFromJsonAsync<AdventureProgress>(path))!.Runs.Single();
            Check.True(progress.Succeeded); Check.Equal("completed", progress.Status); Check.True(progress.Steps.Any(s => s.Kind == "final"));
            Check.Equal(session.ActionId, progress.ActionId); Check.Equal(run.Version, progress.Version);
            Check.True(page.Entries.Any(e => e.ActionId == progress.ActionId && e.ActorId == progress.ActorId));
            using var safe = JsonDocument.Parse(await host.Http.GetStringAsync(path));
            Check.True(safe.RootElement.GetProperty("runs")[0].EnumerateObject().Select(p => p.Name).Order().SequenceEqual(
                new[] { "id", "actorId", "actorName", "status", "succeeded", "steps", "actionId", "version", "input" }.Order()));
            var store = host.App.Services.GetRequiredService<HarnessRunStore>();
            var failed = store.Read(id, guest.Snapshot.Party.SelfActorId, run.Id)!;
            failed.Status = "failed"; failed.Error = "PRIVATE_ERROR_SENTINEL"; store.Save(failed);
            progress = (await host.Http.GetFromJsonAsync<AdventureProgress>(path))!.Runs.Single();
            Check.Equal("failed", progress.Status); Check.True(!progress.Succeeded);
            Check.True(!(await host.Http.GetStringAsync(path)).Contains("PRIVATE_ERROR_SENTINEL"));
            // Same actor, next round: the old failed reply and new in-flight reply keep
            // different stable action identities, even before the second activity exists.
            entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var second = await Start(host, (await host.Get(id))!, "SECOND_PRIVATE_INPUT");
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var two = (await host.Http.GetFromJsonAsync<AdventureProgress>(path))!.Runs;
            Check.Equal(2, two.Length);
            Check.Equal(run.IntentId, two.Single(r => r.Id == run.Id).ActionId);
            Check.Equal(second.IntentId, two.Single(r => r.Id == second.Id).ActionId);
            Check.True(run.IntentId != second.IntentId && two.All(r => r.ActorId == progress.ActorId));
            Check.Equal("SECOND_PRIVATE_INPUT", two.Single(r => r.Id == second.Id).Input);
            release.TrySetResult();
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            await Settled(host, id, second.Id);
            var foreign = await Create(host);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(path)).StatusCode);
            Check.Equal(2, model.Calls);
        }
        finally { release.TrySetResult(); }
    }

    public static async Task HistoricalProgressSurvivesNewRoundsAndRestart()
    {
        var model = new Model((_, _) => Text("保存的公开叙事"));
        var host = await Host.Start(configure: Configure(model)); bool disposed = false;
        try
        {
            var owner = await Create(host); var guest = await HarnessBoundaryTests.Guest(host, owner);
            string campaign = owner.Snapshot.Id, actor = guest.Snapshot.Party!.SelfActorId;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var finished = new List<HarnessRunView>();
            for (int i = 0; i < 3; i++) finished.Add(await Settled(host, campaign, (await Start(host, (await host.Get(campaign))!, "相同原文")).Id));
            string query = $"/api/v1/campaigns/{campaign}/adventure/progress?actorId={actor}&actionId={finished[0].IntentId}";
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync(query)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var first = (await host.Http.GetFromJsonAsync<AdventureProgress>(query))!.Runs.Single();
            Check.Equal(finished[0].Id, first.Id); Check.True(first.Succeeded && first.Steps.Any(s => s.Kind == "final"));
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.GetAsync(query.Split('&')[0])).StatusCode);
            Check.Equal(0, (await host.Http.GetFromJsonAsync<AdventureProgress>(query.Replace(finished[0].IntentId, Id())))!.Runs.Length);
            Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync($"/api/v1/campaigns/{campaign}/harness/runs/{first.Id}")).StatusCode);
            string root = host.Root;
            var originals = Directory.GetFiles(Path.Combine(root, "harness"), "*.json", SearchOption.AllDirectories).ToDictionary(f => f, File.ReadAllBytes);
            await host.DisposeAsync(); disposed = true;
            File.Delete(Path.Combine(root, "harness-history.sqlite")); // pre-index legacy installation / derived index rebuild
            string broken = Path.Combine(Path.GetDirectoryName(originals.Keys.First())!, Id() + ".json");
            File.WriteAllText(broken, "{broken legacy fixture");
            host = await Host.Start(root, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false")); disposed = false;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var indexBefore = File.ReadAllBytes(Path.Combine(root, "harness-history.sqlite"));
            first = (await host.Http.GetFromJsonAsync<AdventureProgress>(query))!.Runs.Single();
            Check.Equal(finished[0].Id, first.Id); Check.Equal(3, model.Calls);
            Check.True(indexBefore.SequenceEqual(File.ReadAllBytes(Path.Combine(root, "harness-history.sqlite"))));
            Check.True(originals.All(p => p.Value.SequenceEqual(File.ReadAllBytes(p.Key))));
            Check.Equal("{broken legacy fixture", File.ReadAllText(broken));
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.GetAsync(query.Replace(finished[0].IntentId, Id()))).StatusCode);
            var snapshot = (await host.Get(campaign))!;
            await Post<ActionResponse>(host, campaign, "seats/revoke", new RevokeSeatRequest(Id(), snapshot.Version, actor));
            Check.Equal(first.Id, (await host.Http.GetFromJsonAsync<AdventureProgress>(query))!.Runs.Single().Id);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(query)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            // Exact history reads do not scan/parse unrelated cold runs on each request.
            var otherPath = originals.Keys.Single(p => Path.GetFileNameWithoutExtension(p) == finished[2].Id);
            File.WriteAllText(otherPath, "broken unrelated cold fixture");
            Check.Equal(first.Id, (await host.Http.GetFromJsonAsync<AdventureProgress>(query))!.Runs.Single().Id);
            File.WriteAllBytes(otherPath, originals[otherPath]);
            Check.Equal(3, model.Calls);
        }
        finally { if (!disposed) await host.DisposeAsync(); }
    }

    public static async Task HostStepRequestsAndResults()
    {
        var model = new Model((_, request) => request.Messages.Any(message => message.Role == "tool")
            ? Tool("ask_player", new { question = "最后一次工具的返回也必须可读。" }) : Tool("skills_list", new { }));
        var host = await Host.Start(configure: Configure(model)); bool disposed = false;
        try
        {
            var owner = await Create(host); var guest = await HarnessBoundaryTests.Guest(host, owner);
            string campaign = owner.Snapshot.Id, actor = guest.Snapshot.Party!.SelfActorId;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var run = await Settled(host, campaign, (await Start(host, (await host.Get(campaign))!, "查看技能后提问")).Id);
            string path = $"/api/v1/campaigns/{campaign}/adventure/progress/steps/4?actorId={actor}&actionId={run.IntentId}";
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync(path)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var detail = (await host.Http.GetFromJsonAsync<AdventureStepDetail>(path))!;
            Check.Equal("ask_player", detail.Tool); Check.Equal(run.Id, detail.RunId);
            Check.Equal("最后一次工具的返回也必须可读。", detail.Request!.Value.GetProperty("question").GetString()!);
            Check.True(detail.Response!.Value.GetProperty("stop").GetBoolean());
            Check.True(detail.Response.Value.GetProperty("content").GetString()!.Length > 0);
            var modelDetail = (await host.Http.GetFromJsonAsync<AdventureStepDetail>(path.Replace("/steps/4", "/steps/3")))!;
            Check.Equal("ask_player", modelDetail.Response!.Value.GetProperty("toolCalls")[0].GetProperty("name").GetString()!);
            Check.True(modelDetail.Request is null);
            foreach (var pair in new[] { ("/steps/4", "/steps/0"), (run.IntentId, Id()), (actor, "foreign-seat") })
                Check.True(!(await host.Http.GetAsync(path.Replace(pair.Item1, pair.Item2))).IsSuccessStatusCode);
            string root = host.Root;
            await host.DisposeAsync(); disposed = true;
            string file = Directory.GetFiles(Path.Combine(root, "harness"), run.Id + ".json", SearchOption.AllDirectories).Single();
            var saved = JsonNode.Parse(File.ReadAllText(file))!;
            foreach (var step in saved["steps"]!.AsArray()) step!.AsObject().Remove("toolRequest");
            File.WriteAllText(file, saved.ToJsonString(JsonFiles.Options)); // Old journals recover only exact fingerprint-matched arguments.
            var bytes = File.ReadAllBytes(file);
            host = await Host.Start(root, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false")); disposed = false;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var restored = (await host.Http.GetFromJsonAsync<AdventureStepDetail>(path))!;
            Check.Equal(HarnessJson.Serialize(detail), HarnessJson.Serialize(restored));
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(file))); Check.Equal(2, model.Calls);
            await host.Create();
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(path)).StatusCode);
        }
        finally { if (!disposed) await host.DisposeAsync(); }
    }

    public static async Task ClosedRunsAndLegacyCampaigns()
    {
        var model = new Model((_, _) => Text("仅公开最终叙事。"));
        await using var host = await Host.Start(configure: Configure(model));
        var owner = await Create(host);
        var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "完成一轮");
        var run = await Post<HarnessRunView>(host, owner.Snapshot.Id, "harness/runs", request);
        run = await Settled(host, owner.Snapshot.Id, run.Id);
        Check.Equal("completed", run.Status);
        Check.Equal(0, (await Active(host, owner.Snapshot.Id))!.Runs.Length);
        Check.True(run.Progress!.Any(step => step.Kind == "final" && step.Status == "done" && step.Tool == ""));
        Check.True((await Post<HarnessRunView>(host, owner.Snapshot.Id, "harness/runs", request)).Replayed);
        Check.Equal(1, model.Calls);
        var legacy = await host.Create();
        using var response = await host.Http.GetAsync(ActivePath(legacy.Snapshot.Id));
        Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Check.True((await response.Content.ReadAsStringAsync()).Contains("harness_campaign_required"));
        Check.Equal(1, model.Calls);
    }
}
