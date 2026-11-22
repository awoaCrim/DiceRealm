using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class PartyRestTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static string State(Campaign c) => JsonSerializer.Serialize(c, JsonFiles.Options);
    private static Campaign Team()
    {
        var c = TestContent.Campaign("harbor");
        c.Character = PlayResources.Ensure(c.Character.Required()) with { HitPoints = 2 };
        c.PartyMembers.Add(new() { Id = "guest", TokenHash = "fixture", Character = PlayResources.Ensure(CharacterEngine.Create("Lyra", CharacterEngine.Wizard)) with { HitPoints = 1 } });
        return c;
    }
    public static Task TeamClockEligibilityAndRecovery()
    {
        var c = Team(); string before = State(c);
        var view = PartyRest.View(c); Check.Equal(before, State(c)); Check.Equal(2, view.Participants.Length);
        Check.True(view.Options.Single(o => o.Kind == "short").Available);
        PartyRest.Apply(c, "short"); Check.Equal(3600L, c.ElapsedSeconds);
        foreach (var (_, ch) in PartyEngine.Characters(c)) Check.True(ch.ShortRestDiceAvailable);
        Check.Equal(2, c.Character.Required().HitPoints); Check.Equal(1, c.PartyMembers[0].Character.Required().HitPoints);
        PartyRest.Apply(c, "long"); Check.Equal(32400L, c.ElapsedSeconds);
        foreach (var (_, ch) in PartyEngine.Characters(c))
        { Check.Equal(ch.MaxHitPoints, ch.HitPoints); Check.True(ch.PlayState!.PreparationOpen); Check.True(!ch.ShortRestDiceAvailable); Check.Equal(90000L, ch.NextLongRestAtSeconds); }
        before = State(c); Check.Throws<GameException>(() => PartyRest.Apply(c, "long")); Check.Equal(before, State(c));
        c.Character = c.Character with { HitPoints = 1 };
        PartyRest.Apply(c, "wait"); Check.Equal(90000L, c.ElapsedSeconds); Check.Equal(1, c.Character.HitPoints);
        Check.Throws<GameException>(() => PartyRest.Apply(c, "wait"));
        // Every rejection is checked before the shared clock or any character can change.
        Action<Campaign>[] blockers = [x => x.Archived = true, x => x.SceneId = "causeway", x => x.Character = x.Character.Required() with { HitPoints = 0 },
            x => x.PartyMembers[0].Character = x.PartyMembers[0].Character with { Exhaustion = 6 },
            x => x.PartyMembers[0].Character = x.PartyMembers[0].Character with { Conditions = ["Unconscious"] },
            x => x.PendingRolls.Add(new() { Id = Id(), ActorId = "guest", Label = "waiting", Description = "waiting" }),
            x => x.PendingIntents.Add(new() { Id = Id(), ActorId = "guest", Text = "waiting" }),
            x => { x.SceneId = "causeway"; new CombatEngine(new SequenceDice(20, 15, 1)).Resolve(x, "combat.start", ""); }];
        foreach (var block in blockers)
        {
            c = Team(); block(c); before = State(c);
            Check.True(!PartyRest.View(c).Options.Single(o => o.Kind == "short").Available);
            Check.Throws<GameException>(() => PartyRest.Apply(c, "short")); Check.Equal(before, State(c));
        }
        c = Team(); c.ActingActorId = "guest"; before = State(c);
        Check.Throws<GameException>(() => PartyRest.View(c)); Check.Throws<GameException>(() => PartyRest.Apply(c, "short")); Check.Equal(before, State(c));
        c = Team(); c.PartyMembers[0].Revoked = true;
        var excluded = c.PartyMembers[0].Character; PartyRest.Apply(c, "long");
        Check.Equal(excluded.HitPoints, c.PartyMembers[0].Character.HitPoints); Check.True(!c.PartyMembers[0].Character.PlayState!.PreparationOpen);
        // Nonlethal recovery retains the original rest-at-encounter exception and prone state.
        c = TestContent.Campaign("causeway"); var combat = new CombatEngine(new SequenceDice(1)); combat.Resolve(c, "combat.start", "");
        c.Combat!.Status = "defeat"; c.Combat.RecoveryRestRequired = true;
        PartyEngine.Unit(c)!.RecoveryRestRequired = true;
        c.Character = c.Character.Required() with { HitPoints = 1, Conditions = ["Unconscious", "Prone"] };
        PartyRest.Apply(c, "short"); Check.Equal(1, c.Character.HitPoints); Check.True(!PartyEngine.NeedsRecovery(c));
        Check.True(!c.Character.Conditions.Contains("Unconscious") && c.Character.Conditions.Contains("Prone"));
        Check.True(Adventure.Choices(c).Any(a => a.Kind == "rest.hit_die"));
        return Task.CompletedTask;
    }
    private static async Task<ActionResponse> Post<T>(Host h, string id, string endpoint, T request)
    {
        var reply = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{endpoint}", request);
        Check.True(reply.StatusCode == HttpStatusCode.OK, endpoint + ": " + await reply.Content.ReadAsStringAsync());
        return (await reply.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private static async Task<CreatedCampaign> Guest(Host h, CreatedCampaign owner)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await Post(h, owner.Snapshot.Id, "invitations", new InviteRequest(Id(), owner.Snapshot.Version, token));
        var joined = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/join",
            new JoinCampaignRequest(Id(), token, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), "Lyra", CharacterEngine.Fighter, Build: FullCreationTests.Named("Lyra", CharacterEngine.Wizard)));
        Check.Equal(HttpStatusCode.OK, joined.StatusCode);
        return await h.ApproveGuest(owner, (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!);
    }
    public static async Task HttpOwnChoicesAndRestart()
    {
        var dice = new SequenceDice(1, 1); var h = await Host.Start(dice: dice);
        try
        {
            var owner = await h.Create(); var guest = await Guest(h, owner); string id = owner.Snapshot.Id;
            Auth(h, owner.AccessToken); var store = h.App.Services.GetRequiredService<CampaignStore>();
            await store.Access(id, owner.AccessToken, true, c =>
            {
                foreach (var (actor, ch) in PartyEngine.Characters(c).ToArray())
                    PartyEngine.SetCharacter(c, actor, PlayResources.Ensure(ch) with { HitPoints = 1, Resources = ch.Resources.Select(r => r.Name == "Spell Slots (1st)" ? r with { Current = 0 } : r).ToArray() });
                return Task.FromResult(true);
            });
            var s = (await h.Get(id))!; string path = $"/api/v1/campaigns/{id}/party/rest";
            var initial = JsonSerializer.Serialize(s); var read = (await h.Http.GetFromJsonAsync<PartyRestView>(path))!;
            Check.Equal(s.Version, read.Version); Check.Equal(initial, JsonSerializer.Serialize((await h.Get(id))!));
            var request = new PartyRestRequest(Id(), s.Version, "short");
            Auth(h, guest.AccessToken);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync(path)).StatusCode);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path, request)).StatusCode);
            Auth(h, owner.AccessToken);
            var race = await Task.WhenAll(Post(h, id, "party/rest", request), Post(h, id, "party/rest", request));
            Check.True(race[0].Replayed != race[1].Replayed); s = race[0].Snapshot;
            Check.Equal(3600L, s.ElapsedSeconds); Check.Equal(0, dice.Count); Check.Equal(1, s.Character.Required().HitPoints);
            Check.True(s.Party!.Members.All(m => m.Character.ShortRestDiceAvailable));
            var propose = new ActionRequest(Id(), s.Version, "rest.hit_die");
            var waiting = await Post(h, id, "actions/propose", propose); s = waiting.Snapshot;
            Check.Equal(0, dice.Count); Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Hit Dice (d10)"));
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path, new PartyRestRequest(Id(), s.Version, "long"))).StatusCode);
            var confirm = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
            Auth(h, guest.AccessToken);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", confirm)).StatusCode);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, owner.AccessToken);
            Check.True((await Post(h, id, "actions/propose", propose)).Replayed);
            var attempts = await Task.WhenAll(h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", confirm),
                h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", confirm with { RequestId = Id() }));
            Check.Equal(1, attempts.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, attempts.Count(r => r.StatusCode == HttpStatusCode.Conflict));
            var done = (await attempts.Single(r => r.IsSuccessStatusCode).Content.ReadFromJsonAsync<ActionResponse>())!;
            s = done.Snapshot; Check.Equal(1, dice.Count); Check.Equal(3600L, s.ElapsedSeconds);
            // A teammate's independent choice remains available after another seat confirms dice.
            Auth(h, guest.AccessToken); s = (await h.Get(id))!; Check.True(s.Character.Required().ShortRestDiceAvailable);
            // The host's rest reaches every seat's story, with the time it took.
            var story = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            Check.True(story.Entries.Any(e => e.Kind == "party.rest.short" && e.InitialResult!.Summary.Contains("共经过 1 小时")), "party rest in the guest's activity");
            s = (await h.Act(s, "rest.arcane", "arcane")).Snapshot;
            Check.Equal(3600L, s.ElapsedSeconds); Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
            Check.Equal(0, CharacterEngine.Value(s.Character, "Arcane Recovery")); Check.Equal(1, dice.Count);
            waiting = await Post(h, id, "actions/propose", new ActionRequest(Id(), s.Version, "rest.hit_die"));
            s = (await Post(h, id, "rolls/respond", new RollResponseRequest(Id(), waiting.Snapshot.Version, waiting.Snapshot.PendingRoll!.Id, "cancel"))).Snapshot;
            Check.Equal(1, dice.Count); Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Hit Dice (d6)"));
            Auth(h, owner.AccessToken); s = (await h.Get(id))!;
            s = (await h.Rest(s, "long")).Snapshot; Check.Equal(32400L, s.ElapsedSeconds);
            Check.True(s.Party!.Members.All(m => m.Character.HitPoints == m.Character.MaxHitPoints && m.Character.PlayState!.PreparationOpen));
            // Completing one ordinary action closes only that seat, until a shared travel closes all.
            s = (await h.Act(s, "talk")).Snapshot;
            Check.True(s.Party!.Members.Single(m => m.Id != "player").Character.PlayState!.PreparationOpen);
            s = (await h.Act(s, "travel", "causeway")).Snapshot;
            Check.True(s.Party!.Members.All(m => !m.Character.ShortRestDiceAvailable && !m.Character.PlayState!.PreparationOpen));
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, owner.AccessToken);
            var replay = await Post(h, id, "party/rest", request); Check.True(replay.Replayed);
            Check.Equal(JsonSerializer.Serialize(race[0].Resolution), JsonSerializer.Serialize(replay.Resolution)); Check.Equal(1, dice.Count);
            Check.Equal(s.ElapsedSeconds, replay.Snapshot.ElapsedSeconds);
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task LegacyEntryAndReceipt()
    {
        var dice = new SequenceDice(); await using var h = await Host.Start(dice: dice);
        var owner = await h.Create(); var guest = await Guest(h, owner); string id = owner.Snapshot.Id;
        foreach (var token in new[] { owner.AccessToken, guest.AccessToken })
        {
            Auth(h, token); var s = (await h.Get(id))!;
            Check.True(!s.AvailableActions.Any(a => PartyRest.IsInitiation(a.Kind)) && !s.ActionOptions!.Any(a => PartyRest.IsInitiation(a.Kind)));
            foreach (string endpoint in new[] { "actions", "actions/propose" })
                foreach (string kind in new[] { "rest.short", "rest.long", "rest.wait" })
                {
                    var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{endpoint}", new ActionRequest(Id(), s.Version, kind));
                    Check.Equal(HttpStatusCode.Conflict, response.StatusCode); Check.True((await response.Content.ReadAsStringAsync()).Contains("rest_host_required"));
                }
            Check.Equal(s.Version, (await h.Get(id))!.Version);
        }
        Auth(h, owner.AccessToken); var state = (await h.Get(id))!;
        var malformed = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/party/rest", new { requestId = Id(), expectedVersion = state.Version, kind = "short", actorId = "guest" });
        Check.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/party/rest", new PartyRestRequest(Id(), state.Version, "bogus"))).StatusCode);
        // A pre-upgrade, unconfirmed short-rest roll remains cancellable, never executable.
        string rollId = Id();
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            c.PendingRolls.Add(new() { Id = rollId, ActorId = "player", Version = c.Version, Label = "旧短休", Description = "升级前请求",
                Action = new ActionRequest(Id(), c.Version, "rest.short", "hit_die"), Intent = new Intent("rest.short", "hit_die") });
            return Task.FromResult(true);
        });
        var old = (await h.Get(id))!; Check.True(!old.PendingRoll!.Available && old.PendingRoll.Reason.Contains("主持人"));
        var rejected = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", new RollResponseRequest(Id(), old.Version, rollId, "roll"));
        Check.Equal(HttpStatusCode.Conflict, rejected.StatusCode); Check.Equal(0, dice.Count); Check.Equal(old.Version, (await h.Get(id))!.Version);
        var cancelled = await Post(h, id, "rolls/respond", new RollResponseRequest(Id(), old.Version, rollId, "cancel"));
        Check.Equal("cancelled", cancelled.Resolution.Status); Check.Equal(0, dice.Count); Check.Equal(0L, cancelled.Snapshot.ElapsedSeconds);
        state = cancelled.Snapshot;
        // A historical successful rest receipt must remain a receipt; never execute it again.
        var legacy = new ActionRequest(Id(), state.Version, "rest.short", "hit_die");
        var resolution = new Resolution("resolved", "rest.short", "保存于升级前的原始休整结果", null, []);
        await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
        {
            c.Receipts.Add(new(legacy.RequestId, JsonFiles.Hash(JsonSerializer.Serialize(legacy, JsonFiles.Options)), resolution, "player"));
            return Task.FromResult(true);
        });
        var replay = await Post(h, id, "actions", legacy); Check.True(replay.Replayed); Check.Equal(resolution.Summary, replay.Resolution.Summary);
        Check.Equal(state.Version, replay.Snapshot.Version); Check.Equal(0L, replay.Snapshot.ElapsedSeconds); Check.Equal(0, dice.Count);
    }
}
