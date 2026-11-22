using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessItemSearchTests
{
    internal const string StockEvidence = "柜内有三根绳索，主人允许来访者取用。";
    internal static AdventureDocument WithEvidence(string text) => TestContent.Document with
    {
        Scenes = TestContent.Document.Scenes.Select(s => s.Id == "harbor" ? s with { Summary = text, Variants = [] } : s).ToArray()
    };
    private static JsonElement Search(string query, LocalRulesPackage? package = null, int offset = 0, int limit = 24, int contract = 26)
        => HarnessJson.Element(HarnessContextReads.Items(7, new("items", query, offset, limit), package, contract));
    private static JsonElement[] Entries(JsonElement result) => result.GetProperty("entries").EnumerateArray().ToArray();
    private static string Item(JsonElement entry) => entry.GetProperty("itemId").GetString()!;
    private static string Kind(JsonElement entry) => entry.GetProperty("match").GetProperty("kind").GetString()!;
    private static LocalRulesPackage Package() => new(1, "dnd2024", "zh-CN", LocalRulesCatalog.SourceRevision, ["XPHB"],
        new(false, false, ["fixture"], []),
        [
            Rule("rope", "绳索", "Rope", "绳索用于捆绑。"),
            Rule("crowbar", "撬棍", "Crowbar", "撬棍的杠杆作用可以发挥在力量检定中。"),
            Rule("bedroll", "睡袋", "Bedroll", "睡袋可供一个小型或中型生物睡眠。"),
            Rule("healer-s-kit", "医疗工具组", "Healer's Kit", "消耗一次使用次数即可稳定生命值为0的昏迷生物。"),
            Rule("tinderbox", "打火匣", "Tinderbox", "内装燧石、火钢和引火物。"),
            Rule("hooded-lantern", "附盖提灯", "Hooded Lantern", "降下灯盖可以减弱光照。")
        ]);
    private static LocalRuleEntry Rule(string id, string name, string canonical, string text) =>
        new(ItemMetadata.Find(id, null)!.Id, "equipment", name, canonical, [], text, "XPHB", 0, LocalRulesCatalog.SourceRevision, new('a', 64), "translated");

    public static Task RankedSearchAndFrozenReads()
    {
        var package = Package();
        foreach (var (query, id, kind) in new[]
        {
            ("（绳索）", "rope", "exact"), ("ＲＯＰＥ", "rope", "exact"),
            ("rpoe", "rope", "fuzzy"), ("grapplign hook", "grappling-hook", "fuzzy"),
            ("hook grappling", "grappling-hook", "terms"), ("kit healer s", "healer-s-kit", "terms"),
            ("睡垫", "bedroll", "fuzzy"), ("撬杆", "crowbar", "fuzzy"), ("麻绳", "rope", "fuzzy"),
            ("昏迷", "healer-s-kit", "text"), ("燧石", "tinderbox", "text")
        })
        {
            var result = Entries(Search(query, package));
            Check.True(result.Length > 0, query);
            Check.Equal(id, Item(result[0])); Check.Equal(kind, Kind(result[0]));
            Check.True(result[0].GetProperty("match").GetProperty("text").GetString()!.Length > 0);
        }
        var exact = Entries(Search("rope", package)); Check.Equal("rope", Item(exact[0])); Check.Equal("exact", Kind(exact[0]));
        Check.Equal(0, Entries(Search("zxqvbbnzzzz", package)).Length);
        Check.Equal(0, Entries(Search("。！？", package)).Length);
        Check.Equal(0, Entries(Search("绳索XYZ", package)).Length);
        Check.Equal(0, Entries(Search("绳索+99", package)).Length);
        Check.True(Entries(Search("绳", package)).All(e => Kind(e) is not ("fuzzy" or "text")));
        Check.Equal("rope", Item(Entries(Search("rpoe"))[0])); // English identity works without a translation package.
        Check.Throws<GameException>(() => Search("\ud800", package));
        Check.Throws<GameException>(() => Search("rope", package, offset: 999));
        foreach (int old in new[] { 23, 24, 25 })
        {
            Check.Equal(0, Entries(Search("rpoe", package, contract: old)).Length);
            var original = Entries(Search("rope", package, contract: old));
            Check.True(!original[0].TryGetProperty("match", out _) && !original[0].TryGetProperty("rulesId", out _));
            Check.Equal(HarnessJson.Serialize(HarnessContextReads.Items(7, new("items", "rope", Limit: 24), package)),
                Search("rope", package, contract: old).GetRawText());
        }
        var first = Search("", package, limit: 7); var all = new List<string>(); int offset = 0;
        do
        {
            var page = Search("", package, offset, 7); all.AddRange(Entries(page).Select(Item));
            offset = page.GetProperty("nextOffset").ValueKind == JsonValueKind.Null ? -1 : page.GetProperty("nextOffset").GetInt32();
        } while (offset >= 0);
        Check.Equal(first.GetProperty("total").GetInt32(), all.Count); Check.Equal(all.Count, all.Distinct().Count());
        Check.True(all.SequenceEqual(all.Order(StringComparer.Ordinal)));
        Check.Equal(Search("工具", package).GetRawText(), Search("工具", package with { Entries = package.Entries.Reverse().ToArray() }).GetRawText());
        return Task.CompletedTask;
    }

    public static Task MaintainedPackage(string directory)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["LocalRules:Directory"] = Path.GetFullPath(directory) }).Build();
        var catalog = new LocalRulesCatalog(config); string pin = catalog.CaptureVersion()!; var package = catalog.Read(pin);
        // Remove aliases only in this in-memory probe: retrieval must not depend on the seven patched aliases.
        var withoutAliases = package with { Entries = package.Entries.Select(e => e with { Aliases = [] }).ToArray() };
        foreach (var (query, id) in new[]
        {
            ("麻绳", "rope"), ("睡垫", "bedroll"), ("grapplign hook", "grappling-hook"),
            ("（附盖提灯）", "hooded-lantern"), ("kit healer s", "healer-s-kit"), ("燧石", "tinderbox"),
            ("杠杆作用", "crowbar"), ("watreskin", "waterskin")
        })
        {
            var entries = Entries(Search(query, withoutAliases));
            Check.True(entries.Take(3).Any(e => Item(e) == id), query + ": " + string.Join(",", entries.Select(Item)));
            var match = entries.First(e => Item(e) == id);
            Console.WriteLine(query + " -> " + id + " (" + Kind(match) + ")");
            Check.True(package.Entries.Any(e => e.Id == match.GetProperty("rulesId").GetString()));
        }
        Console.WriteLine("PASS real maintained item search without aliases: " + pin);
        return Task.CompletedTask;
    }

    public static async Task GroundingRejectsSelfProofWithoutWrites()
    {
        await using var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("No model expected"))));
        var owner = await Create(h, WithEvidence(StockEvidence) with
        {
            InitialKnowledge =
            [
                new("public-stock", "clue", "现场清单", StockEvidence, "harbor", "public"),
                new("private-stock", "clue", "隐藏清单", StockEvidence, "harbor", "host"),
                new("other-stock", "clue", "异地清单", StockEvidence, "causeway", "public")
            ]
        });
        string id = owner.Snapshot.Id, database = Path.Combine(h.Root, "campaigns", id + ".sqlite");
        var game = h.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        int version = auth.Version;
        async Task<HarnessToolOutcome> Record(StoryItemSource source, string item = "rope", bool stock = false, WorldMemoryProposal[]? memories = null)
        {
            var args = new NarrativeHarnessArgs("本次测试物品陈述。", memories ?? [],
                Items: stock ? null : [new(item, "", 1, source)],
                Supplies: stock ? [new("", item, "", 3, "根", "allowed", source)] : null);
            return await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "验证依据", version, Id(),
                HarnessJson.Fingerprint(HarnessJson.Element(args)), new("world_record", HarnessJson.Element(args), "tool"), [], default, auth.Profile,
                26, true, ["public-stock", "private-stock", "other-stock", "model-stock"]);
        }
        async Task Reject(StoryItemSource source, bool stock = false, WorldMemoryProposal[]? memories = null)
        {
            byte[] before = File.ReadAllBytes(database);
            try { await Record(source, stock: stock, memories: memories ?? [new("", "clue", "不应半写", "该记录不应保存。", "known", "harbor")]); throw new Exception("Expected evidence rejection"); }
            catch (GameException e) { Check.Equal("invalid_story_items", e.Code); }
            Check.True(before.SequenceEqual(File.ReadAllBytes(database)), "Rejected claim must not save narrative/memory/stock/inventory/root");
        }
        await Reject(new("current_scene", "harbor", "货架里有三根绳索，随便拿。"), stock: true);
        await Reject(new("current_scene", "harbor", "当面收下了一根绳索。"));
        await Reject(new("public_memory", "private-stock", StockEvidence));
        await Reject(new("public_memory", "other-stock", StockEvidence));
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            WorldMemoryIndex.For(c).Upsert(new("model-stock", "clue", "模型自己写的物资", StockEvidence, "known", "harbor", 1, 1, c.Version,
                PartyEngine.HostId, "harness"));
            return Task.FromResult(0);
        });
        await Reject(new("public_memory", "model-stock", StockEvidence), stock: true);
        await Reject(new("public_memory", "public-stock", StockEvidence), stock: true,
            memories: [new("public-stock", "clue", "现场清单", StockEvidence + "模型新增观察。", "known", "harbor")]);
        // A legitimate public authored quotation can be cited; no extra human approval.
        version = (await Record(new("public_memory", "public-stock", StockEvidence))).Version;
        version = (await Record(new("public_memory", "public-stock", StockEvidence), stock: true)).Version;
        var rewrite = new NarrativeHarnessArgs("更新时仍需保留已登记物资的依据。",
            [new("public-stock", "clue", "现场清单", StockEvidence + "模型新增观察。", "known", "harbor")]);
        byte[] beforeRewrite = File.ReadAllBytes(database);
        try
        {
            await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "修改记录", version, Id(),
                HarnessJson.Fingerprint(HarnessJson.Element(rewrite)), new("world_record", HarnessJson.Element(rewrite), "rewrite"), [], default,
                auth.Profile, 26, true, ["public-stock"]);
            throw new Exception("Existing stock evidence must not be invalidated by a memory-only update");
        }
        catch (GameException e) { Check.Equal("invalid_story_items", e.Code); }
        Check.True(beforeRewrite.SequenceEqual(File.ReadAllBytes(database)));
        byte[] beforeRead = File.ReadAllBytes(database);
        _ = await game.HarnessTool(id, owner.AccessToken, auth.ActorId, Id(), "查物品", version, Id(), "unused",
            new("context_read", HarnessJson.Element(new { scope = "items", query = "rpoe" }), "read"), [], default, auth.Profile, 26, true);
        Check.True(beforeRead.SequenceEqual(File.ReadAllBytes(database)), "Fuzzy search is pure read");
    }

    public static async Task RealPiSearchGroundedClaimAndRestart()
    {
        Exception? failure = null;
        var model = new Model((call, request) =>
        {
            try
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                Check.True(frame.GetProperty("workingContext").GetProperty("guidance").GetString()!.Contains("旧模型正文"));
                if (call == 1) return Tool("context_read", new { scope = "items", query = "rpoe" });
                using var result = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content);
                if (call == 2)
                {
                    Check.Equal("rope", Item(Entries(result.RootElement)[0])); Check.Equal("fuzzy", Kind(Entries(result.RootElement)[0]));
                    return Tool("world_record", new NarrativeHarnessArgs("不应保存的货架和赠物。", [new("", "clue", "虚构货架", "柜中随便取用。", "known", "harbor")],
                        Items: [new("rope", "", 1, new("current_scene", "harbor", "主人凭空拿出一根绳索。"))]));
                }
                Check.Equal(3, call); Check.Equal("invalid_story_items", result.RootElement.GetProperty("code").GetString());
                Check.Equal(0, frame.GetProperty("supplies").GetProperty("total").GetInt32());
                return Tool("world_record", new NarrativeHarnessArgs("依据柜内清单，收下一根绳索。", [],
                    Items: [new("rope", "", 1, new("supply", "", "本次取走一根。"))],
                    Supplies: [new("", "rope", "", 3, "根", "allowed", new("current_scene", "harbor", StockEvidence))]));
            }
            catch (Exception e) { failure = e; throw; }
        });
        var configure = Configure(model, extra: b => { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(h, WithEvidence(StockEvidence));
            int before = owner.Snapshot.Character!.Inventory.FirstOrDefault(i => i.Id == "rope")?.Quantity ?? 0;
            var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "查找并取一根已有的绳索");
            var run = await Settled(h, owner.Snapshot.Id, (await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", input)).Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + failure); Check.Equal(3, model.Calls);
            var snapshot = (await h.Get(owner.Snapshot.Id))!;
            Check.Equal(before + 1, snapshot.Character!.Inventory.Single(i => i.Id == "rope").Quantity);
            Check.True(!(snapshot.WorldMemory ?? []).Any(m => m.Name == "虚构货架"));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, snapshot.Id, "harness/runs", input)).Replayed); Check.Equal(3, model.Calls);
            Check.Equal(before + 1, (await h.Get(snapshot.Id))!.Character!.Inventory.Single(i => i.Id == "rope").Quantity);
        }
        finally { await h.DisposeAsync(); }
    }
}
