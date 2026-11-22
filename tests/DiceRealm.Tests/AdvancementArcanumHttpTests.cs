using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Tests;

internal static class AdvancementArcanumHttpTests
{
    public static async Task ActualGrowthReplacementRaceAndReopen()
    {
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice);
        try
        {
            var build = FullCreationTests.Complete("warlock", "dwarf", "soldier");
            var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Arcanum isolated growth", build.Identity.Name,
                Adventure: TestContent.Document, Prompts: TestContent.Prompts, StartImmediately: true, Build: build));
            Check.Equal(HttpStatusCode.Created, create.StatusCode);
            var owner = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string path = "/api/v1/campaigns/" + owner.Snapshot.Id;
            async Task<ActionResponse> Post<T>(string route, T body)
            {
                var reply = await host.Http.PostAsJsonAsync(path + route, body); Check.Equal(HttpStatusCode.OK, reply.StatusCode);
                return (await reply.Content.ReadFromJsonAsync<ActionResponse>())!;
            }
            var s = (await Post("/characters/advancement/award", new AwardAdvancementRequest(Guid.NewGuid().ToString(), owner.Snapshot.Version,
                PartyEngine.HostId, "milestone", 13, "隔离秘法奥秘测试"))).Snapshot;
            const string hostResource = "DM: 剧情计数 [class:warlock/arcanum:6]";
            s = (await Post("/characters/adjust", new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, PartyEngine.HostId,
                "合法自定义资源兼容", "隔离夹具", [new CharacterAdjustment("resource.define", "", 3, "剧情计数 [class:warlock/arcanum:6]")]))).Snapshot;
            while (s.Character.Required().Level < 11)
                s = (await Post("/character/advancement/apply", new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version,
                    AdvancementTests.Complete(s.Character, subclass: s.Character.Level == 2 ? "warlock:fiend" : "")))).Snapshot;
            var old = AdvancementArcanumTests.Arcanum(s.Character, 6);
            s = (await Post("/characters/adjust", new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, PartyEngine.HostId,
                "消耗秘法奥秘", "隔离夹具", [new CharacterAdjustment("resource", AdvancementSheet.FreeSpell(old), 0)]))).Snapshot;
            var apply = new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, AdvancementArcanumTests.Replace(s.Character.Required()));
            string before = JsonSerializer.Serialize(s.Character);
            var preview = await host.Http.PostAsJsonAsync(path + "/character/advancement/preview", new PreviewAdvancementRequest(s.Version, apply.Draft));
            Check.Equal(HttpStatusCode.OK, preview.StatusCode); Check.True((await preview.Content.ReadFromJsonAsync<AdvancementView>())!.Preview!.CanApply);
            Check.Equal(before, JsonSerializer.Serialize((await host.Get(s.Id))!.Character)); Check.Equal(0, dice.Count);
            string root = host.Root;
            string database = Path.Combine(root, "campaigns", s.Id + ".sqlite");
            byte[] unchanged = File.ReadAllBytes(database);
            foreach (var invalidDraft in new[]
            {
                AdvancementSpellChangeTests.Set(apply.Draft, AdvancementArcanumTests.Key + ":replacement", "wish"),
                AdvancementSpellChangeTests.Set(apply.Draft, AdvancementArcanumTests.Key, old.Origin, "class:warlock/arcanum:7")
            })
            {
                var rejected = await host.Http.PostAsJsonAsync(path + "/character/advancement/apply",
                    new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, invalidDraft));
                Check.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
                Check.Equal("advancement_incomplete", JsonDocument.Parse(await rejected.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
                Check.True(unchanged.SequenceEqual(File.ReadAllBytes(database))); // Includes state, events and receipts.
            }
            await host.DisposeAsync(); host = await Host.Start(root, dice: dice);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var other = apply with { RequestId = Guid.NewGuid().ToString() };
            var both = await Task.WhenAll(host.Http.PostAsJsonAsync(path + "/character/advancement/apply", apply), host.Http.PostAsJsonAsync(path + "/character/advancement/apply", other));
            Check.Equal(1, both.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, both.Count(r => r.StatusCode == HttpStatusCode.Conflict));
            int win = both[0].IsSuccessStatusCode ? 0 : 1; var original = win == 0 ? apply : other;
            var result = (await both[win].Content.ReadFromJsonAsync<ActionResponse>())!; s = result.Snapshot;
            var changed = AdvancementArcanumTests.Arcanum(s.Character.Required(), 6);
            Check.True(old.Id != changed.Id); Check.Equal(0, s.Character.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(changed)).Current);
            s = (await Post("/character/advancement/apply", new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, AdvancementArcanumTests.Replace(s.Character)))).Snapshot;
            Check.Equal(13, s.Character.Required().Level);
            Check.Equal(0, s.Character.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(AdvancementArcanumTests.Arcanum(s.Character, 6))).Current);
            Check.Equal(1, s.Character.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(AdvancementArcanumTests.Arcanum(s.Character, 7))).Current);
            await host.DisposeAsync(); host = await Host.Start(root, dice: dice); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post("/character/advancement/apply", original);
            Check.True(replay.Replayed); Check.Equal(s.Version, replay.Snapshot.Version); Check.Equal(13, replay.Snapshot.Character.Required().Level);
            Check.Equal(JsonSerializer.Serialize(result.Resolution), JsonSerializer.Serialize(replay.Resolution));
            Check.Equal(JsonSerializer.Serialize(s.Character), JsonSerializer.Serialize(replay.Snapshot.Character));
            var custom = replay.Snapshot.Character.Resources.Single(r => r.Name == hostResource);
            Check.Equal(0, custom.Current); Check.Equal(3, custom.Maximum); Check.Equal("manual", custom.Recovery);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/advancement/apply", original with
                { Draft = AdvancementSpellChangeTests.Set(original.Draft, AdvancementArcanumTests.Key + ":replacement", old.Id) })).StatusCode);
            Check.Equal(0, dice.Count);
            await host.DisposeAsync();
            string file = Path.Combine(root, "campaigns", s.Id + ".sqlite");
            string pristine;
            using (var db = new SqliteConnection($"Data Source={file};Pooling=False"))
            {
                db.Open(); using var cmd = db.CreateCommand();
                cmd.CommandText = "SELECT json FROM state WHERE id=1"; pristine = (string)cmd.ExecuteScalar()!;
                cmd.CommandText = "UPDATE state SET json=json_set(json, '$.character.advancement.classes[0].bonusSpells', json($spells))";
                cmd.Parameters.AddWithValue("$spells", JsonSerializer.Serialize(s.Character.Advancement!.Classes.Single().BonusSpells!.Where(b => b.Mode != "arcanum"), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
                Check.Equal(1, cmd.ExecuteNonQuery());
            }
            byte[] bytes = File.ReadAllBytes(file);
            host = await Host.Start(root, dice: dice); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var invalid = await host.Http.GetAsync(path); Check.Equal(HttpStatusCode.Conflict, invalid.StatusCode);
            Check.Equal("invalid_advancement_state", JsonDocument.Parse(await invalid.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(file))); Check.Equal(0, dice.Count);
            var pool = s.Character.Resources.Single(r => r.Name == AdvancementSheet.FreeSpell(AdvancementArcanumTests.Arcanum(s.Character, 6)));
            foreach (var resources in new[]
            {
                s.Character.Resources.Where(r => r != pool).ToArray(), s.Character.Resources.Append(pool).ToArray(),
                s.Character.Resources.Select(r => r == pool ? r with { Maximum = 2 } : r).ToArray(),
                s.Character.Resources.Select(r => r == pool ? r with { Current = 2 } : r).ToArray(),
                s.Character.Resources.Select(r => r == pool ? r with { Recovery = "short" } : r).ToArray()
            })
            {
                await host.DisposeAsync();
                using (var db = new SqliteConnection($"Data Source={file};Pooling=False"))
                {
                    db.Open(); using var cmd = db.CreateCommand();
                    cmd.CommandText = "UPDATE state SET json=json_set($pristine, '$.character.resources', json($resources))";
                    cmd.Parameters.AddWithValue("$pristine", pristine);
                    cmd.Parameters.AddWithValue("$resources", JsonSerializer.Serialize(resources, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
                    Check.Equal(1, cmd.ExecuteNonQuery());
                }
                bytes = File.ReadAllBytes(file);
                host = await Host.Start(root, dice: dice); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                foreach (var reply in new[]
                {
                    await host.Http.GetAsync(path),
                    await host.Http.PostAsJsonAsync(path + "/character/advancement/apply", new ApplyAdvancementRequest(Guid.NewGuid().ToString(), s.Version, AdvancementTests.Complete(s.Character)))
                })
                {
                    Check.Equal(HttpStatusCode.Conflict, reply.StatusCode);
                    Check.Equal("invalid_advancement_state", JsonDocument.Parse(await reply.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
                }
                Check.True(bytes.SequenceEqual(File.ReadAllBytes(file))); Check.Equal(0, dice.Count);
            }
        }
        finally { await host.DisposeAsync(); }
    }
}
