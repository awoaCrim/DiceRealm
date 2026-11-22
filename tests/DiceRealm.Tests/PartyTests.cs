using System.Net;
using Microsoft.Extensions.DependencyInjection;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class PartyTests
{
    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    private static async Task<(CreatedCampaign Guest, InviteRequest Invite, JoinCampaignRequest Join)> Add(Host h, CreatedCampaign owner, string template = CharacterEngine.Wizard)
    {
        Auth(h, owner.AccessToken); var s = (await h.Get(owner.Snapshot.Id))!;
        var invite = new InviteRequest(Guid.NewGuid().ToString(), s.Version, Secret());
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/invitations", invite);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var join = new JoinCampaignRequest(Guid.NewGuid().ToString(), invite.InviteToken, Secret(), "Lyra", CharacterEngine.Fighter, Build: FullCreationTests.Named("Lyra", template));
        h.Http.DefaultRequestHeaders.Authorization = null;
        response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", join);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var guest = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        guest = await h.ApproveGuest(owner, guest);
        Auth(h, guest.AccessToken);
        return (guest, invite, join);
    }
    public static async Task CapabilitiesAndReplay()
    {
        var h = await Host.Start();
        var owner = await h.Create(); var id = owner.Snapshot.Id;
        var (guest, invite, join) = await Add(h, owner);
        var s = guest.Snapshot;
        Check.Equal(2, s.Party!.Members.Length); Check.True(!s.Party.IsHost); Check.Equal("Wizard", s.Character.Required().ClassName);
        Check.True(s.Character.Required().Id != owner.Snapshot.Character.Required().Id); Check.Equal(0, s.Party.Invitations.Length);
        Check.True(s.AvailableActions.Any(a => a.Kind == "talk"));
        Check.True(s.AvailableActions.Any(a => a.Kind == "investigate"));
        var body = JsonSerializer.Serialize(s); Check.True(!body.Contains("TokenHash") && !body.Contains(invite.InviteToken) && !body.Contains(guest.AccessToken));
        var replay = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", join);
        Check.Equal(HttpStatusCode.OK, replay.StatusCode);
        Check.Equal(s.Version, (await replay.Content.ReadFromJsonAsync<CreatedCampaign>())!.Snapshot.Version);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", join with { AccessToken = Secret() })).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", new InviteRequest(Guid.NewGuid().ToString(), s.Version, Secret()))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/scene-asset", new ReviseSceneAssetRequest(s.SceneAsset.Id, "different", "coast", [], []))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/assets/{s.SceneAsset.Id}/retry", new RetrySceneAssetRequest(s.SceneAsset.FailureId))).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await h.Send(id, new(Guid.NewGuid().ToString(), s.Version, "travel", "unknown"))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rulings/resolve",
            new ResolveRulingRequest(Guid.NewGuid().ToString(), s.Version, "anything", "narrative", "reason", "DM"))).StatusCode);
        // Same request UUID in two independent seats never replays the other character's receipt.
        var requestId = Guid.NewGuid().ToString();
        var req = new ActionRequest(requestId, s.Version, "character.cast", "mage-armor:self");
        var cast = (await (await h.Send(id, req)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.Equal(14, cast.Snapshot.Character.Required().ArmorClass);
        Auth(h, owner.AccessToken); var hostView = (await h.Get(id))!;
        Check.Equal(16, hostView.Character.Required().ArmorClass); Check.Equal(12, hostView.Character.Required().HitPoints);
        var observe = await h.Send(id, new(requestId, hostView.Version, "observe")); Check.Equal(HttpStatusCode.OK, observe.StatusCode);
        Check.True(!(await observe.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        var root = h.Root; await h.DisposeAsync();
        await using var restarted = await Host.Start(root);
        Auth(restarted, guest.AccessToken);
        var after = (await (await restarted.Send(id, req)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(after.Replayed); Check.Equal(14, after.Snapshot.Character.Required().ArmorClass); Check.Equal(1, CharacterEngine.Value(after.Snapshot.Character.Required(), "Spell Slots (1st)"));
        var persisted = System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(root, "campaigns", id + ".sqlite")));
        foreach (var secret in new[] { owner.AccessToken, guest.AccessToken, invite.InviteToken }) Check.True(!persisted.Contains(secret));
        Auth(restarted, owner.AccessToken); s = (await restarted.Get(id))!;
        var revoke = new RevokeSeatRequest(Guid.NewGuid().ToString(), s.Version, guest.Snapshot.Party!.SelfActorId);
        Check.Equal(HttpStatusCode.OK, (await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/seats/revoke", revoke)).StatusCode);
        Auth(restarted, guest.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await restarted.Http.GetAsync($"/api/v1/campaigns/{id}")).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", join)).StatusCode);
    }
    public static async Task InviteRacesAndExpiry()
    {
        await using var h = await Host.Start(); var owner = await h.Create(); var id = owner.Snapshot.Id;
        var invite = new InviteRequest(Guid.NewGuid().ToString(), 1, Secret());
        var responses = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", invite)));
        foreach (var r in responses) Check.Equal(HttpStatusCode.OK, r.StatusCode);
        var joins = Enumerable.Range(0, 2).Select(i => new JoinCampaignRequest(Guid.NewGuid().ToString(), invite.InviteToken, Secret(), "Guest" + i, Build: FullCreationTests.Named("Guest" + i))).ToArray();
        var joined = await Task.WhenAll(joins.Select(j => h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", j)));
        Check.Equal(1, joined.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, joined.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        var s = (await h.Get(id))!; Check.Equal(3, s.Version); Check.Equal(2, s.Party!.Members.Length);
        var cancel = new InviteRequest(Guid.NewGuid().ToString(), s.Version, Secret());
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", cancel)).StatusCode);
        s = (await h.Get(id))!;
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations/revoke", new RevokeInviteRequest(Guid.NewGuid().ToString(), s.Version, cancel.RequestId))).StatusCode);
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", joins[0] with { InviteToken = cancel.InviteToken })).StatusCode);
        // Expiry is checked within the same campaign lock; changing persisted timestamp simulates time.
        s = (await h.Get(id))!; var expired = new InviteRequest(Guid.NewGuid().ToString(), s.Version, Secret());
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", expired)).StatusCode);
        await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
        {
            var item = c.Invitations.Single(i => i.Id == expired.RequestId); int index = c.Invitations.IndexOf(item);
            c.Invitations[index] = new PartyInvite { Id = item.Id, TokenHash = item.TokenHash, ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1) };
            return Task.FromResult(true);
        });
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", joins[0] with { InviteToken = expired.InviteToken })).StatusCode);
    }
    private sealed class CombatDice : IDice { public int Roll(int sides) => sides == 20 ? 10 : 2; }
    private static Campaign Party()
    {
        var c = TestContent.Campaign("causeway", "Party");
        c.Character = CharacterEngine.Create("Arden", CharacterEngine.Fighter);
        c.PartyMembers.Add(new() { Id = "wizard-seat", TokenHash = "test2", Character = CharacterEngine.Create("Lyra", CharacterEngine.Wizard) }); return c;
    }
    public static Task TurnsResourcesAndRecovery()
    {
        var c = Party(); var dice = new CombatDice(); var combat = new CombatEngine(dice); var chars = new CharacterEngine(dice);
        combat.Resolve(c, "combat.start", ""); Check.Equal(3, c.Combat!.Units.Length); Check.Equal("player", c.Combat.ActiveActorId);
        c.ActingActorId = "wizard-seat"; Check.Equal(0, CombatEngine.Choices(c).Length);
        Check.Throws<GameException>(() => combat.Resolve(c, "combat.end_turn", ""));
        c.ActingActorId = "player"; combat.Resolve(c, "combat.dodge", ""); combat.Resolve(c, "combat.end_turn", "");
        Check.Equal(0L, c.ElapsedSeconds); Check.Equal("wizard-seat", c.Combat.ActiveActorId);
        c.ActingActorId = "wizard-seat"; combat.Resolve(c, "combat.cast", "mage-armor:self");
        Check.Equal(14, c.ActingCharacter.ArmorClass); Check.Equal(16, c.Character.Required().ArmorClass); Check.Equal(1, CharacterEngine.Value(c.ActingCharacter, "Spell Slots (1st)"));
        combat.Resolve(c, "combat.end_turn", ""); Check.Equal(6L, c.ElapsedSeconds); Check.Equal("player", c.Combat.ActiveActorId);
        // One member retreats; another member is not moved, healed or forcibly withdrawn.
        c.ActingActorId = "player"; combat.Resolve(c, "combat.disengage", ""); combat.Resolve(c, "combat.move", "0,2"); combat.Resolve(c, "combat.retreat", "");
        Check.Equal("active", c.Combat.Status); Check.True(PartyEngine.Unit(c)!.Withdrawn); Check.Equal("wizard-seat", c.Combat.ActiveActorId);
        c.ActingActorId = "wizard-seat"; combat.Resolve(c, "combat.disengage", ""); combat.Resolve(c, "combat.move", "0,1"); combat.Resolve(c, "combat.retreat", ""); Check.Equal("retreated", c.Combat.Status);
        // Shared time expires the other player's buff, but another character's rest does not restore their slots.
        c.ActingActorId = "player"; c.SceneId = "harbor"; chars.Resolve(c, "rest.long", "");
        var guestAfterRest = PartyEngine.CharacterFor(c, "wizard-seat");
        Check.Equal(11, guestAfterRest.ArmorClass); Check.Equal(1, CharacterEngine.Value(guestAfterRest, "Spell Slots (1st)"));
        // Nearest player KO leaves the surviving guest with their own playable turn.
        c = Party(); c.Character = c.Character.Required() with { HitPoints = 1 };
        combat.Resolve(c, "combat.start", "");
        PartyEngine.Unit(c)!.ArmorClass = 1; PartyEngine.Unit(c)!.X = 4;
        combat.Resolve(c, "combat.end_turn", ""); c.ActingActorId = "wizard-seat";
        combat.Resolve(c, "combat.end_turn", "");
        Check.Equal("active", c.Combat!.Status); Check.Equal("wizard-seat", c.Combat.ActiveActorId); Check.True(c.Character.Conditions.Contains("Unconscious"));
        Check.Equal(9, c.ActingCharacter.HitPoints); Check.True(CharacterEngine.Choices(c).Length == 0);
        combat.Resolve(c, "combat.move", "0,1"); combat.Resolve(c, "combat.retreat", ""); Check.Equal("defeated", c.Combat.Status);
        c.ActingActorId = "player"; chars.Resolve(c, "rest.short", "hit_die"); Check.True(!c.Character.Conditions.Contains("Unconscious"));
        Check.True(c.Character.Conditions.Contains("Prone")); chars.Resolve(c, "rest.recover", "");
        Check.True(c.Character.Conditions.Length == 0); Check.True(CharacterEngine.Weapon(c.Character)!.Id == "greatsword");
        Check.Equal(9, PartyEngine.CharacterFor(c, "wizard-seat").HitPoints);
        return Task.CompletedTask;
    }
    public static async Task CooperativeHttp()
    {
        var h = await Host.Start(dice: new CombatDice()); var owner = await h.Create(); var (guest, _, _) = await Add(h, owner);
        var id = owner.Snapshot.Id; Auth(h, owner.AccessToken); var s = (await h.Get(id))!;
        s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot; s = (await h.Act(s, "combat.start")).Snapshot;
        Auth(h, guest.AccessToken); var g = (await h.Get(id))!;
        Check.Equal(0, g.AvailableActions.Length); Check.Equal(HttpStatusCode.Conflict, (await h.Send(id, new(Guid.NewGuid().ToString(), g.Version, "combat.cast", "magic-missile:guardian"))).StatusCode);
        Auth(h, owner.AccessToken); s = (await h.Act(s, "combat.dodge")).Snapshot; s = (await h.Act(s, "combat.end_turn")).Snapshot;
        Auth(h, guest.AccessToken); g = (await h.Get(id))!;
        var req = new ActionRequest(Guid.NewGuid().ToString(), g.Version, "combat.cast", "magic-missile:guardian");
        var replies = await Task.WhenAll(h.Send(id, req), h.Send(id, req)); foreach (var r in replies) Check.Equal(HttpStatusCode.OK, r.StatusCode);
        g = (await h.Get(id))!; Check.Equal(1, CharacterEngine.Value(g.Character.Required(), "Spell Slots (1st)")); Check.Equal(9, g.Combat!.Units.Single(u => u.Id == "guardian").HitPoints);
        Auth(h, owner.AccessToken); Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/seats/revoke", new RevokeSeatRequest(Guid.NewGuid().ToString(), g.Version, guest.Snapshot.Party!.SelfActorId))).StatusCode);
        var root = h.Root; await h.DisposeAsync(); await using var restart = await Host.Start(root, new CombatDice());
        Auth(restart, guest.AccessToken); var replay = (await (await restart.Send(id, req)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(9, replay.Snapshot.Combat!.Units.Single(u => u.Id == "guardian").HitPoints);
        Check.Equal(guest.Snapshot.Party!.SelfActorId, replay.Snapshot.Events.Last().ActorId);
        Auth(restart, owner.AccessToken); var host = (await restart.Get(id))!; Check.Equal("Fighter", host.Character.Required().ClassName); Check.Equal(12, host.Character.Required().HitPoints);
    }
}
