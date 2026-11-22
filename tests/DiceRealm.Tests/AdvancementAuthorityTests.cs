using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementAuthorityTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static async Task<ActionResponse> Post<T>(Host h, string path, T request)
    {
        var response = await h.Http.PostAsJsonAsync(path, request);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    public static async Task SeatsReviewRaceAndRevocation()
    {
        var dice = new SequenceDice(); await using var h = await Host.Start(dice: dice);
        var hostBuild = FullCreationTests.Complete("wizard", "human", "sage");
        var created = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Growth seats", hostBuild.Identity.Name,
            Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: hostBuild));
        Check.Equal(HttpStatusCode.Created, created.StatusCode);
        var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!; var s = owner.Snapshot;
        string path = "/api/v1/campaigns/" + s.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        string secret = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        await Post(h, path + "/invitations", new InviteRequest(Id(), s.Version, secret));
        var guestBuild = FullCreationTests.Complete("fighter", "human", "soldier");
        var joined = await h.Http.PostAsJsonAsync(path + "/join", new JoinCampaignRequest(Id(), secret, Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"), guestBuild.Identity.Name, Build: guestBuild));
        Check.Equal(HttpStatusCode.OK, joined.StatusCode); var guest = (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        string actor = guest.Snapshot.Party!.SelfActorId;
        s = (await h.Get(s.Id))!;
        s = (await Post(h, path + "/characters/advancement/award", new AwardAdvancementRequest(Id(), s.Version, PartyEngine.HostId, "milestone", 2, "隔离审核与成长回归"))).Snapshot;
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync(path + "/characters/advancement/award", new AwardAdvancementRequest(Id(), s.Version, actor, "milestone", 2, "未批准的席位不能获奖"))).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var view = (await h.Http.GetFromJsonAsync<AdvancementView>(path + "/character/advancement"))!;
        Check.Equal(1, view.MaximumLevel); Check.True(!view.Available && view.Reason.Contains("审核"));
        var draft = AdvancementTests.Complete(guest.Snapshot.Character.Required());
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path + "/character/advancement/preview", new PreviewAdvancementRequest(s.Version, draft))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path + "/character/advancement/apply", new ApplyAdvancementRequest(Id(), s.Version, draft))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path + "/characters/advancement/award", new AwardAdvancementRequest(Id(), s.Version, actor, "experience", 1000, "不能自行授奖"))).StatusCode);
        guest = await h.ApproveGuest(owner, guest); s = guest.Snapshot;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        await Post(h, path + "/characters/advancement/award", new AwardAdvancementRequest(Id(), s.Version, actor, "milestone", 2, "已审核角色的隔离成长回归"));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken); s = (await h.Get(s.Id))!;
        var first = new ApplyAdvancementRequest(Id(), s.Version, draft); var other = first with { RequestId = Id() };
        var race = await Task.WhenAll(h.Http.PostAsJsonAsync(path + "/character/advancement/apply", first), h.Http.PostAsJsonAsync(path + "/character/advancement/apply", other));
        Check.Equal(1, race.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, race.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        int winner = race[0].StatusCode == HttpStatusCode.OK ? 0 : 1;
        var accepted = winner == 0 ? first : other;
        s = (await race[winner].Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        Check.Equal(2, s.Character.Required().Level); Check.Equal(guest.Snapshot.Character.Required().Id, s.Character.Required().Id);
        Check.Equal(1, s.Party!.Members.Single(m => m.Id == PartyEngine.HostId).Character.Level);
        Check.True((await Post(h, path + "/character/advancement/apply", accepted)).Replayed);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        s = (await h.Get(s.Id))!;
        // The same external UUID belongs to two distinct authorized seat receipt scopes.
        var hostRequest = new ApplyAdvancementRequest(accepted.RequestId, s.Version, AdvancementTests.Complete(s.Character.Required()));
        var hostApply = await Post(h, path + "/character/advancement/apply", hostRequest);
        Check.True(!hostApply.Replayed); Check.Equal(owner.Snapshot.Character.Required().Id, hostApply.Snapshot.Character.Required().Id); Check.Equal(2, hostApply.Snapshot.Character.Required().Level);
        s = (await Post(h, path + "/seats/revoke", new RevokeSeatRequest(Id(), hostApply.Snapshot.Version, actor))).Snapshot;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync(path + "/character/advancement/apply", accepted)).StatusCode);
        Check.Equal(0, dice.Count);
    }

    public static Task OutstandingChoiceBlocksPreview()
    {
        var c = TestContent.Campaign("harbor", "Growth waits");
        c.Character = BuildEvaluator.Create(FullCreationTests.Complete("fighter", "human", "soldier"));
        c.AdvancementAwards = [new(PartyEngine.HostId, "milestone", 2, "test", 1)];
        var draft = AdvancementTests.Complete(c.Character);
        Check.True(AdvancementOpportunities.View(c, draft).Preview!.CanApply);
        c.PendingIntents.Add(new PendingIntent { Id = Id(), ActorId = PartyEngine.HostId, Text = "旧选择" });
        var intent = AdvancementOpportunities.View(c, draft);
        Check.True(!intent.Available && !intent.Preview!.CanApply && intent.Reason.Contains("意图"));
        c.PendingIntents.Clear(); c.PendingRolls.Add(new PendingRoll { Id = Id(), ActorId = PartyEngine.HostId, Label = "roll", Description = "test" });
        var roll = AdvancementOpportunities.View(c, draft);
        Check.True(!roll.Available && !roll.Preview!.CanApply && roll.Reason.Contains("投掷"));
        return Task.CompletedTask;
    }
}
