using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessSupplyTests
{
    public static async Task BrowserFixture(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath)) throw new InvalidOperationException("Use a fresh isolated fixture path.");
        var model = new Model((_, _) => throw new Exception("No provider authorized in prompt UI acceptance"));
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h);
        AccountTests.SeedAdminFixture(h);
        JsonFiles.Write(statePath, new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority),
            campaignId = owner.Snapshot.Id, dataPath = h.Root, processId = Environment.ProcessId });
        while (!File.Exists(statePath + ".stop")) await Task.Delay(200);
        Check.Equal(0, model.Calls);
    }

    public static Task MaintainedAliases(string directory)
    {
        var config = new Microsoft.Extensions.Configuration.ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["LocalRules:Directory"] = Path.GetFullPath(directory) }).Build();
        var catalog = new LocalRulesCatalog(config); var version = catalog.CaptureVersion()!; var package = catalog.Read(version);
        foreach (var (name, id) in new[] { ("麻绳", "rope"), ("粗麻绳", "rope"), ("绳子", "rope"), ("火油", "oil"), ("灯油", "oil"), ("铁撬", "crowbar"), ("火把", "torch") })
        {
            var result = HarnessJson.Element(HarnessContextReads.Items(1, new("items", name), package));
            Check.Equal(id, result.GetProperty("entries").EnumerateArray().Single().GetProperty("itemId").GetString());
            Check.Throws<GameException>(() => HarnessContextReads.RejectCatalogProps([("", name)], package));
        }
        Console.WriteLine("Maintained package aliases + acquisition boundary passed: " + version);
        return Task.CompletedTask;
    }

    private static StorySupplyProposal Stock(string permission = "allowed", int quantity = 3) =>
        new("", "rope", "", quantity, "根（目录一件）", permission, new("current_scene", "harbor", "码头主人已清点三根绳索，并说明是否允许取用。"));
    private static StoryItemGrant Claim(string id, int quantity = 1) => new("rope", "", quantity, new("supply", id, "本轮明确取走并收下。"));

    public static async Task AtomicStockClaimsAndRestart()
    {
        var configure = Configure(new Model((_, _) => throw new Exception("No provider expected")));
        var h = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var game = h.App.Services.GetRequiredService<GameService>();
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            int version = auth.Version;
            string database = Path.Combine(h.Root, "campaigns", id + ".sqlite");
            async Task<HarnessToolOutcome> Record(NarrativeHarnessArgs args, string? intent = null, string? command = null, int? at = null, int contract = 25)
                => await game.HarnessTool(id, owner.AccessToken, auth.ActorId, intent ?? Id(), "领取物资", at ?? version,
                    command ?? Id(), HarnessJson.Fingerprint(HarnessJson.Element(args)),
                    new("world_record", HarnessJson.Element(args), "tool"), [], default, auth.Profile, contract, true, []);
            async Task Reject(NarrativeHarnessArgs args, string code = "invalid_story_items", int contract = 25)
            {
                byte[] before = File.ReadAllBytes(database);
                try { await Record(args, contract: contract); throw new Exception("Expected rejection"); }
                catch (GameException error) { Check.Equal(code, error.Code); }
                Check.True(before.SequenceEqual(File.ReadAllBytes(database)), "Rejected stock must not write root, inventory, narrative or receipt");
            }
            var initial = new NarrativeHarnessArgs("主人列出物资。", [], Supplies: [Stock("ask")]);
            await Reject(initial, "harness_invalid_payload", contract: 24);
            var first = await Record(initial); version = first.Version;
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            async Task<StorySupply> Saved() => await store.Access(id, owner.AccessToken, false, c => Task.FromResult(c.StorySupplies!.Single()));
            var supply = await Saved(); Check.Equal(3, supply.Remaining);
            await Reject(new("不应交付", [], Items: [Claim(supply.Id)]));
            await Reject(new("不应绕过", [], Items: [new("rope", "", 1, new("current_scene", "harbor", "绕过物资记录"))]));
            await Reject(new("不应重置", [], Supplies: [Stock()]));
            version = (await Record(new("主人明确允许取用。", [], Supplies: [Stock() with { Id = supply.Id }]))).Version;
            string intent = Id(), command = Id(); int oldVersion = version;
            var taking = new NarrativeHarnessArgs("取走两根绳索。", [], Items: [Claim(supply.Id, 2)], Complete: false);
            int beforeRope = (await h.Get(id))!.Character!.Inventory.FirstOrDefault(i => i.Id == "rope")?.Quantity ?? 0;
            var accepted = await Record(taking, intent, command); version = accepted.Version;
            Check.Equal(1, (await Saved()).Remaining);
            Check.Equal(beforeRope + 2, (await h.Get(id))!.Character!.Inventory.Single(i => i.Id == "rope").Quantity);
            Check.Equal(HarnessJson.Serialize(accepted), HarnessJson.Serialize(await Record(taking, intent, command, oldVersion)));
            await Reject(new("超量无半写", [], Items: [Claim(supply.Id, 2)], Supplies: [Stock() with { Id = supply.Id, Quantity = 1 }]));
            version = (await Record(taking, intent)).Version; // same action total, new transport call: no new stock or bag grant
            Check.Equal(1, (await Saved()).Remaining);
            Check.Equal(beforeRope + 2, (await h.Get(id))!.Character!.Inventory.Single(i => i.Id == "rope").Quantity);
            int concurrentVersion = version;
            async Task<bool> Race()
            {
                try { await Record(new("最后一根", [], Items: [Claim(supply.Id)]), at: concurrentVersion); return true; }
                catch (GameException e) { Check.Equal("stale_version", e.Code); return false; }
            }
            var raced = await Task.WhenAll(Race(), Race()); Check.Equal(1, raced.Count(x => x));
            version = (await h.Get(id))!.Version; Check.Equal(0, (await Saved()).Remaining);
            await Reject(new("余额不足", [], Items: [Claim(supply.Id)]));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            game = h.App.Services.GetRequiredService<GameService>(); store = h.App.Services.GetRequiredService<CampaignStore>();
            Check.Equal(HarnessJson.Serialize(accepted), HarnessJson.Serialize(await Record(taking, intent, command, oldVersion)));
            Check.Equal(0, (await Saved()).Remaining);
            Check.Equal(beforeRope + 3, (await h.Get(id))!.Character!.Inventory.Single(i => i.Id == "rope").Quantity);
            version = (await h.Get(id))!.Version;
            string letterIntent = Id();
            var letter = Stock() with { ItemId = "", Name = "密封信件", Quantity = 2, Unit = "封" };
            var letterGrant = new StoryItemGrant("", "密封信件", 1, new("supply", "", "本人当面收下"));
            version = (await Record(new("收下信件", [], Items: [letterGrant], Supplies: [letter], Complete: false), letterIntent)).Version;
            var letterStock = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(c.StorySupplies!.Single(s => s.Name == "密封信件")));
            version = (await Record(new("再次确认原领取", [], Items: [letterGrant with { Name = " 密封信件 ", Source = letterGrant.Source! with { Id = letterStock.Id } }]), letterIntent)).Version;
            Check.Equal(1, await store.Access(id, owner.AccessToken, false, c => Task.FromResult(c.StorySupplies!.Single(s => s.Name == "密封信件").Claimed)));
            Check.Equal(1, (await h.Get(id))!.Character!.Inventory.Single(i => i.Name == "密封信件").Quantity);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task FirstFrameAndSameCallStockThroughPi()
    {
        Exception? failure = null;
        var model = new Model((call, request) =>
        {
            try
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                Check.True(frame.GetProperty("self").GetProperty("inventory").GetArrayLength() > 0);
                Check.True(frame.GetProperty("context").GetProperty("intent").GetProperty("context").GetProperty("place").GetString()!.Length > 0);
                Check.True(frame.TryGetProperty("supplies", out var supplies));
                if (call == 1)
                {
                    Check.Equal(0, supplies.GetProperty("total").GetInt32());
                    return Tool("world_record", new NarrativeHarnessArgs("主人列出三根绳索，玩家收下一根。", [], Items: [Claim("")], Supplies: [Stock() with { Source = new("current_scene", "harbor", HarnessItemSearchTests.StockEvidence) }]));
                }
                Check.Equal(2, supplies.GetProperty("entries")[0].GetProperty("remaining").GetInt32());
                // Contract 56 supplies the complete entry prose in every exploration frame.
                Check.Equal("included", frame.GetProperty("scenePresentation").GetProperty("arrivalStatus").GetString());
                if (call == 2) return Tool("context_read", new { scope = "scene" });
                var detail = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content);
                Check.True(detail.RootElement.GetProperty("scenePresentation").GetProperty("arrival").GetString()!.Length > 0);
                return Tool("world_record", new NarrativeHarnessArgs("只回答名字，不重新铺陈入场或清点背包。", []));
            }
            catch (Exception e) { failure = e; throw; }
        });
        await using var h = await Host.Start(configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        var owner = await Create(h, HarnessItemSearchTests.WithEvidence(HarnessItemSearchTests.StockEvidence));
        for (int i = 0; i < 2; i++)
        {
            var snapshot = (await h.Get(owner.Snapshot.Id))!;
            var run = await Settled(h, snapshot.Id, (await Start(h, snapshot, i == 0 ? "拿一根绳索" : "你叫什么名字？")).Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + failure);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(snapshot.Id, PartyEngine.HostId, run.Id)!;
            Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion);
            Check.True(saved.Steps.Last().Outcome!.Reply.Stop);
        }
        Check.True(model.Calls == 3, "Accepted final world_record must not trigger another model call");
    }

    public static async Task ArrivalAfterSettledObserveAndTravel()
    {
        Exception? failure = null;
        var model = new Model((call, request) =>
        {
            try
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                // Contract 56 runs always carry entry prose; frozen v25..55 gating is checked after the runs.
                var scene = frame.GetProperty("scenePresentation");
                Check.Equal("included", scene.GetProperty("arrivalStatus").GetString());
                Check.True(scene.GetProperty("arrival").GetString()!.Length > 0);
                if (call == 2)
                {
                    var candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                        .Single(c => c.GetProperty("label").GetString() == "观察场景").GetProperty("id").GetString();
                    return Tool("actions_propose", new { candidateId = candidate });
                }
                return Tool("world_record", new NarrativeHarnessArgs("当前描述已保存。", [], Complete: call == 3 ? false : null));
            }
            catch (Exception e) { failure = e; throw; }
        });
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        for (int i = 0; i < 2; i++)
        {
            var run = await Settled(h, id, (await Start(h, (await h.Get(id))!, i == 0 ? "问候" : "观察场景")).Id);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + failure);
        }
        Check.Equal(4, model.Calls);
        var game = h.App.Services.GetRequiredService<GameService>();
        var snapshot = (await h.Get(id))!;
        // Frozen v25..55 runs receive arrival only on entry, settled observation/travel or an explicit scene read.
        var frozen = await game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "问候", snapshot.Version, default, 55);
        Check.Equal("", frozen.ScenePresentation!.Arrival);
        var route = await game.Act(id, owner.AccessToken, new(Id(), snapshot.Version, "talk"), default);
        var traveled = await game.Act(id, owner.AccessToken, new(Id(), route.Snapshot.Version, "travel", "causeway"), default);
        var frameAfterTravel = await game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "问候", traveled.Snapshot.Version, default, 25);
        Check.Equal("causeway", frameAfterTravel.ScenePresentation!.SceneId);
        Check.True(frameAfterTravel.ScenePresentation.Arrival.Length > 0);
        var database = Path.Combine(h.Root, "campaigns", id + ".sqlite"); var before = File.ReadAllBytes(database);
        await game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "再次读取", traveled.Snapshot.Version, default, 25);
        Check.True(before.SequenceEqual(File.ReadAllBytes(database)), "Frame reads never consume entry or change saves");
        var back = await game.Act(id, owner.AccessToken, new(Id(), traveled.Snapshot.Version, "travel", "harbor"), default);
        var returned = await game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, Id(), "返回", back.Snapshot.Version, default, 25);
        Check.True(returned.ScenePresentation!.Arrival.Length > 0, "Returning to the last narrated scene still counts as an actual entry");
    }

    public static Task LocalVisibilityAndCatalogBoundary()
    {
        var c = TestContent.Campaign(); var intent = new PendingIntent { Id = Id(), ActorId = PartyEngine.HostId, Text = "领取" };
        var result = StorySupplies.Plan(c, intent, [Stock()], [Claim("")], new HashSet<string>());
        Check.Equal(2, result.Supplies.Single().Remaining);
        Check.True(c.StorySupplies is null, "Planning is pure");
        c.StorySupplies = result.Supplies;
        Check.Equal(1, StorySupplies.Current(c).Length);
        c.SceneId = "causeway"; Check.Equal(0, StorySupplies.Current(c).Length);
        Check.Throws<GameException>(() => StorySupplies.Plan(c, intent, null, [Claim(result.Supplies.Single().Id)], new HashSet<string>()));
        c.SceneId = "harbor";
        WorldMemoryIndex.For(c).Upsert(new("local", "place", "物资棚", "当前公开棚子", "known", "harbor", 1, 1, c.Version, PartyEngine.HostId, "harness"));
        c.StorySupplies = StorySupplies.Plan(c, intent, [Stock() with { Source = new("public_memory", "local", "棚主人允许") }], null, new HashSet<string> { "local" }).Supplies;
        Check.Equal(2, StorySupplies.Current(c).Length);
        WorldMemoryIndex.For(c).Upsert(WorldMemories.Find(c, "local")! with { Hidden = true });
        Check.Equal(1, StorySupplies.Current(c).Length);
        var hidden = c.StorySupplies.Single(s => s.Source.Id == "local");
        Check.Throws<GameException>(() => StorySupplies.Plan(c, intent, null, [Claim(hidden.Id)], new HashSet<string>()));
        HarnessContextReads.RejectCatalogProps([("", "独特的手写纸条")], null);
        Check.Throws<GameException>(() => HarnessContextReads.RejectCatalogProps([("", PlayCatalog.ItemName("rope"))], null));
        Check.Throws<GameException>(() => HarnessContextReads.Validate(new("supplies"), 24));
        HarnessContextReads.Validate(new("supplies"), 25);
        return Task.CompletedTask;
    }
}
