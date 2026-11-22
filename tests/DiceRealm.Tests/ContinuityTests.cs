using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Application;

namespace DiceRealm.Tests;

internal static class ContinuityTests
{
    private sealed class TravelIntent : IIntentInterpreter
    {
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null) => Task.FromResult<Intent?>(new("travel", "causeway"));
    }
    public static async Task MatchedTarget()
    {
        await using var h = await Host.Start(interpreter: new TravelIntent());
        var s = (await h.Create()).Snapshot; s = (await h.Act(s, "talk")).Snapshot;
        var result = await h.Act(s, "natural", text: "沿安全路线前往堤道");
        var origin = result.Snapshot.Events.Last().Origin!;
        Check.Equal("causeway", origin.Target); Check.Equal("harbor", origin.SceneId);
        Check.Equal("沿安全路线前往堤道", origin.Input); Check.Equal("natural", origin.RequestedKind);
        Check.Equal(s.ElapsedSeconds, origin.ElapsedSecondsBefore); Check.Equal(result.Snapshot.ElapsedSeconds, origin.ElapsedSecondsAfter);
        Check.True(origin.ElapsedSecondsAfter > origin.ElapsedSecondsBefore);
    }
    public static async Task Loop()
    {
        var dice = new SequenceDice(16); var h = await Host.Start(dice: dice);
        var owner = await h.Create(); var s = owner.Snapshot; string id = s.Id;
        s = (await h.Act(s, "natural", text: "查看岸边留下的航路记号，找出安全通道")).Snapshot;
        int originSequence = s.Version; string rulingId = s.PendingRulings.Single().Id;
        var ruling = new ResolveRulingRequest(Guid.NewGuid().ToString(), s.Version, rulingId, "check", "根据航路记号确认安全路线", "主持依据当前导入内容", "wisdom", "Perception", 12);
        var decision = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rulings/resolve", ruling);
        Check.Equal(HttpStatusCode.OK, decision.StatusCode); s = (await decision.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        var request = new { requestId = Guid.NewGuid().ToString(), expectedVersion = s.Version, rulingId, mode = "facts", rationale = "检定成功，确认通往堤道的路线", ruleSource = "主持依据导入的路线条件", contentActionId = "", outcome = "", facts = new[] { new { key = "safe-route", present = true } } };
        string url = $"/api/v1/campaigns/{id}/rulings/story";
        var preview = await h.Http.PostAsJsonAsync(url + "-preview", request);
        Check.Equal(HttpStatusCode.OK, preview.StatusCode);
        Check.Equal(s.Version, (await h.Get(id))!.Version); Check.Equal(1, dice.Count);
        var results = await Task.WhenAll(h.Http.PostAsJsonAsync(url, request), h.Http.PostAsJsonAsync(url, request));
        foreach (var result in results) Check.Equal(HttpStatusCode.OK, result.StatusCode);
        var a = (await results[0].Content.ReadFromJsonAsync<ActionResponse>())!;
        var b = (await results[1].Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(a.Replayed != b.Replayed); s = a.Snapshot;
        Check.Equal(request.expectedVersion + 1, s.Version); Check.True(s.Facts.Contains("safe-route"));
        Check.True(s.AvailableActions.Any(x => x.Kind == "travel" && x.Target == "causeway"));
        var activity = await h.Http.GetFromJsonAsync<JsonElement>($"/api/v1/campaigns/{id}/activity/{originSequence}");
        Check.Equal("completed", activity.GetProperty("status").GetString());
        Check.Equal("查看岸边留下的航路记号，找出安全通道", activity.GetProperty("origin").GetProperty("input").GetString());
        Check.Equal(rulingId, activity.GetProperty("ruling").GetProperty("id").GetString());
        Check.Equal(19, activity.GetProperty("ruling").GetProperty("check").GetProperty("total").GetInt32());
        var root = h.Root; await h.DisposeAsync(); await using var restart = await Host.Start(root, dice);
        restart.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", owner.AccessToken);
        var replay = await restart.Http.PostAsJsonAsync(url, request);
        Check.Equal(HttpStatusCode.OK, replay.StatusCode); Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        Check.Equal(1, dice.Count); s = (await restart.Get(id))!;
        s = (await restart.Act(s, "travel", "causeway")).Snapshot; Check.Equal("causeway", s.Scene.Id);
    }
}
