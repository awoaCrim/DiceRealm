using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class CharacterReviewTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static async Task<ActionResponse> Post(Host h, string id, string route, object body)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{route}", body);
        if (response.StatusCode != HttpStatusCode.OK) throw new Exception(response.StatusCode + " " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private static async Task<CreatedCampaign> Join(Host h, CreatedCampaign owner, CharacterBuild? build = null, char inviteSecret = 'a', char seatSecret = 'b')
    {
        build ??= FullCreationTests.Named("新队员");
        Auth(h, owner.AccessToken); var s = (await h.Get(owner.Snapshot.Id))!;
        var invite = new InviteRequest(Id(), s.Version, new string(inviteSecret, 64));
        await Post(h, s.Id, "invitations", invite);
        var result = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", new JoinCampaignRequest(Id(), invite.InviteToken, new string(seatSecret, 64), build?.Identity.Name ?? "新队员", Build: build));
        Check.Equal(HttpStatusCode.OK, result.StatusCode);
        return (await result.Content.ReadFromJsonAsync<CreatedCampaign>())!;
    }
    private static ReviewCharacterRequest Review(CampaignSnapshot s, string actor, string decision, string reason = "") =>
        new(Id(), s.Version, actor, s.Party!.Members.Single(m => m.Id == actor).Review!.Revision, decision, reason);

    public static async Task LifecycleAndGates()
    {
        var dice = new SequenceDice(18); await using var h = await Host.Start(dice: dice);
        var owner = await h.Create(); var guest = await Join(h, owner); var s = guest.Snapshot;
        string actor = s.Party!.SelfActorId;
        Check.Equal("host_creation", owner.Snapshot.Party!.Members[0].Review!.Source);
        Check.Equal("pending", s.Party.Members.Single(m => m.Id == actor).Review!.Status);
        Auth(h, guest.AccessToken); Check.Equal(0, s.AvailableActions.Length);
        foreach (string route in new[] { "actions", "actions/propose", "actions/interpret" })
        {
            var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/{route}", new ActionRequest(Id(), s.Version, "natural", Text: "观察"));
            Check.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Check.True((await response.Content.ReadAsStringAsync()).Contains("character_review_required"));
        }
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/character/commands", new CharacterPlayRequest(Id(), s.Version, "check", "save:wisdom"))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review", Review(s, actor, "approve"))).StatusCode);
        Check.Equal(s.Version, (await h.Get(s.Id))!.Version); Check.Equal(0, dice.Count);
        Auth(h, owner.AccessToken);
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review", Review(s, actor, "return"))).StatusCode);
        var returned = Review(s, actor, "return", "请补充角色动机并采用已讨论的职业");
        s = (await Post(h, s.Id, "characters/review", returned)).Snapshot;
        Check.Equal("returned", s.Party!.Members.Single(m => m.Id == actor).Review!.Status);
        Check.True((await Post(h, s.Id, "characters/review", returned)).Replayed);
        Auth(h, guest.AccessToken);
        string characterId = s.Party.Members.Single(m => m.Id == actor).Character.Id;
        var resubmit = new ResubmitCharacterRequest(Id(), s.Version, 1, "希望寻找失散的老师", "修订法师", Build: FullCreationTests.Named("修订法师", CharacterEngine.Wizard));
        s = (await Post(h, s.Id, "character/resubmit", resubmit)).Snapshot;
        Check.Equal(characterId, s.Character.Required().Id); Check.Equal("Wizard", s.Character.Required().ClassName); Check.Equal(2, s.Party!.Members.Single(m => m.Id == actor).Review!.Revision);
        Check.True((await Post(h, s.Id, "character/resubmit", resubmit)).Replayed);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/character/resubmit", resubmit with { Submission = "changed" })).StatusCode);
        Auth(h, owner.AccessToken);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review", Review(s, actor, "approve") with { Revision = 1 })).StatusCode);
        var approve = Review(s, actor, "approve", "动机与资料已核对");
        var responses = await Task.WhenAll(Post(h, s.Id, "characters/review", approve), Post(h, s.Id, "characters/review", approve));
        Check.True(responses.Any(r => r.Replayed)); s = responses[0].Snapshot;
        Check.Equal(6, s.Version); // arrival, invite, join, return, resubmit, approval
        Auth(h, guest.AccessToken); s = (await h.Get(s.Id))!;
        Check.True(s.AvailableActions.Any(a => a.Kind == "talk"));
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/character/resubmit", resubmit with { RequestId = Id(), ExpectedVersion = s.Version, Revision = 2 })).StatusCode);
        s = (await h.Act(s, "talk")).Snapshot;
        Check.True(s.Facts.Contains("keeper-instructions"));
        s = (await h.Act(s, "travel", "causeway")).Snapshot;
        Check.Equal("causeway", s.Scene.Id); Check.True(s.AvailableActions.Any(a => a.Kind == "combat.start"));
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/invitations", new InviteRequest(Id(), s.Version, new string('c', 64)))).StatusCode);
        Check.Equal(0, dice.Count);
    }

    public static async Task RestartRacesAndLegacy()
    {
        var h = await Host.Start(); var owner = await h.Create(); var guest = await Join(h, owner); string actor = guest.Snapshot.Party!.SelfActorId;
        var s = (await h.Get(owner.Snapshot.Id))!;
        var approve = Review(s, actor, "approve", "审核确认");
        var returned = Review(s, actor, "return", "补充说明");
        var race = await Task.WhenAll(h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review", approve), h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review", returned));
        Check.Equal(1, race.Count(r => r.IsSuccessStatusCode)); Check.Equal(1, race.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        var winner = race[0].IsSuccessStatusCode ? approve : returned;
        s = (await h.Get(s.Id))!; Check.Equal(4, s.Version);
        string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root); Auth(h, owner.AccessToken);
        var replay = await Post(h, s.Id, "characters/review", winner); Check.True(replay.Replayed); Check.Equal(s.Version, replay.Snapshot.Version);
        var raw = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review", new { requestId = Id(), expectedVersion = s.Version, actorId = actor, revision = 1, decision = "approve", hitPoints = 999 });
        Check.Equal(HttpStatusCode.BadRequest, raw.StatusCode);
        // Old aggregates have no review data. Reading and playing them must not invent a DM decision.
        await h.App.Services.GetRequiredService<CampaignStore>().Access(s.Id, owner.AccessToken, true, c =>
        {
            c.HostReview = null; c.PartyMembers.Single(m => m.Id == actor).Review = null; return Task.FromResult(true);
        });
        Auth(h, guest.AccessToken); s = (await h.Get(s.Id))!;
        Check.Equal("legacy", s.Party!.Members.Single(m => m.Id == actor).Review!.Source);
        Check.True(s.AvailableActions.Length > 0); s = (await h.Act(s, "observe")).Snapshot;
        Check.Equal(5, s.Version);
        await h.DisposeAsync();
    }

    public static async Task PendingSeatsStayOutOfCombat()
    {
        var dice = new SequenceDice(15); await using var h = await Host.Start(dice: dice); var owner = await h.Create(); var guest = await Join(h, owner);
        var s = (await h.Get(owner.Snapshot.Id))!;
        string before = JsonSerializer.Serialize(s.Party!.Members.Single(m => m.Id == guest.Snapshot.Party!.SelfActorId).Character);
        s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
        var request = new ActionRequest(Id(), s.Version, "combat.start");
        s = (await Post(h, s.Id, "actions/propose", request)).Snapshot;
        Auth(h, guest.AccessToken); Check.True((await h.Get(s.Id))!.PendingRoll is null);
        Auth(h, owner.AccessToken);
        var approval = Review(s, guest.Snapshot.Party!.SelfActorId, "approve");
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/characters/review", approval)).StatusCode);
        s = (await Post(h, s.Id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
        Check.Equal(2, s.Combat!.Units.Length);
        Check.Equal(before, JsonSerializer.Serialize(s.Party!.Members.Single(m => m.Id == guest.Snapshot.Party!.SelfActorId).Character));
    }
    public static async Task PrivateReviewHistoryAndInputResubmit()
    {
        await using var h = await Host.Start(); var owner = await h.Create();
        var build = FullCreationTests.Complete("rogue", "elf", "sage");
        build = build with { Identity = build.Identity with { Backstory = "PRIVATE_BUILD_SENTINEL" } };
        var first = await Join(h, owner, build); var second = await Join(h, owner, inviteSecret: 'c', seatSecret: 'd');
        var s = (await h.Get(owner.Snapshot.Id))!; string actor = first.Snapshot.Party!.SelfActorId;
        s = (await Post(h, s.Id, "characters/review", Review(s, actor, "return", "PRIVATE_REASON_SENTINEL"))).Snapshot;
        Auth(h, first.AccessToken);
        var input = new ActionRequest(Id(), s.Version, "natural", Text: "重新提交审核：PRIVATE_SUBMISSION_SENTINEL");
        s = (await Post(h, s.Id, "actions/input", input)).Snapshot;
        Check.Equal("pending", s.Party!.Members.Single(m => m.Id == actor).Review!.Status);
        Check.True((await Post(h, s.Id, "actions/input", input)).Replayed);
        Check.Equal(0, s.AvailableActions.Length);
        Auth(h, second.AccessToken);
        foreach (string route in new[] { "", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100", "/recap" })
        {
            var body = await h.Http.GetStringAsync($"/api/v1/campaigns/{s.Id}" + route);
            Check.True(!body.Contains("PRIVATE_"), "Review correspondence escaped through " + route);
        }
        Auth(h, owner.AccessToken); s = (await h.Get(s.Id))!;
        Check.True(s.Party!.Members.Single(m => m.Id == actor).Character.Build!.Identity.Backstory.Contains("PRIVATE_BUILD"));
        s = (await Post(h, s.Id, "characters/review", Review(s, actor, "return", "补充更多"))).Snapshot;
        Auth(h, first.AccessToken);
        s = (await Post(h, s.Id, "actions/input", new ActionRequest(Id(), s.Version, "natural", Text: "重新提交审核：第二次说明"))).Snapshot;
        Check.True(s.Events.Any(e => e.Text.Contains("PRIVATE_SUBMISSION_SENTINEL")));
        Auth(h, owner.AccessToken);
        s = (await Post(h, s.Id, "characters/review", Review(s, actor, "approve", "PRIVATE_APPROVAL_SENTINEL"))).Snapshot;
        Check.True(s.Events.Any(e => e.Text.Contains("PRIVATE_APPROVAL_SENTINEL")));
        Auth(h, second.AccessToken);
        Check.True(!(await h.Http.GetStringAsync($"/api/v1/campaigns/{s.Id}")).Contains("PRIVATE_"));
        Auth(h, first.AccessToken);
        Check.True((await Post(h, s.Id, "actions/input", input)).Replayed);
    }

    public static async Task PreReviewLegacyReceipt()
    {
        string hostToken = new('a', 64), guestToken = new('b', 64), actor = Id();
        var c = TestContent.Campaign(tokenHash: hostToken); c.Version = 2;
        c.PartyMembers.Add(new() { Id = actor, TokenHash = JsonFiles.Hash(guestToken), Character = CharacterEngine.Create("历史角色", CharacterEngine.Fighter) });
        var request = new ActionRequest(Id(), 1, "observe");
        var resolution = new Resolution("resolved", "observe", "UPGRADE_SAVED_RESULT", null, []);
        c.Events.Add(new(Id(), 1, "arrival", "arrival", "", "authored", DateTimeOffset.UtcNow, null));
        c.Events.Add(new(Id(), 2, "observe", resolution.Summary, "", "authored", DateTimeOffset.UtcNow, resolution, actor));
        c.Receipts.Add(new(request.RequestId, JsonFiles.Hash(JsonSerializer.Serialize(request, JsonFiles.Options)), resolution, actor));
        var json = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(c, JsonFiles.Options))!.AsObject();
        json.Remove("hostReview"); foreach (var seat in json["partyMembers"]!.AsArray()) seat!.AsObject().Remove("review");
        foreach (var e in json["events"]!.AsArray()) e!.AsObject().Remove("reviewActorId");
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-review-upgrade-" + Id());
        string path = Path.Combine(root, "campaigns", c.Id + ".json"); Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, json.ToJsonString());
        byte[] original = File.ReadAllBytes(path); var dice = new SequenceDice();
        var h = await Host.Start(root, dice: dice); Auth(h, guestToken);
        var replay = (await (await h.Send(c.Id, request)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal("UPGRADE_SAVED_RESULT", replay.Resolution.Summary); Check.Equal("legacy", replay.Snapshot.Party!.Members.Single(m => m.Id == actor).Review!.Source);
        await h.DisposeAsync(); await using var restarted = await Host.Start(root, dice: dice); Auth(restarted, guestToken);
        replay = (await (await restarted.Send(c.Id, request)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(2, replay.Snapshot.Version); Check.Equal(0, dice.Count); Check.True(original.SequenceEqual(File.ReadAllBytes(path)));
    }

}
