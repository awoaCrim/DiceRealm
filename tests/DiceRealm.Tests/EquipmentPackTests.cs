using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class EquipmentPackTests
{
    private static Item Pack(int quantity = 1) => new("burglar-s-pack", "Burglar's Pack", quantity, false);
    private static Campaign Campaign(params Item[] items)
    {
        var c = TestContent.Campaign("harbor");
        c.Character = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Complete("rogue", "elf", "sage"))) with { Inventory = items };
        CharacterEngine.Sync(c);
        return c;
    }
    private static CharacterPlayRequest Command(string key = "unpack:burglar-s-pack") => new(Guid.NewGuid().ToString(), 1, "unpack", key, Choices: []);
    private static CharacterPlayEngine Engine(IDice? dice = null) => new(new(dice ?? new SequenceDice()));
    private static string State(Campaign c) => JsonSerializer.Serialize(c);

    public static Task ContentsAndMerge()
    {
        string[] ids = ["burglar-s-pack", "diplomat-s-pack", "dungeoneers-pack", "entertainer-s-pack", "explorer-s-pack", "priest-s-pack", "scholars-pack"];
        foreach (string id in ids)
        {
            var c = Campaign(new Item(id, "名字不参与身份", 1, false));
            string before = State(c); var option = CharacterPlayEngine.View(c).Packs!.Single();
            Check.True(option.Available); Check.Equal(before, State(c)); Check.Equal("unpack:" + id, option.Key);
            var result = Engine().Resolve(c, Command(option.Key));
            Check.Equal("character.unpack", result.Kind); Check.Equal(option.Contents.Length, c.Character!.Inventory.Length);
            foreach (var child in option.Contents)
            {
                var actual = c.Character.Inventory.Single(i => i.Id == BuildCatalog.ItemId(child.Id));
                Check.Equal(child.Quantity, actual.Quantity); Check.Equal(child.RulesId, actual.RulesId); Check.True(!actual.Equipped);
            }
            Check.Equal(0L, c.ElapsedSeconds); Check.Equal(0, c.PendingRulings.Count);
        }
        var merged = Campaign(Pack(2), new("candle", "保留玩家名称", 3, true, "xphb:candle"), new("instance:oil", "独立油壶", 1, false, "equipment:xphb:oil"));
        var dice = new SequenceDice(); string mechanics = JsonSerializer.Serialize(merged.Character!.BuildMechanics);
        Engine(dice).Resolve(merged, Command());
        Check.Equal(1, merged.Character.Inventory.Single(i => i.Id == "burglar-s-pack").Quantity);
        var candle = merged.Character.Inventory.Single(i => i.Id == "candle");
        Check.Equal(13, candle.Quantity); Check.Equal("保留玩家名称", candle.Name); Check.True(candle.Equipped); Check.Equal("xphb:candle", candle.RulesId);
        Check.Equal(7, merged.Character.Inventory.Single(i => i.Id == "oil").Quantity);
        Check.Equal(1, merged.Character.Inventory.Single(i => i.Id == "instance:oil").Quantity);
        Check.Equal(mechanics, JsonSerializer.Serialize(merged.Character.BuildMechanics)); Check.Equal(0, dice.Count);
        var single = Campaign(Pack()); var beforeWeight = CharacterPlayEngine.View(single).Weight!;
        Check.Equal(47.5m, beforeWeight.TotalPounds);
        Engine().Resolve(single, Command()); var afterWeight = CharacterPlayEngine.View(single).Weight!;
        // Source summary includes the full pack. Recompute from actual items, never retain both.
        Check.Equal(42m, afterWeight.TotalPounds); Check.Equal(11L, afterWeight.UnknownCount); // Bell and 10 candles have no source weight.
        Check.Equal(10, single.Character!.Inventory.Single(i => i.Id == "candle").Quantity);
        Check.Equal(5, single.Character.Inventory.Single(i => i.Id == "rations").Quantity);
        return Task.CompletedTask;
    }

    public static Task IdentityAndAtomicRejections()
    {
        foreach (var item in new[] { new Item("custom", "Burglar's Pack", 1, false), Pack() with { RulesId = "" },
            Pack() with { RulesId = "equipment:phb:burglar-s-pack" }, Pack() with { Quantity = 0 },
            new("arrow-bundle", "Arrows", 1, false) })
        {
            var c = Campaign(item); Check.Equal(0, CharacterPlayEngine.View(c).Packs!.Length);
            string before = State(c); Check.Throws<GameException>(() => Engine().Resolve(c, Command("unpack:" + item.Id))); Check.Equal(before, State(c));
        }
        var sourced = Campaign(new Item("opaque:pack", "改名", 1, false, "xphb:burglar-s-pack"));
        Check.True(CharacterPlayEngine.View(sourced).Packs!.Single().Available);
        Engine().Resolve(sourced, Command("unpack:opaque:pack")); Check.True(sourced.Character!.Inventory.Any(i => i.Id == "candle"));
        var linked = Campaign(new Item("linked", "导入套装", 1, false));
        linked.Adventure = linked.Adventure! with { Items = [new("linked", "套装", "equipment:xphb:burglar-s-pack")] };
        Check.Equal("unpack:linked", CharacterPlayEngine.View(linked).Packs!.Single().Key);
        foreach (var other in new[] { new Item("candle", "别种规则", 1, false, "equipment:xphb:rope"),
            new("candle", "未知规则", 1, false, "missing"), new("oil", "超过上限", 9999, false),
            new("candle", "非法数量", -1, false), Pack() })
        {
            var c = Campaign(Pack(), other); string before = State(c);
            Check.True(!CharacterPlayEngine.View(c).Packs!.Single().Available);
            Check.Throws<GameException>(() => Engine().Resolve(c, Command())); Check.Equal(before, State(c));
        }
        var full = Campaign([Pack(), .. Enumerable.Range(0, 399).Select(i => new Item("custom:" + i, "道具", 1, false))]);
        string fullBefore = State(full); Check.True(!EquipmentPacks.View(full).Single().Available);
        Check.Throws<GameException>(() => Engine().Resolve(full, Command())); Check.Equal(fullBefore, State(full));
        foreach (var command in new[] { Command() with { Value = 2 }, Command() with { Choices = ["oil"] },
            Command() with { Mode = "advantage" }, Command("unpack:missing") })
        {
            var c = Campaign(Pack()); string before = State(c); Check.Throws<GameException>(() => Engine().Resolve(c, command)); Check.Equal(before, State(c));
        }
        var unable = Campaign(Pack()); unable.Character = unable.Character! with { Conditions = ["Unconscious"] };
        string frozen = State(unable); Check.True(!EquipmentPacks.View(unable).Single().Available);
        Check.Throws<GameException>(() => Engine().Resolve(unable, Command())); Check.Equal(frozen, State(unable));
        return Task.CompletedTask;
    }

    public static async Task OtherSeatCannotUnpackOwnedInventory()
    {
        await using var host = await Host.Start();
        var owner = await host.Create(); string id = owner.Snapshot.Id, path = "/api/v1/campaigns/" + id;
        var invite = new InviteRequest(Guid.NewGuid().ToString(), owner.Snapshot.Version, new string('a', 64));
        Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync(path + "/invitations", invite)).StatusCode);
        var build = FullCreationTests.Complete("cleric", "elf", "sage");
        var joined = await host.Http.PostAsJsonAsync(path + "/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), invite.InviteToken, new string('b', 64), build.Identity.Name, Build: build));
        Check.Equal(HttpStatusCode.OK, joined.StatusCode);
        var guest = await host.ApproveGuest(owner, (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!);
        await host.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
        {
            c.Character = c.Character! with { Inventory = [.. c.Character.Inventory, new("owner-only-pack", "套装", 1, false, "equipment:xphb:burglar-s-pack")] };
            return Task.FromResult(0);
        });
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
        Check.True(!sheet.Packs!.Any(p => p.ItemId == "owner-only-pack"));
        string database = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] bytes = File.ReadAllBytes(database);
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync(path + "/character/commands", Command("unpack:owner-only-pack") with { ExpectedVersion = sheet.Version })).StatusCode);
        Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
    }

    // Opt-in native acceptance fixture. Only test data is seeded; unpack writes must come from Player UI.
    public static async Task NativeFixture(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture state path.");
        var dice = new SequenceDice();
        var model = new HarnessTests.Model((_, _) => throw new InvalidOperationException("No model call authorized in pack acceptance"));
        string root; CreatedCampaign owner; CampaignSnapshot final;
        await using (var host = await Host.Start(dice: dice, broken: new BrokenText(), configure: HarnessTests.Configure(model)))
        {
            owner = await HarnessTests.Create(host); root = host.Root;
            await host.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
            {
                c.Character = c.Character! with { Inventory = [.. c.Character.Inventory.Where(i => i.Id != "burglar-s-pack" && i.Id != "candle"), Pack(2), new("candle", "Candle", 3, false)] };
                return Task.FromResult(0);
            });
            JsonFiles.Write(statePath, new { baseUrl = host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = host.Root,
                processId = Environment.ProcessId, owner.AccessToken, campaignId = owner.Snapshot.Id, fixture = "equipment-pack-ui-real-http" });
            while (!File.Exists(statePath + ".stop")) await Task.Delay(250);
            final = (await host.Get(owner.Snapshot.Id))!;
        }
        await using var restart = await Host.Start(root, dice, broken: new BrokenText(), configure: HarnessTests.Configure(model));
        restart.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var reopened = (await restart.Get(owner.Snapshot.Id))!;
        Check.Equal(final.Version, reopened.Version);
        Check.Equal(JsonSerializer.Serialize(final.Character!.Inventory), JsonSerializer.Serialize(reopened.Character!.Inventory));
        JsonFiles.Write(statePath + ".result", new { final.Version, final.Character.Inventory, dice = dice.Count, modelCalls = model.Calls, restartVerified = true });
        Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
    }

    public static async Task HttpReplayRollbackAndRestart()
    {
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice, broken: new BrokenText());
        try
        {
            var owner = await host.Create(); string id = owner.Snapshot.Id, path = "/api/v1/campaigns/" + id;
            var store = host.App.Services.GetRequiredService<CampaignStore>();
            await store.Access(id, owner.AccessToken, true, c =>
            {
                c.Character = c.Character! with { Inventory = [.. c.Character.Inventory.Where(i => i.Id != "burglar-s-pack"), Pack(2)] };
                return Task.FromResult(0);
            });
            var sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            var request = Command(sheet.Packs!.Single(p => p.ItemId == "burglar-s-pack").Key) with { ExpectedVersion = sheet.Version };
            string database = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] bytes = File.ReadAllBytes(database);
            await host.Http.GetAsync(path + "/character/sheet"); Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            try
            {
                await store.Access<int>(id, owner.AccessToken, true, c =>
                {
                    Engine().Resolve(c, request);
                    throw new IOException("Simulated outer save failure");
                });
                throw new Exception("Expected transaction rollback");
            }
            catch (IOException) { }
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(database))); Check.Equal(2, (await host.Get(id))!.Character!.Inventory.Single(i => i.Id == "burglar-s-pack").Quantity);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", "invalid");
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync(path + "/character/commands", request)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", request with { ExpectedVersion = sheet.Version + 1 })).StatusCode);
            var race = await Task.WhenAll(host.Http.PostAsJsonAsync(path + "/character/commands", request), host.Http.PostAsJsonAsync(path + "/character/commands", request));
            foreach (var response in race) Check.Equal(HttpStatusCode.OK, response.StatusCode);
            var responses = await Task.WhenAll(race.Select(r => r.Content.ReadFromJsonAsync<ActionResponse>()));
            Check.True(responses[0]!.Replayed != responses[1]!.Replayed);
            var first = responses[0]!; Check.Equal(sheet.Version + 1, first.Snapshot.Version);
            Check.Equal(1, first.Snapshot.Character!.Inventory.Single(i => i.Id == "burglar-s-pack").Quantity);
            Check.Equal(10, first.Snapshot.Character.Inventory.Single(i => i.Id == "candle").Quantity);
            Check.Equal(0L, first.Snapshot.ElapsedSeconds); Check.Equal(0, first.Snapshot.PendingRulings.Length); Check.Equal(0, dice.Count);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", request with { Key = "changed" })).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", request with { RequestId = Guid.NewGuid().ToString() })).StatusCode);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, dice, broken: new BrokenText());
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await host.Http.PostAsJsonAsync(path + "/character/commands", request);
            Check.Equal(HttpStatusCode.OK, replay.StatusCode); Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
            Check.Equal(JsonSerializer.Serialize(first.Snapshot.Character.Inventory), JsonSerializer.Serialize((await host.Get(id))!.Character!.Inventory));
            Check.Equal(first.Snapshot.Version, (await host.Get(id))!.Version);
        }
        finally { await host.DisposeAsync(); }
    }
}
