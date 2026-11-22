using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class ContextualRollTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    private static async Task<ActionResponse> Post<T>(Host h, string id, string endpoint, T request)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{endpoint}", request);
        Check.True(response.StatusCode == HttpStatusCode.OK, endpoint + ": " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private static RollResponseRequest Respond(CampaignSnapshot s, string decision = "roll") => new(Id(), s.Version, s.PendingRoll!.Id, decision);
    private sealed class CountingText : IIntentInterpreter, INarrator
    {
        public int Interpretations, Narrations;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Interpretations++; return Task.FromResult<Intent?>(new("investigate", "")); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Narrations++; return Task.FromResult(new Narrative("", "fixture")); }
    }
    private static async Task<CreatedCampaign> AddGuest(Host h, CreatedCampaign owner)
    {
        var s = (await h.Get(owner.Snapshot.Id))!;
        string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var invite = new InviteRequest(Id(), s.Version, Secret());
        await Post(h, s.Id, "invitations", invite);
        var join = new JoinCampaignRequest(Id(), invite.InviteToken, Secret(), "Guest", CharacterEngine.Fighter, Build: FullCreationTests.Named("Guest", CharacterEngine.Wizard));
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", join);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return await h.ApproveGuest(owner, (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!);
    }

    public static async Task DeferredActionAndRestart()
    {
        var dice = new SequenceDice(17); var text = new CountingText(); var h = await Host.Start(dice: dice, interpreter: text, narrator: text);
        var owner = await h.Create(); var initial = owner.Snapshot; var request = new ActionRequest(Id(), initial.Version, "natural", Text: "仔细查看现场");
        var staged = await Post(h, initial.Id, "actions/propose", request); var s = staged.Snapshot;
        Check.Equal("awaiting_roll", staged.Resolution.Status); Check.Equal(0, dice.Count); Check.Equal(1, text.Interpretations); Check.Equal(0, text.Narrations);
        Check.True(s.PendingRoll!.Available); Check.Equal(2, s.Version); Check.Equal(0, s.Facts.Length);
        Check.Equal(JsonSerializer.Serialize(initial.Character), JsonSerializer.Serialize(s.Character));
        Check.Equal("", s.Events.Last().Narrative); Check.Equal(0, s.Events.Last().Origin!.Changes.Length);
        var replay = await Post(h, s.Id, "actions/propose", request); Check.True(replay.Replayed); Check.Equal(1, text.Interpretations);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/actions/propose", request with { Text = "changed" })).StatusCode);
        // Payload and its interpreted target survive restart. No second interpretation occurs on confirm.
        var root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice, interpreter: text, narrator: text); Auth(h, owner.AccessToken);
        s = (await h.Get(s.Id))!; Check.True(s.PendingRoll is not null); Check.Equal(0, dice.Count);
        var confirm = Respond(s);
        var both = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Post(h, s.Id, "rolls/respond", confirm)));
        Check.Equal(1, dice.Count); Check.Equal(1, text.Interpretations); Check.Equal(1, text.Narrations); Check.True(both.Any(x => x.Replayed));
        var done = both[0]; Check.Equal(3, done.Snapshot.Version); Check.True(done.Snapshot.PendingRoll is null); Check.Equal(17, done.Resolution.Check!.Selected);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rolls/respond", confirm with { Decision = "cancel" })).StatusCode);
        var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!;
        var entry = activity.Entries.Single(); Check.Equal(2, entry.Sequence); Check.Equal("completed", entry.Status); Check.Equal(17, entry.InitialResult!.Check!.Selected);
        Check.Equal("仔细查看现场", entry.Origin!.Input); Check.Equal("investigate", entry.InitialResult.Kind);
        Check.True(!JsonSerializer.Serialize(done.Snapshot).Contains("expectedVersion"), "Private continuation must not be projected");
        await h.DisposeAsync(); await using var restarted = await Host.Start(root, dice, interpreter: text, narrator: text); Auth(restarted, owner.AccessToken);
        Check.True((await Post(restarted, s.Id, "rolls/respond", confirm)).Replayed); Check.Equal(1, dice.Count);
        var originalReplay = await Post(restarted, s.Id, "actions/propose", request); Check.True(originalReplay.Replayed); Check.True(originalReplay.Snapshot.PendingRoll is null);
    }

    public static async Task AuthorityAndCancellation()
    {
        var dice = new SequenceDice(16); await using var h = await Host.Start(dice: dice); var owner = await h.Create(); var guest = await AddGuest(h, owner);
        var s = (await h.Get(owner.Snapshot.Id))!;
        var staged = await Post(h, s.Id, "actions/propose", new ActionRequest(Id(), s.Version, "investigate")); s = staged.Snapshot; var hostRoll = Respond(s);
        Auth(h, guest.AccessToken); var guestView = (await h.Get(s.Id))!; Check.True(guestView.PendingRoll is null);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rolls/respond", hostRoll)).StatusCode);
        // A real unrelated world version invalidates the immutable continuation, even if the caller supplies the new version.
        guestView = (await h.Act(guestView, "observe")).Snapshot; Auth(h, owner.AccessToken); s = (await h.Get(s.Id))!;
        Check.True(!s.PendingRoll!.Available); Check.True(s.PendingRoll.Preview is null); Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rolls/respond", hostRoll with { ExpectedVersion = s.Version })).StatusCode);
        Check.Equal(0, dice.Count);
        var cancel = Respond(s, "cancel"); var cancelled = await Post(h, s.Id, "rolls/respond", cancel); Check.True(cancelled.Snapshot.PendingRoll is null);
        Check.Equal("cancelled", cancelled.Resolution.Status); Check.Equal(0, dice.Count); Check.True((await Post(h, s.Id, "rolls/respond", cancel)).Replayed);
        var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!;
        Check.Equal("cancelled", page.Entries.First(e => e.Kind == "roll.request").Status);
        s = cancelled.Snapshot;
        var immediate = await Post(h, s.Id, "actions/propose", new ActionRequest(Id(), s.Version, "observe")); Check.True(immediate.Snapshot.PendingRoll is null); Check.Equal(0, dice.Count);
        var forged = new StringContent(JsonSerializer.Serialize(new { requestId = Id(), expectedVersion = immediate.Snapshot.Version, rollId = hostRoll.RollId, decision = "roll", selected = 20 }), Encoding.UTF8, "application/json");
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsync($"/api/v1/campaigns/{s.Id}/rolls/respond", forged)).StatusCode);
    }

    public static async Task HostRequestedCheck()
    {
        var dice = new SequenceDice(18, 3); await using var h = await Host.Start(dice: dice); var owner = await h.Create(); var guest = await AddGuest(h, owner);
        Auth(h, guest.AccessToken); var s = (await h.Get(owner.Snapshot.Id))!;
        s = (await Post(h, s.Id, "actions/propose", new ActionRequest(Id(), s.Version, "natural", Text: "检查未知纹样"))).Snapshot;
        var ruling = s.PendingRulings.Single(); var request = new ResolveRulingRequest(Id(), s.Version, ruling.Id, "check", "检查未知纹样", "本场主持裁定", "intelligence", "Arcana", 12, "advantage");
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rulings/respond", request)).StatusCode);
        Auth(h, owner.AccessToken); var staged = await Post(h, s.Id, "rulings/respond", request);
        Check.Equal(0, dice.Count); Check.True(staged.Snapshot.PendingRoll is null); Check.Equal("awaiting_roll", staged.Snapshot.PendingRulings.Single().Status);
        Check.True((await Post(h, s.Id, "rulings/respond", request)).Replayed); Check.Equal(0, dice.Count);
        Auth(h, guest.AccessToken); s = (await h.Get(s.Id))!; var cancelled = await Post(h, s.Id, "rolls/respond", Respond(s, "cancel"));
        Check.Equal("pending", cancelled.Snapshot.PendingRulings.Single().Status); Check.Equal(0, dice.Count);
        Auth(h, owner.AccessToken); request = request with { RequestId = Id(), ExpectedVersion = cancelled.Snapshot.Version };
        staged = await Post(h, s.Id, "rulings/respond", request); Auth(h, guest.AccessToken); s = (await h.Get(s.Id))!;
        var preview = s.PendingRoll!.Preview!;
        Check.Equal("intelligence", preview.Ability); Check.Equal("Arcana", preview.Skill);
        Check.Equal("advantage", preview.Mode); Check.Equal(4, preview.Modifier); Check.True(preview.HasDc); Check.Equal(12, preview.Dc);
        Check.Equal(0, dice.Count);
        var confirm = Respond(s); var done = await Post(h, s.Id, "rolls/respond", confirm);
        Check.Equal(preview.Mode, done.Resolution.Check!.Mode); Check.Equal(preview.Modifier, done.Resolution.Check.Modifier);
        Check.Equal(2, dice.Count); Check.Equal(18, done.Resolution.Check!.Selected); Check.Equal(4, done.Resolution.Check.Modifier);
        var resolved = done.Snapshot.PendingRulings.Single(); Check.Equal("resolved", resolved.Status); Check.Equal(guest.Snapshot.Party!.SelfActorId, resolved.ActorId); Check.Equal("player", resolved.ResolvedBy);
        Check.True(done.Snapshot.PendingRoll is null); Check.Equal(0, done.Snapshot.Facts.Length); Check.True((await Post(h, s.Id, "rolls/respond", confirm)).Replayed); Check.Equal(2, dice.Count);
        var automatic = TestContent.Campaign("harbor", "Automatic save");
        automatic.Character = automatic.Character.Required() with { Conditions = ["Paralyzed"] };
        automatic.PendingRulings.Add(new("auto", "已记录的状态", "pending", "fixture", SceneId: "harbor"));
        var autoResult = new RulingEngine(new RulesEngine(dice)).Resolve(automatic,
            new(Id(), 1, "auto", "check", "状态导致自动失败", "现有规则", "strength", "", 12, CheckType: "save"), requestRoll: true);
        Check.Equal("automatic-failure", autoResult.Check!.Mode); Check.Equal(0, automatic.PendingRolls.Count); Check.Equal(2, dice.Count);

    }

    public static async Task PartyInitiativeAndCosts()
    {
        var dice = new SequenceDice(18, 16, 2); await using var h = await Host.Start(dice: dice); var owner = await h.Create(); var guest = await AddGuest(h, owner);
        var s = (await h.Get(owner.Snapshot.Id))!; s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
        s = (await Post(h, s.Id, "actions/propose", new ActionRequest(Id(), s.Version, "combat.start"))).Snapshot;
        Check.Equal(0, dice.Count); Check.True(s.Combat is null); Check.True(s.PendingRoll!.Preview is null); var hostConfirm = Respond(s);
        var waiting = await Post(h, s.Id, "rolls/respond", hostConfirm); Check.Equal(0, dice.Count); Check.True(waiting.Snapshot.Combat is null); Check.True(!waiting.Snapshot.PendingRoll!.Available);
        Auth(h, guest.AccessToken); var guestView = (await h.Get(s.Id))!; Check.True(guestView.PendingRoll!.Available); Check.True(guestView.PendingRoll.Id != s.PendingRoll!.Id);
        var guestConfirm = Respond(guestView); var done = await Post(h, s.Id, "rolls/respond", guestConfirm);
        Check.True(done.Snapshot.Combat is not null); Check.Equal(3, dice.Count); Check.True(done.Snapshot.PendingRoll is null);
        Check.True((await Post(h, s.Id, "rolls/respond", guestConfirm)).Replayed); Check.Equal(3, dice.Count);
        Auth(h, owner.AccessToken); s = (await h.Get(s.Id))!; Check.True(s.PendingRoll is null); Check.True((await Post(h, s.Id, "rolls/respond", hostConfirm)).Replayed); Check.Equal(3, dice.Count);
        // A separate single-seat rest proves no clock/resource/HP mutation occurs at proposal time.
        var restOwner = await h.Create("Rest"); s = restOwner.Snapshot;
        await h.App.Services.GetRequiredService<CampaignStore>().Access(s.Id, restOwner.AccessToken, true, c => { c.Character = c.Character.Required() with { HitPoints = 3 }; return Task.FromResult(true); });
        s = (await h.Get(s.Id))!; int before = dice.Count;
        s = (await h.Rest(s, "short")).Snapshot;
        var rest = await Post(h, s.Id, "actions/propose", new ActionRequest(Id(), s.Version, "rest.hit_die", ""));
        Check.Equal(before, dice.Count); Check.Equal(3, rest.Snapshot.Character.Required().HitPoints); Check.Equal(3600L, rest.Snapshot.ElapsedSeconds); Check.Equal(1, CharacterEngine.Value(rest.Snapshot.Character.Required(), CharacterEngine.HitDie(rest.Snapshot.Character.Required())));
        var recovered = await Post(h, s.Id, "rolls/respond", Respond(rest.Snapshot));
        Check.Equal(before + 1, dice.Count); Check.Equal(3600L, recovered.Snapshot.ElapsedSeconds); Check.Equal(0, CharacterEngine.Value(recovered.Snapshot.Character.Required(), CharacterEngine.HitDie(recovered.Snapshot.Character.Required())));
    }
}
