using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementRestChoiceHttpTests
{
    public static async Task OwnWindowRaceAndRestart()
    {
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice);
        var build = AdvancementRestChoiceTests.HighElfBuild();
        var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Rest choice persistence", build.Identity.Name,
            Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
        Check.Equal(HttpStatusCode.Created, create.StatusCode);
        var owner = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        string path = "/api/v1/campaigns/" + owner.Snapshot.Id;
        async Task<ActionResponse> Post<T>(Host h, string route, T body)
        {
            var reply = await h.Http.PostAsJsonAsync(path + route, body); Check.Equal(HttpStatusCode.OK, reply.StatusCode);
            return (await reply.Content.ReadFromJsonAsync<ActionResponse>())!;
        }
        var s = owner.Snapshot;
        var request = new CharacterPlayRequest(Guid.NewGuid().ToString(), s.Version, "rest-choice", AdvancementRestChoices.HighElf, Choices: ["acid-splash"]);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", request)).StatusCode);
        Check.Equal(s.Version, (await host.Get(s.Id))!.Version);
        s = (await Post(host, "/invitations", new InviteRequest(Guid.NewGuid().ToString(), s.Version, new string('a', 64)))).Snapshot;
        var guestBuild = FullCreationTests.Complete("fighter", "dwarf", "soldier") with { Identity = new() { Name = "Rest guest" } };
        var join = await host.Http.PostAsJsonAsync(path + "/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), new string('a', 64), new string('b', 64), guestBuild.Identity.Name, Build: guestBuild));
        Check.Equal(HttpStatusCode.OK, join.StatusCode);
        var guest = (await join.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        s = (await host.Get(s.Id))!;
        string guestId = guest.Snapshot.Party!.SelfActorId;
        var member = s.Party!.Members.Single(m => m.Id == guestId);
        s = (await Post(host, "/characters/review", new ReviewCharacterRequest(Guid.NewGuid().ToString(), s.Version, guestId, member.Review!.Revision, "approve", "隔离验证"))).Snapshot;
        s = (await host.Rest(s, "long")).Snapshot;
        int restedVersion = s.Version; string originalBuild = JsonSerializer.Serialize(s.Character.Required().Build);
        var sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
        Check.True(sheet.RestChoices!.Single().Available); Check.Equal(restedVersion, (await host.Get(s.Id))!.Version);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(path + "/character/commands", request with { ExpectedVersion = s.Version })).StatusCode);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Check.Equal(restedVersion, (await host.Get(s.Id))!.Version); Check.Equal(0, dice.Count);
        string root = host.Root; await host.DisposeAsync();
        host = await Host.Start(root, dice: dice); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var left = request with { ExpectedVersion = restedVersion };
        var right = left with { RequestId = Guid.NewGuid().ToString() };
        var attempts = await Task.WhenAll(host.Http.PostAsJsonAsync(path + "/character/commands", left), host.Http.PostAsJsonAsync(path + "/character/commands", right));
        Check.Equal(1, attempts.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, attempts.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        int winner = attempts[0].StatusCode == HttpStatusCode.OK ? 0 : 1;
        var applied = (await attempts[winner].Content.ReadFromJsonAsync<ActionResponse>())!;
        var originalRequest = winner == 0 ? left : right;
        s = applied.Snapshot;
        Check.Equal(restedVersion + 1, s.Version); Check.Equal(originalBuild, JsonSerializer.Serialize(s.Character.Required().Build)); Check.Equal(0, dice.Count);
        Check.True(s.Character.BuildMechanics!.SpellGrants.Any(g => g.Source == "species:elf/lineage:high-elf" && g.Id == "acid-splash"));
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", originalRequest with { Choices = ["blade-ward"] })).StatusCode);
        await host.DisposeAsync();
        await using var reopened = await Host.Start(root, dice: dice); reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var replay = await Post(reopened, "/character/commands", originalRequest);
        Check.True(replay.Replayed); Check.Equal(s.Version, replay.Snapshot.Version);
        Check.Equal(JsonSerializer.Serialize(applied.Resolution), JsonSerializer.Serialize(replay.Resolution));
        Check.Equal(JsonSerializer.Serialize(s.Character), JsonSerializer.Serialize(replay.Snapshot.Character)); Check.Equal(0, dice.Count);
        var final = (await reopened.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
        Check.True(!final.RestChoices!.Single().Available && final.Preparation.Available);
        Check.Equal(HttpStatusCode.Conflict, (await reopened.Http.PostAsJsonAsync(path + "/character/commands", originalRequest with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = s.Version })).StatusCode);
    }
}
