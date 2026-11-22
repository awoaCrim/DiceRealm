using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessAuthorityTests
{
    public static async Task DefaultOffStrictInputsAndForgedActions()
    {
        await using (var disabled = await Host.Start())
        {
            var response = await disabled.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("No", "A", TestContent.Document, Preset, Build: FullCreationTests.Named("A")));
            Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
            var ordinary = await disabled.Create();
            Check.Equal(HttpStatusCode.Conflict, (await disabled.Http.PostAsJsonAsync($"/api/v1/campaigns/{ordinary.Snapshot.Id}/harness/runs",
                new HarnessInputRequest(Id(), ordinary.Snapshot.Version, "observe"))).StatusCode);
        }
        var forged = new Model((_, _) => Tool("actions_propose", new { candidateId = "never-offered-candidate" }));
        await using var host = await Host.Start(configure: Configure(forged)); var owner = await Create(host);
        foreach (object input in new object[] { new { requestId = Id(), text = "missing version" },
            new { requestId = Id(), expectedVersion = 1, text = "bad", actorId = "host" },
            new { requestId = Id(), expectedVersion = 1, text = "bad", hitPoints = 999 } })
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/harness/runs", input)).StatusCode);
        var run = await Start(host, owner.Snapshot); run = await Settled(host, owner.Snapshot.Id, run.Id);
        Check.Equal("failed", run.Status); Check.Equal("intent_option_unavailable", run.Error);
        Check.Equal(owner.Snapshot.Version, (await host.Get(owner.Snapshot.Id))!.Version);
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/harness/runs/{run.Id}/cancel", new { actorId = "host" })).StatusCode);
    }
    public static async Task RevokedDuringModelWaitAndSameRequestConcurrency()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (_, _, ct) => { entered.SetResult(); await release.Task.WaitAsync(ct);
            return Tool("world_record", new NarrativeHarnessArgs("撤权后不能写入。", [new("", "clue", "撤权泄露", "不应保存", "known", "")])); });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); var guest = await HarnessBoundaryTests.Guest(h, owner);
        string id = owner.Snapshot.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var s = (await h.Get(id))!; var request = new HarnessInputRequest(Id(), s.Version, "模型等待期间撤销此席位");
        var results = await Task.WhenAll(Post<HarnessRunView>(h, id, "harness/runs", request), Post<HarnessRunView>(h, id, "harness/runs", request));
        Check.Equal(1, results.Count(r => r.Replayed)); await entered.Task.WaitAsync(TimeSpan.FromSeconds(3)); Check.Equal(1, model.Calls);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); s = (await h.Get(id))!;
        var revoked = await Post<ActionResponse>(h, id, "seats/revoke", new RevokeSeatRequest(Id(), s.Version, guest.Snapshot.Party!.SelfActorId));
        release.SetResult();
        var store = h.App.Services.GetRequiredService<HarnessRunStore>(); HarnessRun saved = null!;
        for (int i = 0; i < 100; i++)
        {
            saved = store.Read(id, guest.Snapshot.Party.SelfActorId, request.RequestId)!;
            if (saved.Status != "running") break;
            await Task.Delay(20);
        }
        Check.Equal("failed", saved.Status); Check.Equal("unauthorized", saved.Error);
        Check.Equal(revoked.Snapshot.Version, (await h.Get(id))!.Version);
        Check.True(!(await h.Get(id))!.WorldMemory!.Any(m => m.Name == "撤权泄露"));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs", request)).StatusCode);
        Check.Equal(1, model.Calls);
    }
    public static async Task WritesInvalidateCandidateIds()
    {
        string? observed = null;
        var model = new Model((i, r) =>
        {
            if (i == 1) return Tool("actions_list");
            if (i == 2)
            {
                using var doc = JsonDocument.Parse(r.Messages.Last(m => m.Role == "tool").Content);
                observed = doc.RootElement.GetProperty("candidates").EnumerateArray().First(c => c.GetProperty("label").GetString()!.Contains("观察")).GetProperty("id").GetString();
            }
            return Tool("actions_propose", new { candidateId = observed });
        });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        var run = await StartV14(h, owner.Snapshot.Id, new HarnessInputRequest(Id(), owner.Snapshot.Version, "观察")); run = await Settled(h, owner.Snapshot.Id, run.Id);
        Check.Equal("failed", run.Status); Check.Equal("intent_option_unavailable", run.Error);
        var snapshot = (await h.Get(owner.Snapshot.Id))!;
        Check.Equal(owner.Snapshot.Version + 2, snapshot.Version); // original intent root + one observe only
        Check.Equal(1, snapshot.Events.Count(e => e.Kind == "observe"));
    }
}
