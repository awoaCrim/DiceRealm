using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class PrivateStorySharingTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static async Task<ActionResponse> Share(Host h, string id, SharePrivateStoryRequest request)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/story/share", request);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    public static async Task ExactSourcePermissionsReplayAndRestart()
    {
        var model = new HarnessTests.Model((_, _) => throw new Exception("Sharing must not call a model"));
        var h = await Host.Start(configure: HarnessTests.Configure(model));
        var owner = await HarnessTests.Create(h);
        var a = await HarnessBoundaryTests.Guest(h, owner);
        var b = await HarnessBoundaryTests.Guest(h, owner);
        string id = owner.Snapshot.Id, runId = Id();
        var game = h.App.Services.GetRequiredService<GameService>();
        async Task Record(string text)
        {
            var auth = await game.AuthorizeHarness(id, a.AccessToken, default);
            await game.HarnessTool(id, a.AccessToken, auth.ActorId, runId, "原行动", auth.Version, Id(), Id(),
                new("world_record", HarnessJson.Element(new NarrativeHarnessArgs("公共回应。", [], text)), "call"), [], default, auth.Profile, 16, contextAlreadyRead: true);
        }
        await Record("你认得门口的人。SHARE_ONLY_THIS");
        await Record("你还知道另一个秘密。DO_NOT_SHARE");
        Auth(h, a.AccessToken); var before = (await h.Get(id))!;
        var parts = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!.Entries.SelectMany(e => e.PrivateParts ?? []).ToArray();
        Check.Equal(2, parts.Length); Check.True(parts.All(p => !p.Shared));
        var request = new SharePrivateStoryRequest(Id(), parts[0].Source);
        foreach (string credential in new[] { owner.AccessToken, b.AccessToken })
        {
            Auth(h, credential);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/story/share", request)).StatusCode);
        }
        Auth(h, b.AccessToken);
        string hidden = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/activity");
        Check.True(!hidden.Contains("SHARE_ONLY_THIS") && !hidden.Contains("DO_NOT_SHARE"));
        Auth(h, a.AccessToken);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/story/share", request with { Source = request.Source with { Revision = new string('a', 64) } })).StatusCode);
        var both = await Task.WhenAll(Share(h, id, request), Share(h, id, request));
        Check.True(both.Any(x => x.Replayed));
        var first = both[0].Snapshot;
        Check.Equal(before.Version, first.Version); Check.Equal(before.Events.Length, first.Events.Length); Check.Equal(before.ElapsedSeconds, first.ElapsedSeconds);
        Check.Equal(1, first.SharedStories!.Length); Check.Equal(parts[0].Text, first.SharedStories[0].Text);
        var duplicate = await Share(h, id, request with { RequestId = Id() }); Check.Equal(1, duplicate.Snapshot.SharedStories!.Length);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/story/share", request with { Source = parts[1].Source })).StatusCode);
        Auth(h, b.AccessToken);
        var other = (await h.Get(id))!; Check.Equal(parts[0].Text, other.SharedStories!.Single().Text);
        string body = HarnessJson.Serialize(other); Check.True(!body.Contains("DO_NOT_SHARE"));
        Check.True(other.Events.All(e => e.PrivateText == "" && e.PrivatePart is null));
        var feed = (await h.Http.GetFromJsonAsync<SharedStoryPage>($"/api/v1/campaigns/{id}/adventure/story/shared?after=0&limit=1"))!;
        Check.Equal(1, feed.NextAfter); Check.True(!feed.HasMore);
        // Old event sources remain shareable after falling outside the latest 100 events.
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            for (int i = 0; i < 101; i++) c.Events.Add(new(Id(), ++c.Version, "fixture", "public", "", "fixture", DateTimeOffset.UtcNow, null));
            return Task.FromResult(0);
        });
        Auth(h, a.AccessToken); var old = await Share(h, id, request with { RequestId = Id(), Source = parts[1].Source });
        Check.Equal(2, old.Snapshot.SharedStories!.Length);
        string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: HarnessTests.Configure(model));
        Auth(h, a.AccessToken); Check.True((await Share(h, id, request)).Replayed);
        var restored = (await h.Get(id))!; Check.Equal(2, restored.SharedStories!.Length);
        Auth(h, owner.AccessToken);
        var archived = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/archive", new ArchiveCampaignRequest(Id(), restored.Version, true));
        Check.Equal(HttpStatusCode.OK, archived.StatusCode);
        Auth(h, a.AccessToken); Check.True((await Share(h, id, request)).Replayed);
        await h.DisposeAsync();
    }

    public static async Task SharedKnowledgeIsFrozenPerModelSlotAndOldFramesStayUnchanged()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new HarnessTests.Model(async (_, request, ct) =>
        {
            string payload = string.Join("\n", request.Messages.Select(m => m.Content));
            Check.True(payload.Contains("SHARED_ONE") && !payload.Contains("PRIVATE_TWO"));
            started.TrySetResult(); await release.Task.WaitAsync(ct);
            return HarnessTests.Tool("world_record", new NarrativeHarnessArgs("公开引文已经看见。", []));
        });
        await using var h = await Host.Start(configure: HarnessTests.Configure(model));
        var owner = await HarnessTests.Create(h); var a = await HarnessBoundaryTests.Guest(h, owner); var b = await HarnessBoundaryTests.Guest(h, owner);
        var game = h.App.Services.GetRequiredService<GameService>(); string id = owner.Snapshot.Id, intent = Id();
        foreach (string text in new[] { "SHARED_ONE", "PRIVATE_TWO" })
        {
            var auth = await game.AuthorizeHarness(id, a.AccessToken, default);
            await game.HarnessTool(id, a.AccessToken, auth.ActorId, intent, "原行动", auth.Version, Id(), Id(),
                new("world_record", HarnessJson.Element(new NarrativeHarnessArgs("公共正文。", [], text)), "call"), [], default, auth.Profile, 16, contextAlreadyRead: true);
        }
        Auth(h, a.AccessToken); var parts = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!.Entries.SelectMany(e => e.PrivateParts ?? []).ToArray();
        await Share(h, id, new(Id(), parts[0].Source));
        Auth(h, b.AccessToken); var before = (await h.Get(id))!;
        var run = await HarnessTests.Start(h, before, "读刚才队友公开的消息");
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Auth(h, a.AccessToken); var second = await Share(h, id, new(Id(), parts[1].Source));
        Check.Equal(before.Version, second.Snapshot.Version); release.TrySetResult();
        Auth(h, b.AccessToken); Check.Equal("completed", (await HarnessTests.Settled(h, id, run.Id)).Status);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, b.Snapshot.Party!.SelfActorId, run.Id)!;
        var frame = saved.Steps.Single(s => s.Kind == "model").ExecutionFrame!;
        Check.Equal(1, frame.SharedStories!.Total); Check.True(!HarnessJson.Serialize(frame).Contains("PRIVATE_TWO"));
        var authB = await game.AuthorizeHarness(id, b.AccessToken, default);
        var next = await game.ReadHarnessExecution(id, b.AccessToken, authB.ActorId, Id(), "看公开消息", authB.Version, default, 38);
        Check.Equal(2, next.SharedStories!.Total); Check.Equal("PRIVATE_TWO", next.SharedStories.Entries.Last().Text);
        var old = await game.ReadHarnessExecution(id, b.AccessToken, authB.ActorId, Id(), "旧合同", authB.Version, default, 37);
        Check.True(old.SharedStories is null && old.NarrativeContract is null && old.Opening is null);
        var foreign = await HarnessTests.Create(h);
        Auth(h, foreign.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/story/share", new SharePrivateStoryRequest(Id(), parts[0].Source))).StatusCode);
        Check.Equal(1, model.Calls);
    }

    public static async Task SharingDoesNotInvalidateRollAndChangedRulingIsRejected()
    {
        var dice = new SequenceDice(15); await using var h = await Host.Start(dice: dice);
        var owner = await h.Create(); var guest = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
        Auth(h, guest.AccessToken); var state = (await h.Get(id))!;
        state = (await h.Act(state, "natural", text: "我仔细观察那人")).Snapshot;
        var ruling = state.PendingRulings.Single(r => r.Status == "pending");
        Auth(h, owner.AccessToken);
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rulings/respond", new ResolveRulingRequest(Id(), state.Version, ruling.Id, "check", "观察细节", "本场裁定", "wisdom", "Perception", 12, PrivateText: "你曾见过这个图案。"));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        Auth(h, guest.AccessToken); state = (await h.Get(id))!;
        var source = state.PendingRulings.Single(r => r.Id == ruling.Id).PrivatePart!.Source;
        var shared = await Share(h, id, new(Id(), source));
        Check.Equal(state.Version, shared.Snapshot.Version); Check.True(shared.Snapshot.PendingRoll!.Available); Check.Equal(0, dice.Count);
        var roll = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", new RollResponseRequest(Id(), state.Version, state.PendingRoll!.Id, "roll"));
        Check.Equal(HttpStatusCode.OK, roll.StatusCode); Check.Equal(1, dice.Count);
        // A stale revision must never publish a replacement private body.
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            int index = c.PendingRulings.FindIndex(r => r.Id == ruling.Id);
            c.PendingRulings[index] = c.PendingRulings[index] with { PrivateText = "替换后不应误公开" };
            return Task.FromResult(0);
        });
        var changed = (await h.Get(id))!.PendingRulings.Single(r => r.Id == ruling.Id).PrivatePart!;
        Check.True(!changed.Shared && changed.Source != source);
        // Already published exact text remains an idempotent success, not a publication of the new revision.
        var again = await Share(h, id, new(Id(), source));
        Check.Equal(1, again.Snapshot.SharedStories!.Length); Check.Equal("你曾见过这个图案。", again.Snapshot.SharedStories[0].Text);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/story/share", new SharePrivateStoryRequest(Id(), changed.Source with { Revision = new string('b', 64) }))).StatusCode);
    }
}
