using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class ContinuityBoundaryTests
{
    private static StoryRequest Story(CampaignSnapshot s, string rulingId, string mode = "facts") =>
        new(Guid.NewGuid().ToString(), s.Version, rulingId, mode, "主持确认本次行动后果", "当前导入内容", Facts: mode == "facts" ? [new("safe-route", true)] : []);
    private static async Task<ActionResponse> Commit(Host h, string path, object request)
    {
        var response = await h.Http.PostAsJsonAsync(path, request);
        if (response.StatusCode != HttpStatusCode.OK) throw new Exception(response.StatusCode + " " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    public static async Task PermissionsAndHistory()
    {
        await using var h = await Host.Start(); var owner = await h.Create(); var s = owner.Snapshot; string path = $"/api/v1/campaigns/{s.Id}";
        var invite = new InviteRequest(Guid.NewGuid().ToString(), s.Version, new string('a', 64));
        s = (await Commit(h, path + "/invitations", invite)).Snapshot;
        var join = await h.Http.PostAsJsonAsync(path + "/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), invite.InviteToken, new string('b', 64), "伙伴", Build: FullCreationTests.Named("伙伴")));
        var guest = await h.ApproveGuest(owner, (await join.Content.ReadFromJsonAsync<CreatedCampaign>())!);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        s = (await h.Act(guest.Snapshot, "natural", text: "向队长报告看到的航路标记")).Snapshot;
        int sequence = s.Version; string rid = s.PendingRulings.Last().Id; var request = Story(s, rid);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync(path + "/rulings/story-options?rulingId=" + rid)).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path + "/rulings/story-preview", request)).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path + "/rulings/story", request)).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        foreach (var facts in new StoryFact[][] { [new("never-declared", true)], [new("visited:beacon", true)], [new("safe-route", true), new("safe-route", false)], [null!] })
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync(path + "/rulings/story-preview", request with { Facts = facts })).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story-preview", request with { Facts = [new("safe-route", false)] })).StatusCode);
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync(path + "/rulings/story-preview", request)).StatusCode);
        s = (await h.Act(s, "observe")).Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story", request)).StatusCode);
        request = request with { ExpectedVersion = s.Version }; s = (await Commit(h, path + "/rulings/story", request)).Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story", request with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = s.Version })).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story", request with { Rationale = "changed" })).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var activity = (await h.Http.GetFromJsonAsync<ActivityEntry>(path + "/activity/" + sequence))!;
        Check.Equal("completed", activity.Status); Check.Equal("伙伴", activity.Origin!.ActorName); Check.Equal(s.Version, activity.Version);
        var guestReadback = (await h.Get(s.Id))!;
        Check.True(guestReadback.Facts.Contains("safe-route"));
        Check.True(activity.Ruling!.Story!.Changes.Any(x => x.Kind == "route" && x.Key == "causeway")); // Host alone moves the party; all seats read its consequence.
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        s = (await h.Act(s, "natural", text: "暂缓处理的码头问题")).Snapshot; string old = s.PendingRulings.Last().Id;
        s = (await h.Act(s, "travel", "causeway")).Snapshot;
        var oldRequest = Story(s, old) with { Facts = [new("keeper-instructions", true)] };
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story", oldRequest)).StatusCode);
        s = (await Commit(h, path + "/rulings/story", Story(s, old, "none"))).Snapshot;
        Check.True(!s.Facts.Contains("keeper-instructions"));
        // Frozen root pages report current linked progress, including roots outside latest 100.
        for (int i = 0; i < 102; i++) s = (await h.Act(s, "observe")).Snapshot;
        activity = (await h.Http.GetFromJsonAsync<ActivityEntry>(path + "/activity/" + sequence))!;
        Check.Equal("completed", activity.Status); Check.Equal(s.Version, activity.Version);
        var page = (await h.Http.GetFromJsonAsync<ActivityPage>(path + $"/activity?after=0&through={sequence}&limit=10"))!;
        Check.Equal(sequence, page.Through); Check.Equal(sequence, page.NextAfter); Check.True(!page.HasMore);
        Check.True(page.Entries.All(x => x.Sequence <= sequence)); Check.Equal("completed", page.Entries.Single(x => x.Sequence == sequence).Status);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(path + "/activity/1")).StatusCode);
    }
    public static async Task OutcomesAndCosts()
    {
        var dice = new SequenceDice(2); await using var h = await Host.Start(dice: dice);
        var doc = TestContent.Document; var harbor = doc.Scenes.First();
        var costAction = new ContentAction { Id = "test-cost", Kind = "script.cost", Label = "支付一枚金币并取得线索", Always = [new("item", "gold-piece", -1)], Success = new("线索已取得", [new("fact", "keeper-instructions"), new("item", "gold-piece", 2)]) };
        doc = doc with { Scenes = doc.Scenes.Select(x => x.Id == harbor.Id ? x with { Actions = [..x.Actions, costAction] } : x).ToArray() };
        var creation = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("成本与结果", "Arden", Adventure: doc, Prompts: TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden")));
        Check.Equal(HttpStatusCode.Created, creation.StatusCode); var owner = (await creation.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); var s = owner.Snapshot; string path = $"/api/v1/campaigns/{s.Id}";
        s = (await h.Act(s, "natural", text: "寻找航路")).Snapshot; string rid = s.PendingRulings.Last().Id;
        var request = Story(s, rid, "action") with { ContentActionId = "harbor-investigate", Outcome = "success" };
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story-preview", request)).StatusCode); Check.Equal(0, dice.Count);
        var check = new ResolveRulingRequest(Guid.NewGuid().ToString(), s.Version, rid, "check", "寻找航路", "导入内容", "wisdom", "Perception", 12);
        s = (await Commit(h, path + "/rulings/resolve", check)).Snapshot; Check.Equal(1, dice.Count);
        request = request with { ExpectedVersion = s.Version };
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story", request)).StatusCode);
        request = request with { Outcome = "failure" }; s = (await Commit(h, path + "/rulings/story", request)).Snapshot;
        Check.True(s.Facts.Contains("investigated:harbor")); Check.True(!s.Facts.Contains("safe-route")); Check.Equal(1, dice.Count);
        Check.True(s.AvailableActions.All(x => x.Kind != "investigate"));
        // A paid item is never charged again by an authored consequence, even if rejected later.
        s = (await Commit(h, path + "/character/commands", new CharacterPlayRequest(Guid.NewGuid().ToString(), s.Version, "consume", "gold-piece"))).Snapshot;
        rid = s.PendingRulings.Last().Id; int paidSequence = s.Version; int gold = s.Character.Required().Inventory.Single(x => x.Id == "gold-piece").Quantity;
        request = Story(s, rid, "action") with { ContentActionId = "test-cost", Outcome = "success" };
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story-preview", request)).StatusCode);
        var activity = (await h.Http.GetFromJsonAsync<ActivityEntry>(path + "/activity/" + paidSequence))!;
        Check.Equal("awaiting_ruling", activity.Status); Check.True(activity.Origin!.Changes.Any(x => x.Operation == "inventory" && x.Key == "gold-piece" && x.After == gold.ToString()));
        s = (await Commit(h, path + "/rulings/resolve", new ResolveRulingRequest(Guid.NewGuid().ToString(), s.Version, rid, "reject", "本次请求未获准，另行讨论补偿", "主持裁定"))).Snapshot;
        Check.Equal(gold, s.Character.Required().Inventory.Single(x => x.Id == "gold-piece").Quantity);
        activity = (await h.Http.GetFromJsonAsync<ActivityEntry>(path + "/activity/" + paidSequence))!; Check.Equal("rejected", activity.Status);
        // An unpaid root can apply the authored cost/reward once. Preview and retry don't pay.
        s = (await h.Act(s, "natural", text: "向守港人购买线索")).Snapshot; rid = s.PendingRulings.Last().Id;
        request = Story(s, rid, "action") with { ContentActionId = "test-cost", Outcome = "success" };
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync(path + "/rulings/story-preview", request)).StatusCode);
        Check.Equal(gold, (await h.Get(s.Id))!.Character.Required().Inventory.Single(x => x.Id == "gold-piece").Quantity);
        s = (await Commit(h, path + "/rulings/story", request)).Snapshot;
        Check.Equal(gold + 1, s.Character.Required().Inventory.Single(x => x.Id == "gold-piece").Quantity); Check.Equal(1, dice.Count);
        s = (await h.Act(s, "natural", text: "再次询问同一份线索")).Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/rulings/story", request with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = s.Version, RulingId = s.PendingRulings.Last().Id })).StatusCode);
    }
}
