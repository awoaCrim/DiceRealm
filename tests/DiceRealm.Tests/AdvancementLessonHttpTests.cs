using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Tests;

internal static class AdvancementLessonHttpTests
{
    public static async Task RevocationRegrantReceiptsAndCorruptLedger()
    {
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice);
        const string lesson = "lessons-of-the-first-ones/magic-initiate";
        const string origin = "optional:" + lesson;
        try
        {
            var build = FullCreationTests.Complete("warlock", "dwarf", "soldier");
            var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Revocable feat source", build.Identity.Name,
                Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
            Check.Equal(HttpStatusCode.Created, create.StatusCode);
            var owner = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string path = "/api/v1/campaigns/" + owner.Snapshot.Id;
            async Task<ActionResponse> Post<T>(string endpoint, T body)
            {
                var response = await host.Http.PostAsJsonAsync(path + endpoint, body);
                Check.Equal(HttpStatusCode.OK, response.StatusCode);
                return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
            }
            var s = (await Post("/characters/advancement/award", new AwardAdvancementRequest(Guid.NewGuid().ToString(), owner.Snapshot.Version,
                PartyEngine.HostId, "milestone", 6, "隔离来源撤销验证"))).Snapshot;
            var gain = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version,
                AdvancementLessonTests.Complete(s.Character.Required(), ["armor-of-shadows", "eldritch-mind", lesson]));
            string before = JsonSerializer.Serialize(s.Character);
            var preview = await host.Http.PostAsJsonAsync(path + "/character/advancement/preview", new PreviewAdvancementRequest(s.Version, gain.Draft));
            Check.Equal(HttpStatusCode.OK, preview.StatusCode);
            Check.True((await preview.Content.ReadFromJsonAsync<AdvancementView>())!.Preview!.CanApply);
            Check.Equal(before, JsonSerializer.Serialize((await host.Get(s.Id))!.Character));
            s = (await Post("/character/advancement/apply", gain)).Snapshot;
            var grant = s.Character.Required().Advancement!.Classes.Single().BonusSpells!.Single(b => b.Origin == origin && b.Uses > 0);
            string resource = AdvancementSheet.FreeSpell(grant);
            s = (await Post("/characters/adjust", new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, PartyEngine.HostId,
                "已使用来源免费次数", "隔离测试", [new CharacterAdjustment("resource", resource, 0)]))).Snapshot;
            var remove = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version,
                AdvancementLessonTests.Complete(s.Character.Required(), ["armor-of-shadows", "eldritch-mind", "lessons-of-the-first-ones/tough"]));
            var removed = await Post("/character/advancement/apply", remove); s = removed.Snapshot;
            Check.True(!s.Character.Required().Resources.Any(r => r.Name == resource));
            Check.Equal(0, s.Character.Advancement!.RetiredResources!.Single(r => r.Name == resource).Current);
            var root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, dice: dice);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post("/character/advancement/apply", remove);
            Check.True(replay.Replayed); Check.Equal(s.Version, replay.Snapshot.Version);
            Check.Equal(JsonSerializer.Serialize(removed.Resolution), JsonSerializer.Serialize(replay.Resolution));
            var sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            Check.True(!sheet.Spells.Any(o => o.Source == origin));
            var regrant = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version,
                AdvancementLessonTests.Complete(s.Character, ["armor-of-shadows", "eldritch-mind", lesson]));
            var replies = await Task.WhenAll(Post("/character/advancement/apply", regrant), Post("/character/advancement/apply", regrant));
            Check.True(replies[0].Replayed != replies[1].Replayed); s = replies[0].Snapshot;
            Check.Equal(0, s.Character.Required().Resources.Single(r => r.Name == resource).Current);
            Check.True(s.Character.Advancement!.RetiredResources is null);
            await host.DisposeAsync(); host = await Host.Start(root, dice: dice);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var original = await Post("/character/advancement/apply", gain);
            Check.True(original.Replayed); Check.Equal(s.Version, original.Snapshot.Version);
            Check.Equal(4, original.Snapshot.Character.Required().Level); Check.Equal(0, original.Snapshot.Character.Required().Resources.Single(r => r.Name == resource).Current);
            Check.Equal(0, dice.Count);
            var dropAgain = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version,
                AdvancementLessonTests.Complete(s.Character, ["armor-of-shadows", "eldritch-mind", "lessons-of-the-first-ones/tough"]));
            s = (await Post("/character/advancement/apply", dropAgain)).Snapshot;
            Check.True(s.Character.Required().Advancement!.RetiredResources!.Any(r => r.Name == resource));
            long priorBoundary = s.Character.NextLongRestAtSeconds;
            s = (await host.Rest(s, "long")).Snapshot;
            Check.True(s.Character.Required().NextLongRestAtSeconds > priorBoundary);
            var slots = s.Character.Advancement!.Classes.Single().OptionalFeatures.Select(id => id == "lessons-of-the-first-ones/tough" ? lesson : id).ToArray();
            s = (await Post("/character/advancement/apply", new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version,
                AdvancementLessonTests.Complete(s.Character, slots)))).Snapshot;
            Check.Equal(1, s.Character.Required().Resources.Single(r => r.Name == resource).Current);
            Check.Equal(6, s.Character.Level); Check.Equal(0, dice.Count);

            // This is our isolated database, closed before corruption injection. A bad
            // source ledger must not be silently regenerated from the displayed aggregate.
            await host.DisposeAsync();
            string file = Path.Combine(root, "campaigns", s.Id + ".sqlite");
            using (var db = new SqliteConnection($"Data Source={file};Pooling=False"))
            {
                db.Open(); using var cmd = db.CreateCommand();
                cmd.CommandText = "UPDATE state SET json=json_remove(json,'$.character.advancement.featSources')";
                Check.Equal(1, cmd.ExecuteNonQuery());
            }
            byte[] bytes = File.ReadAllBytes(file);
            host = await Host.Start(root, dice: dice); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var rejected = await host.Http.GetAsync(path);
            Check.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
            Check.Equal("invalid_advancement_state", JsonDocument.Parse(await rejected.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(file))); Check.Equal(0, dice.Count);
        }
        finally { await host.DisposeAsync(); }
    }
}
