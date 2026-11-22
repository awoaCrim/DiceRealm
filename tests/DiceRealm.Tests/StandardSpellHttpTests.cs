using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Application;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class StandardSpellHttpTests
{
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static async Task<CampaignSnapshot> Confirm(Host h, CampaignSnapshot s) =>
        (await Post<ActionResponse>(h, s.Id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll"))).Snapshot;
    public static async Task AreaForeignWaitAndRestart()
    {
        var dice = new SequenceDice(20, 19, 1, 6, 1, 1); var h = await Host.Start(dice: dice);
        try
        {
            var build = StandardAreaTests.ThunderCaster().Build!;
            var doc = StandardAreaTests.WithEnemies(new ContentEnemy("guardian", "区域豁免夹具", 2, 2, 50, 12, 20, SavingThrows: StandardAreaTests.Saves(-5))) with { StartSceneId = "harbor" };
            var created = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("区域效果隔离", build.Identity.Name,
                Adventure: doc, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
            Check.Equal(HttpStatusCode.Created, created.StatusCode);
            var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!; string id = owner.Snapshot.Id;
            var guest = await HarnessBoundaryTests.Guest(h, owner); Auth(h, owner.AccessToken);
            var s = (await h.Get(id))!; s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
            s = (await h.Act(s, "combat.start")).Snapshot; s = await Confirm(h, s);
            Auth(h, guest.AccessToken); s = (await h.Get(id))!; s = await Confirm(h, s);
            Auth(h, owner.AccessToken); s = (await h.Get(id))!;
            var cast = s.AvailableActions.Single(a => a.Label.StartsWith("Thunderclap /", StringComparison.Ordinal));
            s = (await h.Act(s, cast.Kind, cast.Target)).Snapshot; Check.Equal(3, dice.Count); s = await Confirm(h, s);
            Check.Equal(4, dice.Count); Check.Equal("area-save", s.Combat!.Standard!.Wait!.Kind);
            Check.Equal(50, s.Combat.Units.Single(u => u.Id == "guardian").HitPoints);
            Check.Equal(HttpStatusCode.Conflict, (await h.Send(id, new ActionRequest(Id(), s.Version, "combat.area_save"))).StatusCode);
            Auth(h, guest.AccessToken); s = (await h.Get(id))!; int hp = s.Character.Required().HitPoints;
            s = (await h.Act(s, "combat.area_save")).Snapshot; Check.Equal(4, dice.Count);
            s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "cancel"))).Snapshot;
            Check.Equal("area-save", s.Combat!.Standard!.Wait!.Kind); Check.Equal(4, dice.Count);
            s = (await h.Act(s, "combat.area_save")).Snapshot;
            var roll = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, owner.AccessToken);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", roll)).StatusCode);
            Auth(h, guest.AccessToken); var resolved = await Post<ActionResponse>(h, id, "rolls/respond", roll); s = resolved.Snapshot;
            Check.Equal(6, dice.Count); Check.Equal(hp - 6, s.Character.Required().HitPoints); Check.Equal(44, s.Combat!.Units.Single(u => u.Id == "guardian").HitPoints);
            Check.True(s.Combat.Standard!.Wait is null); Check.Equal("player", s.Combat.ActiveActorId);
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, guest.AccessToken);
            var replay = await Post<ActionResponse>(h, id, "rolls/respond", roll); Check.True(replay.Replayed);
            Check.Equal(HarnessJson.Serialize(resolved.Resolution), HarnessJson.Serialize(replay.Resolution)); Check.Equal(6, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task SpellWaitsCancelConcurrencyRestart()
    {
        foreach (bool concentration in new[] { false, true })
        {
            var dice = new SequenceDice(concentration ? [20, 19, 1, 11, 2, 10] : [20, 19, 1, 11]);
            var h = await Host.Start(dice: dice);
            try
            {
                var build = StandardSpellTests.Wizard().Build!;
                var created = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("隔离法术恢复", build.Identity.Name,
                    Adventure: StandardCombatTests.Document() with { StartSceneId = "harbor" }, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
                Check.Equal(HttpStatusCode.Created, created.StatusCode);
                var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!; string id = owner.Snapshot.Id;
                var guest = await HarnessBoundaryTests.Guest(h, owner); Auth(h, owner.AccessToken);
                var s = (await h.Get(id))!; s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
                s = (await h.Act(s, "combat.start")).Snapshot; s = await Confirm(h, s);
                Auth(h, guest.AccessToken); s = (await h.Get(id))!; s = await Confirm(h, s); Check.Equal(3, dice.Count);
                Auth(h, owner.AccessToken); s = (await h.Get(id))!;
                if (concentration)
                {
                    var cast = s.AvailableActions.First(a => a.Kind == "combat.cast" && a.Label.StartsWith("Expeditious Retreat", StringComparison.Ordinal));
                    s = (await h.Act(s, cast.Kind, cast.Target)).Snapshot;
                    Check.True(s.PendingRoll is not null); Check.True(s.Character.Required().Concentration is null);
                    Check.Equal(2, CharacterEngine.Value(s.Character, "Spell Slots (1st)")); Check.Equal(3, dice.Count);
                    s = await Confirm(h, s); Check.True(s.Character.Required().Concentration is not null); Check.Equal(3, dice.Count);
                }
                int hp = s.Character.Required().HitPoints;
                s = (await h.Act(s, "combat.move", "0,2")).Snapshot;
                Check.Equal(concentration ? "concentration" : "shield", s.Combat!.Standard!.Wait!.Kind);
                int beforeDice = dice.Count; int beforeSlots = CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)");
                Check.Equal(concentration ? 5 : 4, beforeDice); Check.Equal(1, s.Combat.Units.Single(u => u.Id == "player").X);
                if (!concentration) Check.Equal(hp, s.Character.HitPoints);
                string frozen = HarnessJson.Serialize(s.Combat);
                var choice = s.AvailableActions.First(a => concentration ? a.Kind == "combat.concentration_save" : a.Kind == "combat.react" && a.Label.StartsWith("Shield", StringComparison.Ordinal));
                s = (await h.Act(s, choice.Kind, choice.Target)).Snapshot;
                Check.Equal(beforeDice, dice.Count); Check.Equal(beforeSlots, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
                s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "cancel"))).Snapshot;
                Check.Equal(frozen, HarnessJson.Serialize(s.Combat)); Check.Equal(beforeDice, dice.Count);
                s = (await h.Act(s, choice.Kind, choice.Target)).Snapshot;
                var confirmation = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
                Auth(h, guest.AccessToken);
                Check.True((await h.Get(id))!.PendingRoll is null);
                Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", confirmation)).StatusCode);
                string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, owner.AccessToken);
                s = (await h.Get(id))!; Check.Equal(frozen, HarnessJson.Serialize(s.Combat)); Check.Equal(beforeDice, dice.Count);
                var requests = new[] { confirmation, confirmation with { RequestId = Id() } };
                var raced = await Task.WhenAll(requests.Select(r => h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", r)));
                Check.Equal(1, raced.Count(r => r.IsSuccessStatusCode)); Check.Equal(1, raced.Count(r => r.StatusCode == HttpStatusCode.Conflict));
                int winner = Array.FindIndex(raced, r => r.IsSuccessStatusCode);
                var response = (await raced[winner].Content.ReadFromJsonAsync<ActionResponse>())!; s = response.Snapshot;
                Check.Equal(concentration ? beforeDice + 1 : beforeDice, dice.Count);
                Check.Equal(concentration ? beforeSlots : beforeSlots - 1, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
                Check.Equal(0, s.Combat!.Units.Single(u => u.Id == "player").X); Check.True(s.Combat.Standard!.Wait is null);
                if (concentration) Check.True(s.Character.Concentration is not null); else Check.Equal(hp, s.Character.HitPoints);
                await h.DisposeAsync(); h = await Host.Start(root, dice: dice); Auth(h, owner.AccessToken);
                var replay = await Post<ActionResponse>(h, id, "rolls/respond", requests[winner]); Check.True(replay.Replayed);
                Check.Equal(HarnessJson.Serialize(response.Resolution), HarnessJson.Serialize(replay.Resolution));
                Check.Equal(concentration ? 6 : 4, dice.Count);
            }
            finally { await h.DisposeAsync(); }
        }
    }
}
