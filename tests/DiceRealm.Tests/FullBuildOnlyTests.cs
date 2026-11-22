using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class FullBuildOnlyTests
{
    public static async Task AllCreationRoutesRequireBuild()
    {
        var model = new HarnessTests.Model((_, _) => throw new Exception("Creation may not call a model"));
        await using var h = await Host.Start(configure: HarnessTests.Configure(model));
        var build = FullCreationTests.Named("Ada");
        object Harness(CharacterBuild? b, CharacterCreationChoices? old) => new CreateHarnessCampaignRequest("New", "Ada", TestContent.Document, HarnessTests.Preset, Creation: old, Build: b);
        object Business(CharacterBuild? b, CharacterCreationChoices? old) => new CreateCampaignFromContentRequest("New", "Ada", TestContent.Document, "User-authored prompt", [], Creation: old, Build: b);
        foreach (var (route, make) in new (string, Func<CharacterBuild?, CharacterCreationChoices?, object>)[]
            { ("/api/v1/harness/campaigns", Harness), ("/api/v1/campaigns/from-content", Business) })
        {
            foreach (var body in new[] { make(null, null), make(null, CharacterCreation.Catalog().Templates[0].Defaults), make(new(), null), make(build, CharacterCreation.Catalog().Templates[0].Defaults) })
            {
                var before = Directory.GetFiles(h.Root, "*", SearchOption.AllDirectories).Order().ToArray();
                Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync(route, body)).StatusCode);
                Check.True(before.SequenceEqual(Directory.GetFiles(h.Root, "*", SearchOption.AllDirectories).Order()));
            }
            var response = await h.Http.PostAsJsonAsync(route, make(build, null));
            Check.Equal(HttpStatusCode.Created, response.StatusCode);
            Check.True((await response.Content.ReadFromJsonAsync<CreatedCampaign>())!.Snapshot.Character.Required().Build is not null);
        }
        Check.Equal(0, model.Calls);
    }

    private static string Id() => Guid.NewGuid().ToString();
    private static Task<string> State(Host h, string id, string token) =>
        h.App.Services.GetRequiredService<CampaignStore>().Access(id, token, false, c => Task.FromResult(JsonSerializer.Serialize(c, JsonFiles.Options)));
    public static async Task JoinAndReplacementAreAtomic()
    {
        await using var h = await Host.Start(); var owner = await h.Create(); string id = owner.Snapshot.Id;
        var invite = new InviteRequest(Id(), owner.Snapshot.Version, new string('a', 64));
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/invitations", invite)).StatusCode);
        var build = FullCreationTests.Named("Guest");
        var request = new JoinCampaignRequest(Id(), invite.InviteToken, new string('b', 64), "Guest");
        string before = await State(h, id, owner.AccessToken);
        foreach (var rejected in new[] { request, request with { TemplateId = CharacterEngine.Wizard }, request with { Creation = CharacterCreation.Catalog().Templates[0].Defaults },
            request with { Build = new() }, request with { Build = build, Creation = CharacterCreation.Catalog().Templates[0].Defaults }, request with { Build = build, TemplateId = CharacterEngine.Wizard } })
        {
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", rejected)).StatusCode);
            Check.Equal(before, await State(h, id, owner.AccessToken));
        }
        request = request with { Build = build };
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", request);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var guest = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        string actor = guest.Snapshot.Party!.SelfActorId;
        Check.Equal("pending", guest.Snapshot.Party.Members.Single(m => m.Id == actor).Review!.Status);
        before = await State(h, id, owner.AccessToken);
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", request)).StatusCode);
        Check.Equal(before, await State(h, id, owner.AccessToken));
        var returned = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/characters/review", new ReviewCharacterRequest(Id(), guest.Snapshot.Version, actor, 1, "return", "Please revise"));
        Check.Equal(HttpStatusCode.OK, returned.StatusCode);
        var snapshot = (await returned.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var resubmit = new ResubmitCharacterRequest(Id(), snapshot.Version, 1, "Revised", "Guest", CharacterEngine.Wizard);
        before = await State(h, id, owner.AccessToken);
        foreach (var rejected in new[] { resubmit, resubmit with { TemplateId = "", Creation = CharacterCreation.Catalog().Templates[0].Defaults },
            resubmit with { TemplateId = "", Build = new() }, resubmit with { Build = build } })
        {
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/character/resubmit", rejected)).StatusCode);
            Check.Equal(before, await State(h, id, owner.AccessToken));
        }
        resubmit = resubmit with { TemplateId = "", Build = build };
        response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/character/resubmit", resubmit);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var replaced = (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.Equal(guest.Snapshot.Character.Required().Id, replaced.Snapshot.Character.Required().Id);
        Check.True(replaced.Snapshot.Character.Build is not null);
        Check.True((await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/character/resubmit", resubmit)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
    }

    public static async Task PreviouslyAcceptedLegacyRequestsStillReplay()
    {
        var h = await Host.Start(); var store = h.App.Services.GetRequiredService<CampaignStore>();
        string hostToken = new('a', 64);
        var join = new JoinCampaignRequest(Id(), new string('b', 64), new string('c', 64), "Old wizard", CharacterEngine.Wizard);
        string actor = Id(); var campaign = TestContent.Campaign(tokenHash: hostToken);
        // Previously accepted requests had already produced a snapshot, including the
        // established additive resource projection. Preserve its spent state and legacy build.
        campaign.Character = PlayResources.Ensure(campaign.Character.Required());
        var character = PlayResources.Ensure(CharacterEngine.Create("Old wizard", CharacterEngine.Wizard) with { HitPoints = 3 });
        campaign.PartyMembers.Add(new() { Id = actor, TokenHash = JsonFiles.Hash(join.AccessToken), Character = character, Review = new(2, "returned") });
        campaign.Invitations.Add(new() { Id = Id(), TokenHash = JsonFiles.Hash(join.InviteToken), UsedByActorId = actor,
            ExpiresAt = DateTimeOffset.UtcNow.AddDays(-1), JoinFingerprint = JsonFiles.Hash(JsonSerializer.Serialize(join, JsonFiles.Options)) });
        var oldResubmit = new ResubmitCharacterRequest(Id(), 1, 1, "Accepted before upgrade", "Old wizard", CharacterEngine.Wizard);
        campaign.Receipts.Add(new(oldResubmit.RequestId, JsonFiles.Hash("character.resubmit:" + JsonSerializer.Serialize(oldResubmit, JsonFiles.Options)),
            new("resolved", "character.resubmit", "Previously accepted", null, []), actor));
        campaign.Events.Add(new(Id(), 1, "fixture.legacy", "Existing accepted state", "", "fixture", DateTimeOffset.UtcNow, null));
        store.Create(campaign); string root = h.Root, id = campaign.Id;
        await h.DisposeAsync(); await using var restarted = await Host.Start(root);
        string before = await State(restarted, id, hostToken);
        var response = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", join);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var joined = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        Check.Equal(3, joined.Snapshot.Character.Required().HitPoints); Check.True(joined.Snapshot.Character.Required().Build is null);
        Check.Equal(HttpStatusCode.Conflict, (await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", join with { CharacterName = "Other" })).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/join", join with { AccessToken = new string('d', 64) })).StatusCode);
        restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", join.AccessToken);
        response = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/character/resubmit", oldResubmit);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        Check.True((await response.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        Check.Equal(before, await State(restarted, id, hostToken));
        // Supplemental explanation alone preserves the existing character and its damage.
        response = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/character/resubmit", new ResubmitCharacterRequest(Id(), campaign.Version, 2, "Only explanation"));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var supplemented = (await response.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        Check.Equal(3, supplemented.Character.Required().HitPoints); Check.True(supplemented.Character.Required().Build is null); Check.Equal(character.Id, supplemented.Character.Required().Id);
    }

    public static async Task CreationRequiresCompleteBuild()
    {
        await using var host = await Host.Start();
        var draft = new CreateCampaignRequest("Full build only", "Ada");
        var valid = FullCreationTests.Complete() with { Identity = new() { Name = "Ada" } };
        var cases = new[]
        {
            draft,
            draft with { TemplateId = CharacterEngine.Wizard },
            draft with { Creation = CharacterCreation.Catalog().Templates[0].Defaults },
            draft with { Build = new() { Identity = new() { Name = "Ada" } } },
            draft with { Build = valid, Creation = CharacterCreation.Catalog().Templates[0].Defaults },
            draft with { Build = valid, TemplateId = CharacterEngine.Wizard },
            draft with { Build = valid, CharacterName = "Someone else" }
        };
        foreach (var request in cases)
        {
            var before = Directory.GetFiles(host.Root, "*", SearchOption.AllDirectories).Order().ToArray();
            var response = await host.Http.PostAsJsonAsync("/api/v1/campaigns", request);
            Check.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Check.True(before.SequenceEqual(Directory.GetFiles(host.Root, "*", SearchOption.AllDirectories).Order()), "Rejected creation wrote files");
        }
        var accepted = await host.Http.PostAsJsonAsync("/api/v1/campaigns", draft with { Build = valid });
        Check.Equal(HttpStatusCode.Created, accepted.StatusCode);
        var result = (await accepted.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        Check.True(result.Snapshot.Character.Required().Build is not null);
        Check.Equal("host_creation", result.Snapshot.Party!.Members[0].Review!.Source);
        Check.Equal(HttpStatusCode.Gone, (await host.Http.GetAsync("/api/v1/character-creation")).StatusCode);
        Check.Equal(HttpStatusCode.Gone, (await host.Http.PostAsJsonAsync("/api/v1/character-creation/preview", new { })).StatusCode);
    }
}
