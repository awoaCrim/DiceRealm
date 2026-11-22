using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Application;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class StandardMissileHttpTests
{
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static async Task<CampaignSnapshot> Confirm(Host h, CampaignSnapshot s) =>
        (await Post<ActionResponse>(h, s.Id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
    public static async Task AllocationsAndForeignShieldRestartExactlyOnce()
    {
        var dice = new SequenceDice(20, 19, 1, 3); var h = await Host.Start(dice: dice);
        try
        {
            var build = StandardSpellTests.Wizard(false).Build!;
            var created = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("飞弹隔离验收", build.Identity.Name,
                Adventure: StandardCombatTests.Document() with { StartSceneId = "harbor" }, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
            Check.Equal(HttpStatusCode.Created, created.StatusCode); var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            string id = owner.Snapshot.Id; Auth(h, owner.AccessToken); var s = (await h.Get(id))!;
            var invite = new InviteRequest(Id(), s.Version, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)));
            await Post<ActionResponse>(h, id, "invitations", invite);
            var guestBuild = StandardSpellTests.Wizard().Build!;
            var guest = await Post<CreatedCampaign>(h, id, "join", new JoinCampaignRequest(Id(), invite.InviteToken, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), guestBuild.Identity.Name, Build: guestBuild));
            guest = await h.ApproveGuest(owner, guest); string guestId = guest.Snapshot.Party!.SelfActorId;
            Auth(h, owner.AccessToken); s = (await h.Get(id))!; s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
            s = (await h.Act(s, "combat.start")).Snapshot; s = await Confirm(h, s);
            Auth(h, guest.AccessToken); s = (await h.Get(id))!; s = await Confirm(h, s); Check.Equal(3, dice.Count);
            Auth(h, owner.AccessToken); s = (await h.Get(id))!; var spell = s.AvailableActions.First(a => a.Label.StartsWith("Magic Missile /", StringComparison.Ordinal));
            s = (await h.Act(s, spell.Kind, spell.Target)).Snapshot;
            Check.True(s.PendingRoll is null); Check.Equal("missile-allocation", s.Combat!.Standard!.Wait!.Kind);
            Check.Equal(2, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)")); Check.Equal(3, dice.Count);
            s = (await h.Act(s, "combat.missile_allocate", "one/guardian")).Snapshot;
            s = (await h.Act(s, "combat.missile_allocate", "all/" + guestId)).Snapshot;
            Auth(h, guest.AccessToken); s = (await h.Get(id))!;
            Check.Equal(HttpStatusCode.Conflict, (await h.Send(id, new ActionRequest(Id(), s.Version, "combat.missile_cast"))).StatusCode);
            Auth(h, owner.AccessToken); s = (await h.Get(id))!; s = (await h.Act(s, "combat.missile_cast")).Snapshot;
            Check.True(s.PendingRoll is not null); Check.Equal(3, dice.Count); Check.Equal(2, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
            s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "cancel"))).Snapshot;
            Check.Equal("missile-allocation", s.Combat!.Standard!.Wait!.Kind); s = (await h.Act(s, "combat.missile_cast")).Snapshot;
            var cast = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"); string root = h.Root;
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, owner.AccessToken);
            var release = await Post<ActionResponse>(h, id, "rolls/respond", cast); s = release.Snapshot;
            Check.Equal(3, dice.Count); Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
            Check.Equal("shield", s.Combat!.Standard!.Wait!.Kind); Check.Equal(guestId, s.Combat.Standard.Wait.ActorId);
            Check.Equal(50, s.Combat.Units.Single(u => u.Id == "guardian").HitPoints);
            Auth(h, guest.AccessToken); s = (await h.Get(id))!; int hp = s.Character.Required().HitPoints;
            spell = s.AvailableActions.First(a => a.Kind == "combat.react" && a.Label.StartsWith("Shield /", StringComparison.Ordinal));
            s = (await h.Act(s, spell.Kind, spell.Target)).Snapshot; var shield = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
            Check.Equal(3, dice.Count); Check.Equal(2, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, owner.AccessToken);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", shield)).StatusCode);
            Auth(h, guest.AccessToken);
            var requests = new[] { shield, shield with { RequestId = Id() } };
            var raced = await Task.WhenAll(requests.Select(r => h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", r)));
            Check.Equal(1, raced.Count(r => r.IsSuccessStatusCode)); Check.Equal(1, raced.Count(r => r.StatusCode == HttpStatusCode.Conflict));
            int winner = Array.FindIndex(raced, r => r.IsSuccessStatusCode); var response = (await raced[winner].Content.ReadFromJsonAsync<ActionResponse>())!; s = response.Snapshot;
            Check.Equal(4, dice.Count); Check.Equal(hp, s.Character.Required().HitPoints); Check.Equal(46, s.Combat!.Units.Single(u => u.Id == "guardian").HitPoints);
            Check.Equal(2, s.Combat.Log.Count(e => e.Kind == "missile_blocked")); Check.Equal(1, s.Combat.Log.Count(e => e.Kind == "missile_damage"));
            Check.Equal(1, CharacterEngine.Value(s.Character, "Spell Slots (1st)")); Check.True(s.Combat.Standard!.Wait is null);
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, guest.AccessToken);
            var replay = await Post<ActionResponse>(h, id, "rolls/respond", requests[winner]); Check.True(replay.Replayed);
            Check.Equal(HarnessJson.Serialize(response.Resolution), HarnessJson.Serialize(replay.Resolution));
            Auth(h, owner.AccessToken); Check.True((await Post<ActionResponse>(h, id, "rolls/respond", cast)).Replayed); Check.Equal(4, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }
}
