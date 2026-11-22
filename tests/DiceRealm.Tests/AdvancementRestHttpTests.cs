using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementRestHttpTests
{
    private static async Task<ActionResponse> Post<T>(Host h, string path, T request)
    {
        var response = await h.Http.PostAsJsonAsync(path, request);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    public static async Task DeferredPoolSelectionAndRestart()
    {
        var dice = new SequenceDice(1, 2); var host = await Host.Start(dice: dice);
        var build = FullCreationTests.Complete("wizard", "human", "sage") with { BaseScores = [13, 12, 14, 15, 10, 8], BackgroundBonuses = [0, 0, 0, 2, 1, 0] };
        var response = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Advanced rest receipt", build.Identity.Name,
            Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = owner.Snapshot; string path = "/api/v1/campaigns/" + s.Id;
        s = (await Post(host, path + "/characters/advancement/award", new AwardAdvancementRequest(Guid.NewGuid().ToString(), s.Version, PartyEngine.HostId, "milestone", 3, "隔离回归：允许三级成长"))).Snapshot;
        foreach (string cls in new[] { "wizard", "fighter" })
            s = (await Post(host, path + "/character/advancement/apply", new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, AdvancementTests.Complete(s.Character.Required(), cls)))).Snapshot;
        s = (await Post(host, path + "/characters/adjust", new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, PartyEngine.HostId, "回归夹具已确认伤势", "隔离测试", [new CharacterAdjustment("hp", "", 1)]))).Snapshot;
        s = (await host.Rest(s, "short")).Snapshot;
        var proposed = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "rest.hit_die", "d10");
        var waiting = await Post(host, path + "/actions/propose", proposed); s = waiting.Snapshot;
        Check.Equal("awaiting_roll", waiting.Resolution.Status); Check.Equal(0, dice.Count);
        Check.Equal(1, s.Character.Required().HitPoints); Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Hit Dice (d10)"));
        Check.Equal(60, s.ElapsedMinutes); Check.True(s.PendingRoll!.Label.Contains("d10"));
        string root = host.Root; await host.DisposeAsync();
        await using var reopened = await Host.Start(root, dice: dice);
        reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var replay = await Post(reopened, path + "/actions/propose", proposed);
        Check.True(replay.Replayed); Check.Equal(0, dice.Count);
        var confirm = new RollResponseRequest(Guid.NewGuid().ToString(), s.Version, s.PendingRoll.Id, "roll");
        var both = await Task.WhenAll(Post(reopened, path + "/rolls/respond", confirm), Post(reopened, path + "/rolls/respond", confirm));
        Check.True(both[0].Replayed != both[1].Replayed); s = both[0].Snapshot;
        Check.Equal(1, dice.Count); Check.Equal(0, CharacterEngine.Value(s.Character.Required(), "Hit Dice (d10)"));
        Check.Equal(2, CharacterEngine.Value(s.Character, "Hit Dice (d6)")); Check.Equal(60, s.ElapsedMinutes); Check.Equal(4, s.Character.HitPoints);
        Check.True(both[0].Resolution.Summary.Contains("d10 [1]"));
        var extra = await Post(reopened, path + "/actions/propose", new ActionRequest(Guid.NewGuid().ToString(), s.Version, "rest.hit_die", ""));
        Check.Equal("awaiting_roll", extra.Resolution.Status); Check.Equal(1, dice.Count);
        var cancel = await Post(reopened, path + "/rolls/respond", new RollResponseRequest(Guid.NewGuid().ToString(), extra.Snapshot.Version, extra.Snapshot.PendingRoll!.Id, "cancel"));
        Check.Equal("cancelled", cancel.Resolution.Status); Check.Equal(1, dice.Count);
        Check.Equal(2, CharacterEngine.Value(cancel.Snapshot.Character.Required(), "Hit Dice (d6)"));
    }
}
