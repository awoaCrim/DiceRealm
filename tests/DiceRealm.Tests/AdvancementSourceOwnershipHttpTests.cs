using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementSourceOwnershipHttpTests
{
    public static async Task SourceRevocationPersistsAndReplays()
    {
        var dice = new SequenceDice();
        var host = await Host.Start(dice: dice);
        try
        {
            var build = FullCreationTests.Complete("warlock", "dwarf", "sage") with { Cantrips = ["eldritch-blast", "poison-spray"] };
            var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Invocation handoff", build.Identity.Name,
                Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
            Check.Equal(HttpStatusCode.Created, create.StatusCode);
            var owner = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string path = "/api/v1/campaigns/" + owner.Snapshot.Id;
            var award = await host.Http.PostAsJsonAsync(path + "/characters/advancement/award", new AwardAdvancementRequest(Guid.NewGuid().ToString(),
                owner.Snapshot.Version, PartyEngine.HostId, "milestone", 3, "隔离来源交接验证"));
            Check.Equal(HttpStatusCode.OK, award.StatusCode);
            var snapshot = (await award.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
            var draft = AdvancementTests.Complete(snapshot.Character.Required(), pick: g => g.Key == "optional:EI"
                ? ["pact-of-the-chain", "agonizing-blast/eldritch-blast", "agonizing-blast/poison-spray"] : null);
            string before = JsonSerializer.Serialize(snapshot.Character);
            var preview = await host.Http.PostAsJsonAsync(path + "/character/advancement/preview", new PreviewAdvancementRequest(snapshot.Version, draft));
            Check.Equal(HttpStatusCode.OK, preview.StatusCode);
            Check.True((await preview.Content.ReadFromJsonAsync<AdvancementView>())!.Preview!.CanApply);
            Check.Equal(before, JsonSerializer.Serialize((await host.Get(snapshot.Id))!.Character));
            Check.Equal(0, dice.Count);
            var apply = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), snapshot.Version, draft);
            var root = host.Root; await host.DisposeAsync();
            host = await Host.Start(root, dice: dice); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var requests = new[] { apply, apply with { RequestId = Guid.NewGuid().ToString() } };
            var responses = await Task.WhenAll(requests.Select(request => host.Http.PostAsJsonAsync(path + "/character/advancement/apply", request)));
            Check.Equal(1, responses.Count(r => r.StatusCode == HttpStatusCode.OK));
            Check.Equal(1, responses.Count(r => r.StatusCode == HttpStatusCode.Conflict));
            // The fixed-ID request is sent first, but either racer can win. Save the receipt
            // that actually succeeded, rather than making scheduler order an invariant.
            var winnerIndex = Array.FindIndex(responses, r => r.StatusCode == HttpStatusCode.OK);
            var changed = (await responses[winnerIndex].Content.ReadFromJsonAsync<ActionResponse>())!;
            Check.Equal(2, changed.Snapshot.Character.Required().Level);
            Check.True(!changed.Snapshot.Character.Features.Contains("armor-of-shadows"));
            Check.Equal(2, changed.Snapshot.Character.Advancement!.Classes.Single().OptionalFeatures.Count(s => s.StartsWith("agonizing-blast/", StringComparison.Ordinal)));
            Check.True(!changed.Snapshot.Character.BuildMechanics!.SpellGrants.Any(g => g.Source == "class:warlock/invocation"));
            var sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            Check.True(!sheet.Spells.Any(s => s.Source is "class:warlock/invocation" or "optional:armor-of-shadows"));
            Check.True(sheet.Spells.Any(s => s.Source == "optional:pact-of-the-chain" && s.Id.EndsWith("/at-will", StringComparison.Ordinal)));
            // A later level must not resurrect the revoked immutable-build source.
            var next = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), changed.Snapshot.Version,
                AdvancementTests.Complete(changed.Snapshot.Character, subclass: "warlock:fiend"));
            var nextReply = await host.Http.PostAsJsonAsync(path + "/character/advancement/apply", next);
            Check.Equal(HttpStatusCode.OK, nextReply.StatusCode);
            var final = (await nextReply.Content.ReadFromJsonAsync<ActionResponse>())!;
            await host.DisposeAsync(); host = await Host.Start(root, dice: dice);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await host.Http.PostAsJsonAsync(path + "/character/advancement/apply", requests[winnerIndex]);
            Check.Equal(HttpStatusCode.OK, replay.StatusCode);
            var receipt = (await replay.Content.ReadFromJsonAsync<ActionResponse>())!;
            Check.True(receipt.Replayed); Check.Equal(final.Snapshot.Version, receipt.Snapshot.Version);
            Check.Equal(JsonSerializer.Serialize(final.Snapshot.Character), JsonSerializer.Serialize(receipt.Snapshot.Character));
            Check.Equal(JsonSerializer.Serialize(changed.Resolution), JsonSerializer.Serialize(receipt.Resolution));
            Check.Equal(JsonSerializer.Serialize(build), JsonSerializer.Serialize(receipt.Snapshot.Character.Required().Build));
            Check.Equal(2, receipt.Snapshot.Character.Advancement!.Classes.Single().OptionalFeatures.Count(s => s.StartsWith("agonizing-blast/", StringComparison.Ordinal)));
            Check.Equal(0, dice.Count);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/advancement/apply",
                requests[winnerIndex] with { Draft = draft with { SubclassId = "warlock:archfey" } })).StatusCode);
        }
        finally { await host.DisposeAsync(); }
    }
}
