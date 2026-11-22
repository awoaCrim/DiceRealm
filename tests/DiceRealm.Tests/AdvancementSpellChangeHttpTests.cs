using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementSpellChangeHttpTests
{
    public static async Task ReplacementReceiptPersistsAndReplays()
    {
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice);
        var build = FullCreationTests.Complete("wizard", "elf", "sage") with { BaseScores = [13, 12, 14, 15, 10, 8], BackgroundBonuses = [0, 0, 0, 2, 1, 0] };
        var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Spell growth persistence", build.Identity.Name,
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
        var s = (await Post(host, "/characters/advancement/award", new AwardAdvancementRequest(Guid.NewGuid().ToString(), owner.Snapshot.Version, PartyEngine.HostId, "milestone", 3, "隔离测试已确认成长"))).Snapshot;
        var old = s.Character.Required().BuildMechanics!.SpellGrants.Single(g => g.Source.Contains("/feat:magic-initiate/", StringComparison.Ordinal) && g.FreeUses > 0);
        s = (await Post(host, "/characters/adjust", new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, PartyEngine.HostId, "已用免费施法", "隔离测试", [new CharacterAdjustment("resource", PlayResources.FreeSpell(old), 0)]))).Snapshot;
        string key = "spell-change:" + old.Source;
        var draft = AdvancementSpellChangeTests.Set(AdvancementSpellChangeTests.Set(AdvancementTests.Complete(s.Character.Required(), "fighter"), key, old.Id), key + ":replacement", "shield");
        string before = JsonSerializer.Serialize(s.Character);
        var preview = await host.Http.PostAsJsonAsync(path + "/character/advancement/preview", new PreviewAdvancementRequest(s.Version, draft));
        Check.Equal(HttpStatusCode.OK, preview.StatusCode); Check.True((await preview.Content.ReadFromJsonAsync<AdvancementView>())!.Preview!.CanApply);
        Check.Equal(before, JsonSerializer.Serialize((await host.Get(s.Id))!.Character)); Check.Equal(0, dice.Count);
        var apply = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, draft);
        var both = await Task.WhenAll(Post(host, "/character/advancement/apply", apply), Post(host, "/character/advancement/apply", apply));
        Check.True(both[0].Replayed != both[1].Replayed); s = both[0].Snapshot;
        Check.Equal(2, s.Character.Required().Level); var changed = s.Character.Required().BuildMechanics!.SpellGrants.Single(g => g.Source == old.Source && g.FreeUses > 0);
        Check.Equal("shield", changed.Id); Check.Equal(0, s.Character.Resources.Single(r => r.Name == PlayResources.FreeSpell(changed)).Current);
        var next = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, AdvancementTests.Complete(s.Character, "wizard"));
        s = (await Post(host, "/character/advancement/apply", next)).Snapshot;
        Check.True(s.Character.Required().BuildMechanics!.SpellGrants.Any(g => g.Source == "species:elf/lineage:drow" && g.Id == "faerie-fire"));
        string root = host.Root; await host.DisposeAsync();
        await using var reopened = await Host.Start(root, dice: dice); reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var replay = await Post(reopened, "/character/advancement/apply", apply);
        Check.True(replay.Replayed); Check.Equal(3, replay.Snapshot.Character.Required().Level); Check.Equal(s.Version, replay.Snapshot.Version);
        Check.Equal(JsonSerializer.Serialize(both[0].Resolution), JsonSerializer.Serialize(replay.Resolution));
        Check.Equal(JsonSerializer.Serialize(s.Character), JsonSerializer.Serialize(replay.Snapshot.Character)); Check.Equal(0, dice.Count);
        var sheet = (await reopened.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
        Check.True(!sheet.Spells.Any(o => o.Source == old.Source && o.SpellId == old.Id));
        Check.True(sheet.Spells.Any(o => o.Source == changed.Source && o.SpellId == "shield" && o.Id.EndsWith("/free", StringComparison.Ordinal) && !o.Available));
        Check.Equal(HttpStatusCode.Conflict, (await reopened.Http.PostAsJsonAsync(path + "/character/advancement/apply", apply with { Draft = AdvancementSpellChangeTests.Set(draft, key + ":replacement", "magic-missile") })).StatusCode);
        Check.Equal(s.Version, (await reopened.Get(s.Id))!.Version);
    }
}
