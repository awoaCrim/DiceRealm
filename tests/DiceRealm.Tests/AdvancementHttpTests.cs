using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdvancementHttpTests
{
    public static async Task AuthorityReceiptsAndRestart()
    {
        var dice = new SequenceDice();
        var host = await Host.Start(dice: dice);
        string root = host.Root;
        var build = FullCreationTests.Complete("wizard", "dwarf", "sage");
        var createdResponse = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Growth integration", build.Identity.Name,
            Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
        Check.Equal(HttpStatusCode.Created, createdResponse.StatusCode);
        var created = (await createdResponse.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        string path = "/api/v1/campaigns/" + created.Snapshot.Id;
        var view = (await host.Http.GetFromJsonAsync<AdvancementView>(path + "/character/advancement"))!;
        Check.True(!view.Available); Check.Equal(1, view.MaximumLevel);
        var draft = AdvancementTests.Complete(created.Snapshot.Character.Required());
        var unearned = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), view.Version, draft);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/advancement/apply", unearned)).StatusCode);
        var before = (await host.Get(created.Snapshot.Id))!;
        Check.Equal(view.Version, before.Version); Check.Equal(1, before.Character.Required().Level);
        var award = new AwardAdvancementRequest(Guid.NewGuid().ToString(), before.Version, PartyEngine.HostId, "experience", 300, "完成回归场景中的已确认目标");
        var granted = await host.Http.PostAsJsonAsync(path + "/characters/advancement/award", award);
        Check.Equal(HttpStatusCode.OK, granted.StatusCode);
        var s = (await granted.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        Check.Equal(1, s.Character.Required().Level);
        var replayAward = (await (await host.Http.PostAsJsonAsync(path + "/characters/advancement/award", award)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replayAward.Replayed); Check.Equal(s.Version, replayAward.Snapshot.Version);
        var eligible = (await host.Http.GetFromJsonAsync<AdvancementView>(path + "/character/advancement"))!;
        Check.Equal(300, eligible.Experience); Check.Equal(2, eligible.MaximumLevel); Check.True(eligible.Available);
        string state = JsonSerializer.Serialize((await host.Get(s.Id))!.Character);
        var preview = await host.Http.PostAsJsonAsync(path + "/character/advancement/preview", new PreviewAdvancementRequest(s.Version, draft));
        Check.Equal(HttpStatusCode.OK, preview.StatusCode);
        Check.True((await preview.Content.ReadFromJsonAsync<AdvancementView>())!.Preview!.CanApply);
        Check.Equal(state, JsonSerializer.Serialize((await host.Get(s.Id))!.Character)); Check.Equal(0, dice.Count);
        var forged = "{\"expectedVersion\":" + s.Version + ",\"draft\":{\"classId\":\"wizard\",\"hitPoints\":999}}";
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsync(path + "/character/advancement/preview", new StringContent(forged, Encoding.UTF8, "application/json"))).StatusCode);
        var apply = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, draft);
        var results = await Task.WhenAll(host.Http.PostAsJsonAsync(path + "/character/advancement/apply", apply),
            host.Http.PostAsJsonAsync(path + "/character/advancement/apply", apply));
        Check.True(results.All(r => r.StatusCode == HttpStatusCode.OK));
        var a = (await results[0].Content.ReadFromJsonAsync<ActionResponse>())!;
        var b = (await results[1].Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(a.Replayed != b.Replayed); Check.Equal(2, a.Snapshot.Character.Required().Level); Check.Equal(s.Version + 1, a.Snapshot.Version);
        Check.Equal(JsonSerializer.Serialize(a.Resolution), JsonSerializer.Serialize(b.Resolution)); Check.Equal(0, dice.Count);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/advancement/apply", apply with { Draft = draft with { ClassId = "fighter" } })).StatusCode);
        var sheet = await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet");
        Check.True(sheet!.ClassPreparations is { Length: 1 }); Check.True(sheet.Spells.Length > 0);
        await host.DisposeAsync();
        await using var reopened = await Host.Start(root, dice: dice);
        reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        var replay = (await (await reopened.Http.PostAsJsonAsync(path + "/character/advancement/apply", apply)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(2, replay.Snapshot.Character.Required().Level);
        Check.Equal(JsonSerializer.Serialize(a.Resolution), JsonSerializer.Serialize(replay.Resolution));
        Check.Equal(JsonSerializer.Serialize(a.Snapshot.Character.Advancement), JsonSerializer.Serialize(replay.Snapshot.Character.Advancement));
        reopened.Http.DefaultRequestHeaders.Authorization = null;
        Check.Equal(HttpStatusCode.Unauthorized, (await reopened.Http.PostAsJsonAsync(path + "/character/advancement/apply", apply)).StatusCode);
    }
    public static Task HigherPreparationAndInvalidRecords()
    {
        var wizard = BuildEvaluator.Create(FullCreationTests.Complete("wizard", "elf", "sage"));
        for (int n = 2; n <= 5; n++) wizard = AdvancementTests.Level(wizard, subclass: n == 3 ? "wizard:abjurer" : "");
        wizard = wizard with { Resources = wizard.Resources.Select(r => r.Name == "Spell Slots (2nd)" ? r with { Current = 1 } : r).ToArray() };
        var c = TestContent.Campaign("harbor"); c.Character = wizard;
        CharacterEngine.Sync(c);
        var closed = CharacterPlayEngine.View(c);
        Check.True(!closed.Preparation.Available); Check.True(closed.Spells.Any(s => s.Resource == "Spell Slots (3rd)"));
        c.Character = PlayResources.LongRest(c.Character);
        var view = CharacterPlayEngine.View(c);
        Check.True(view.Preparation.Available);
        Check.True(view.Preparation.Options.Any(o => AdvancementCatalog.Get().Spells.Single(s => s.Id == o.Id).Level == 3));
        var originalBuild = JsonSerializer.Serialize(c.Character.Build);
        var originalSteps = JsonSerializer.Serialize(c.Character.Advancement!.Steps);
        var selected = view.Preparation.Options.Reverse().Take(view.Preparation.Count).Select(o => o.Id).ToArray();
        var engine = new CharacterPlayEngine(new RulesEngine(new SequenceDice()));
        engine.Resolve(c, new("test", c.Version, "prepare", "wizard", Choices: selected));
        Check.Equal(originalBuild, JsonSerializer.Serialize(c.Character.Build));
        Check.Equal(originalSteps, JsonSerializer.Serialize(c.Character.Advancement!.Steps));
        Check.True(c.Character.Advancement.Classes.Single().PreparedSpells.SequenceEqual(selected));
        Check.True(!CharacterPlayEngine.View(c).Preparation.Available);
        var bad = c.Character with { Advancement = c.Character.Advancement with { Classes = [c.Character.Advancement.Classes[0] with { Cantrips = null! }] } };
        Check.Throws<GameException>(() => AdvancementEngine.State(bad));
        var empty = c.Character with { Advancement = c.Character.Advancement with { Steps = [null!] } };
        Check.Throws<GameException>(() => AdvancementEngine.State(empty));
        Check.Throws<GameException>(() => AdvancementEngine.Evaluate(c.Character, new() { ClassId = "wizard", Selections = [new("bad", [null!])] }, 20));
        return Task.CompletedTask;
    }
}
