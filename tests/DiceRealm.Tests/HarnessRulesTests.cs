using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessRulesTests
{
    private const string RuleId = "spell:fireball:xphb", Revision = "e5f3e77b303a92df10487207857200245e71957c";
    // Synthetic contract text, not an authoritative translation or part of the distributed library.
    private const string Body = "测试火球术：敏捷豁免，8d6火焰伤害。\n这是分页与中文传输夹具。😀\n升环测试尾注。";
    internal static LocalRuleEntry Entry(string id = RuleId, string text = Body) =>
        new(id, "spell", "火球术", "Fireball", ["火球"], text, "XPHB", 274, Revision, new string('a', 64), "translated");
    internal static LocalRulesPackage Package(params LocalRuleEntry[] entries) => new(1, "dnd2024", "zh-CN", Revision, ["XPHB"],
        new(false, false, ["XDMG/XMM及其他中文正文尚未纳入测试库"],
            new[] { "spell", "class", "subclass", "feature", "species", "background", "feat", "equipment", "magic_item", "monster", "condition", "rule", "language" }
                .ToDictionary(c => c, c => new LocalRulesCount(entries.Count(e => e.Category == c), entries.Count(e => e.Category == c)))), entries);
    internal sealed class Fixture
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "dicerealm-local-rules-" + Id());
        public LocalRulesCatalog Catalog { get; }
        public Fixture()
        {
            Directory.CreateDirectory(Root);
            Catalog = new(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["LocalRules:Directory"] = Root }).Build());
        }
        public string Publish(LocalRulesPackage package) => Publish(HarnessJson.Serialize(package));
        public string Publish(string json)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json); string version = JsonFiles.Hash(bytes);
            JsonFiles.WriteBytes(Path.Combine(Root, version + ".json"), bytes); JsonFiles.Write(Path.Combine(Root, "active.json"), new LocalRulesPointer(version));
            return version;
        }
        public Action<WebApplicationBuilder> Configure(Model model, IHarnessRuntime? runtime = null, bool pi = false) => HarnessTests.Configure(model, runtime, b =>
        {
            b.Configuration["LocalRules:Directory"] = Root;
            if (pi) { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); }
        });
    }
    private static void Error(string code, Action action)
    {
        try { action(); } catch (GameException ex) { Check.Equal(code, ex.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static async Task Error(string code, Func<Task> action)
    {
        try { await action(); } catch (GameException ex) { Check.Equal(code, ex.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static JsonElement Output(HarnessModelRequest request, string name) =>
        JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool" && m.Name == name).Content).RootElement.Clone();

    public static Task StrictPackagesAndCompletePagination()
    {
        var fixture = new Fixture(); string text = new string('文', 5900) + "😀" + new string('字', 6400) + "末尾不可丢失";
        var entries = Enumerable.Range(0, 19).Select(i => Entry("spell:" + i.ToString("D2"), text) with
        { Name = "火球术 " + new string('名', 150), CanonicalName = "Fireball " + i, Aliases = ["同名检索"] }).ToArray();
        var package = Package(entries); string version = fixture.Publish(package);
        Check.Equal(version, fixture.Catalog.CaptureVersion()); Check.Equal(19, fixture.Catalog.Read(version).Entries.Length);
        int offset = 0; bool shortened = false; var ids = new List<string>();
        do
        {
            var page = HarnessRules.Search(fixture.Catalog, version, 7, new("FiReBaLl 末尾", Offset: offset, Limit: 8));
            Check.Equal(7, page.Version); Check.Equal(version, page.CatalogVersion);
            Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(page)) <= HarnessRules.SearchBytes);
            Check.True(!HarnessJson.Element(page).GetProperty("entries")[0].TryGetProperty("source", out _));
            shortened |= page.Entries.Length < 8 && page.NextOffset is not null;
            ids.AddRange(page.Entries.Select(e => e.Id));
            if (page.NextOffset is null) break;
            Check.Equal(offset + page.Entries.Length, page.NextOffset.Value); offset = page.NextOffset.Value;
        } while (true);
        Check.True(shortened); Check.Equal(19, ids.Count); Check.Equal(19, ids.Distinct().Count()); Check.True(ids.SequenceEqual(entries.Select(e => e.Id)));
        Check.Equal(6, HarnessRules.Search(fixture.Catalog, version, 7, new("同名检索")).Entries.Length);
        Check.Equal(0, HarnessRules.Search(fixture.Catalog, version, 7, new("不存在")).Entries.Length);
        Check.Equal(0, HarnessRules.Search(fixture.Catalog, version, 7, new("", "monster")).Entries.Length);
        var buffer = new StringBuilder(); offset = 0;
        do
        {
            var page = HarnessRules.Read(fixture.Catalog, version, 7, new(entries[0].Id, offset, 5901));
            Check.Equal(text.Length, page.TotalCharacters); Check.Equal(offset, page.Offset);
            Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(page)) <= HarnessRules.ReadBytes);
            buffer.Append(page.Text);
            if (page.NextOffset is null) break;
            Check.Equal(offset + page.Text.Length, page.NextOffset.Value); offset = page.NextOffset.Value;
        } while (true);
        Check.Equal(text, buffer.ToString());
        var scalar = HarnessRules.Read(fixture.Catalog, version, 7, new(entries[0].Id, 5900, 1)); Check.Equal("😀", scalar.Text); Check.Equal(5902, scalar.NextOffset);
        Check.Equal("", HarnessRules.Read(fixture.Catalog, version, 7, new(entries[0].Id, text.Length)).Text);
        Error("harness_invalid_payload", () => HarnessRules.Read(fixture.Catalog, version, 7, new(entries[0].Id, 5901)));
        foreach (var args in new[] { new HarnessRulesSearchArgs(null!), new("x\n"), new(new string('x', 121)), new("a b c d e f g h i"),
            new("", null!), new("", "Spell"), new("", Offset: -1), new("", Offset: 20001), new("", Limit: 0), new("", Limit: 9) })
            Error("harness_invalid_payload", () => HarnessRules.Search(fixture.Catalog, version, 7, args));
        foreach (var args in new[] { new HarnessRulesReadArgs("../x"), new(null!), new(entries[0].Id, -1), new(entries[0].Id, text.Length + 1),
            new(entries[0].Id, 262145), new(entries[0].Id, Limit: 0), new(entries[0].Id, Limit: 6001) })
            Error("harness_invalid_payload", () => HarnessRules.Read(fixture.Catalog, version, 7, args));
        Error("rules_entry_unavailable", () => HarnessRules.Read(fixture.Catalog, version, 7, new("spell:missing")));
        var ranked = Package(Entry("a", "包含火球术关键词。") with { Name = "其他规则", Aliases = [] }, Entry("z"));
        Check.Equal("z", HarnessRules.Search(fixture.Catalog, fixture.Publish(ranked), 7, new("火球术")).Entries[0].Id);
        string original = HarnessJson.Serialize(Package(Entry()));
        Action<JsonObject>[] mutations = [
            j => j["schemaVersion"] = 2, j => j["ruleset"] = "dnd2014", j => j["language"] = "en",
            j => j["sources"] = new JsonArray("PHB"), j => j["sources"] = new JsonArray("XPHB", "XPHB"),
            j => j["sourceRevision"] = "main", j => j["entries"] = null, j => j["unknown"] = true, j => j.Remove("language"),
            j => { j["sourceRevision"] = new string('b', 40); j["entries"]![0]!["sourceRevision"] = new string('b', 40); },
            j => j["coverage"]!["counts"] = new JsonObject(), j => j["coverage"]!["counts"]!.AsObject().Remove("monster"),
            j => j["coverage"]!["counts"]!["extra"] = new JsonObject { ["sourceCount"] = 0, ["translatedCount"] = 0 },
            j => j["entries"]![0]!["text"] = "未解析的{@spell Fireball|XPHB}正文", 
            j => j["entries"]!.AsArray().Add(j["entries"]![0]!.DeepClone()),
            j => j["entries"]![0]!["sourceHash"] = "bad", j => j["entries"]![0]!["translationStatus"] = "name-only",
            j => j["entries"]![0]!["sourceRevision"] = new string('b', 40), j => j["entries"]![0]!["source"] = "XMM",
            j => j["entries"]![0]!["id"] = "../x", j => j["entries"]![0]!["text"] = "", j => j["entries"]![0]!["page"] = -1,
            j => j["coverage"]!["translationComplete"] = true, j => j["coverage"]!["sourceComplete"] = true,
            j => j["coverage"]!["counts"]!["spell"]!["translatedCount"] = 2, j => j["coverage"]!["counts"]!["spell"]!["sourceCount"] = 0,
            j => j["coverage"]!["missing"] = new JsonArray(), j => j["entries"]![0]!.AsObject().Remove("text")
        ];
        foreach (var mutate in mutations)
        {
            var json = JsonNode.Parse(original)!.AsObject(); mutate(json); string bad = fixture.Publish(json.ToJsonString());
            string path = Path.Combine(fixture.Root, bad + ".json"); byte[] before = File.ReadAllBytes(path);
            Error("rules_catalog_corrupt", () => fixture.Catalog.CaptureVersion()); Check.True(before.SequenceEqual(File.ReadAllBytes(path)));
        }
        // Even internally consistent counts and all three book codes cannot certify
        // full source coverage without an independent complete-source manifest pin.
        foreach (var plausible in new[] { Package(), Package(Entry()) })
        {
            fixture.Publish(plausible with { Sources = ["XPHB", "XDMG", "XMM"],
                Coverage = plausible.Coverage with { SourceComplete = true, TranslationComplete = true, Missing = [] } });
            Error("rules_catalog_corrupt", () => fixture.Catalog.CaptureVersion());
        }
        foreach (string json in new[] { original.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1"),
            original.Replace("\"translatedCount\":1", "\"translatedCount\":1,\"translatedCount\":1"), "[]", "{bad" })
        { fixture.Publish(json); Error("rules_catalog_corrupt", () => fixture.Catalog.CaptureVersion()); }
        foreach (string pointer in new[] { "{\"version\":\"../x\"}", "{\"version\":\"" + version + "\",\"extra\":1}",
            "{\"version\":\"" + version + "\",\"version\":\"" + version + "\"}" })
        { File.WriteAllText(Path.Combine(fixture.Root, "active.json"), pointer); Error("rules_catalog_corrupt", () => fixture.Catalog.CaptureVersion()); }
        version = fixture.Publish(Package(Entry())); string immutable = Path.Combine(fixture.Root, version + ".json");
        _ = fixture.Catalog.Read(version); File.AppendAllText(immutable, " "); Error("rules_catalog_corrupt", () => fixture.Catalog.Read(version));
        File.Delete(immutable); Error("rules_catalog_unavailable", () => fixture.Catalog.Read(version));
        Error("rules_catalog_corrupt", () => fixture.Catalog.Read("../../source"));
        var absent = new LocalRulesCatalog(new ConfigurationBuilder().Build()); Check.True(absent.CaptureVersion() is null);
        Error("rules_catalog_unavailable", () => HarnessRules.Search(absent, null, 1, new("火球")));
        return Task.CompletedTask;
    }

    public static async Task AuthorizedReadOnlyAndNoCandidates()
    {
        var fixture = new Fixture(); string version = fixture.Publish(Package(Entry())); var dice = new SequenceDice();
        var model = new Model((_, _) => throw new Exception("No model for reads"));
        await using var host = await Host.Start(dice: dice, configure: fixture.Configure(model)); var owner = await Create(host);
        string id = owner.Snapshot.Id; var guest = await HarnessBoundaryTests.Guest(host, owner);
        var game = host.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        var state = (await host.Get(id))!; int cursor = state.Version;
        Task<HarnessToolOutcome> Call(string name, object args, int contract = 4, string? token = null, string? actor = null, int? at = null, string[]? offered = null) =>
            game.HarnessTool(id, token ?? owner.AccessToken, actor ?? auth.ActorId, Id(), "查看火球术", at ?? cursor, Id(), Id(),
                new(name, args is JsonElement raw ? raw : HarnessJson.Element(args), "rules"), offered ?? [], default, auth.Profile,
                contract, rulesCatalogVersion: contract >= 4 ? version : null);
        string db = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] before = File.ReadAllBytes(db);
        var search = await Call("rules_search", new { query = "火球" }); var read = await Call("rules_read", new { id = RuleId });
        foreach (var output in new[] { search, read })
        {
            Check.True(output.OfferedIds is null && output.OfferedMemoryIds is null && output.Wait is null && !output.Reply.Stop);
            var json = JsonDocument.Parse(output.Reply.Content).RootElement;
            Check.Equal(version, json.GetProperty("catalogVersion").GetString());
            Check.True(!json.TryGetProperty("source", out _) && !json.TryGetProperty("page", out _) && !json.TryGetProperty("sourceRevision", out _));
        }
        Check.Equal(Body, HarnessJson.Read<HarnessRulesReadResult>(JsonDocument.Parse(read.Reply.Content).RootElement).Text);
        var scope = JsonDocument.Parse((await Call("rules_scope", new { })).Reply.Content).RootElement;
        Check.True(scope.GetProperty("localRules").GetProperty("available").GetBoolean());
        Check.True(!scope.GetProperty("localRules").GetProperty("translationComplete").GetBoolean());
        await Error("intent_option_unavailable", () => Call("actions_propose", new { candidateId = RuleId }));
        await Error("invalid_world_memory", () => Call("world_record", new NarrativeHarnessArgs("不能用规则ID更新世界。", [new(RuleId, "clue", "火球", "假的引用", "known", "")])));
        foreach (string raw in new[] { "{}", "{\"query\":\"\",\"query\":\"x\"}", "{\"query\":\"\",\"actor\":\"other\"}", "{\"query\":\"\",\"limit\":1.5}" })
            await Error("harness_invalid_payload", () => Call("rules_search", JsonDocument.Parse(raw).RootElement));
        foreach (int old in new[] { 0, 1, 2, 3 }) await Error("harness_tool_unavailable", () => Call("rules_read", new { id = RuleId }, old));
        await Error("stale_version", () => Call("rules_search", new { query = "" }, at: cursor - 1));
        var guestRead = await Call("rules_read", new { id = RuleId }, token: guest.AccessToken, actor: guest.Snapshot.Party!.SelfActorId);
        Check.Equal(read.Reply.Content, guestRead.Reply.Content);
        Check.True(before.SequenceEqual(File.ReadAllBytes(db))); Check.Equal(0, model.Calls); Check.Equal(0, dice.Count);
        var candidates = await Call("context_read", new { }); string candidate = candidates.OfferedIds![0];
        var stillRead = await Call("rules_search", new { query = "火球" }, offered: candidates.OfferedIds); Check.True(stillRead.OfferedIds is null);
        Check.True(candidates.OfferedIds.Contains(candidate));
        await Post<ActionResponse>(host, id, "seats/revoke", new RevokeSeatRequest(Id(), cursor, guest.Snapshot.Party!.SelfActorId)); cursor++;
        await Error("unauthorized", () => Call("rules_read", new { id = RuleId }, token: guest.AccessToken, actor: guest.Snapshot.Party!.SelfActorId));
        var foreign = await Create(host); await Error("unauthorized", () => Call("rules_search", new { query = "" }, token: foreign.AccessToken));
    }

    public static async Task RealPiPinnedEditionAndRestart()
    {
        var fixture = new Fixture(); string first = fixture.Publish(Package(Entry())); string second = ""; var dice = new SequenceDice();
        var model = new Model((n, request) =>
        {
            if (n == 1) return Tool("rules_search", new { query = "火球" });
            if (n == 2)
            {
                var output = Output(request, "rules_search"); Check.Equal(first, output.GetProperty("catalogVersion").GetString());
                Check.Equal(RuleId, output.GetProperty("entries")[0].GetProperty("id").GetString()); return Tool("rules_read", new { id = RuleId, limit = 12 });
            }
            if (n == 3) { Check.Equal(Body[..12], Output(request, "rules_read").GetProperty("text").GetString()); return Tool("ask_player", new { question = "继续查阅后文吗？" }); }
            if (n == 4) return Tool("rules_read", new { id = RuleId, offset = 12 });
            if (n == 5)
            {
                var output = Output(request, "rules_read"); Check.Equal(first, output.GetProperty("catalogVersion").GetString());
                Check.Equal(Body[12..], output.GetProperty("text").GetString()); return Text("已查阅本地中文全文，尚未执行法术。");
            }
            if (n == 6) return Tool("rules_read", new { id = RuleId });
            Check.Equal(7, n); Check.Equal(second, Output(request, "rules_read").GetProperty("catalogVersion").GetString()); return Text("新行动采用新译本。");
        });
        var configure = fixture.Configure(model, pi: true); var host = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(host); string id = owner.Snapshot.Id;
            var request = new AdventureActionRequest(Id(), owner.Snapshot.Version, "查看火球术，不施法");
            var session = await Post<AdventureSessionView>(host, id, "adventure/actions", request);
            var run = await Settled(host, id, session.SessionId, 3000); Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            Check.Equal(owner.Snapshot.Version, run.Version); Check.Equal(0, dice.Count); Check.Equal(3, model.Calls);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion); Check.Equal(first, saved.RulesCatalogVersion); Check.True(saved.OfferedIds.Length == 0 && saved.OfferedMemoryIds is null);
            string prefix = HarnessJson.Serialize(saved.Steps); int count = saved.Steps.Count;
            Check.True(!saved.Turns[0].Contains(RuleId) && !saved.Turns[0].Contains(Body));
            second = fixture.Publish(Package(Entry(text: "新版独立中文正文。")));
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, dice, configure: configure);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal("waiting", (await Settled(host, id, run.Id)).Status); Check.Equal(3, model.Calls);
            var resume = new AdventureActionRequest(Id(), run.Version, "继续查阅");
            await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume);
            run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error); Check.Equal(5, model.Calls);
            saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(first, saved.RulesCatalogVersion); Check.Equal(prefix, HarnessJson.Serialize(saved.Steps.Take(count).ToList()));
            var state = (await host.Get(id))!; Check.Equal(HarnessJson.Serialize(owner.Snapshot.Character), HarnessJson.Serialize(state.Character));
            Check.Equal(HarnessJson.Serialize(owner.Snapshot.WorldMemory), HarnessJson.Serialize(state.WorldMemory)); Check.Equal(0, dice.Count);
            var next = await Start(host, state, "再次查看规则"); next = await Settled(host, id, next.Id, 3000); Check.Equal("completed", next.Status); Check.Equal(7, model.Calls);
            File.Delete(Path.Combine(fixture.Root, first + ".json")); File.Delete(Path.Combine(fixture.Root, "active.json"));
            Check.True((await Post<AdventureSessionView>(host, id, "adventure/actions", request)).Replayed);
            Check.True((await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume)).Replayed);
            Check.Equal("completed", (await Settled(host, id, run.Id)).Status); Check.Equal(7, model.Calls);
            Check.True(model.Requests.All(r => r.Tools.All(t => t.Name is not ("bash" or "read" or "write" or "dnd_search"))));
            Console.WriteLine("RULES real Pi/MCP: local Chinese search + complete paged text, pinned old edition after active switch/restart, 7 fake calls, 0 dice/resources; completed receipts replay without source files");
        }
        finally { await host.DisposeAsync(); }
    }

    // Explicit opt-in: copyrighted source/translation data is not embedded in the test assembly.
    public static async Task RealMaintainedPackage(string directory)
    {
        if (!Path.IsPathFullyQualified(directory)) throw new ArgumentException("Supply an absolute local rules dist directory.");
        var catalog = new LocalRulesCatalog(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["LocalRules:Directory"] = directory }).Build());
        string version = catalog.CaptureVersion() ?? throw new Exception("No maintained package configured");
        var package = catalog.Read(version);
        Check.Equal(391, package.Entries.Count(e => e.Category == "spell"));
        Check.Equal(18, package.Entries.Count(e => e.Category == "condition"));
        Check.True(!package.Coverage.SourceComplete && !package.Coverage.TranslationComplete);
        Check.Equal(2685, package.Coverage.Counts.Values.Sum(c => c.SourceCount));
        // Original English aliases are internal search identities, not visible translated labels.
        var aliasMatch = HarnessRules.Search(catalog, version, 1, new("Firebolt", "spell"));
        Check.Equal("spell:xphb:fire-bolt", aliasMatch.Entries.Single().Id);
        var aliasProjection = HarnessJson.Element(aliasMatch).GetProperty("entries")[0];
        foreach (string key in new[] { "aliases", "canonicalName", "source", "page", "sourceRevision" })
            Check.True(!aliasProjection.TryGetProperty(key, out _));
        // Each published category remains reachable through the same bounded query path.
        foreach (string category in package.Entries.Select(e => e.Category).Distinct())
            Check.True(HarnessRules.Search(catalog, version, 1, new("", category)).Entries.All(e => e.Category == category));
        if (package.Entries.Any(e => e.Category == "equipment"))
        {
            foreach (var sample in new[] {
                (Query: "武僧", Category: "class", Id: "class:xphb:monk"),
                (Query: "心灵之刃", Category: "equipment", Id: "equipment:xphb:psychic-blade"),
                (Query: "护盾术", Category: "spell", Id: "spell:xphb:shield"),
                (Query: "盾牌", Category: "equipment", Id: "equipment:xphb:shield"),
                (Query: "重装", Category: "rule", Id: "rule:xdmg:item-property-rld"),
                (Query: "Luckstone", Category: "magic_item", Id: "magic_item:xdmg:stone-of-good-luck"),
                (Query: "便携式深洞", Category: "magic_item", Id: "magic_item:xdmg:portable-hole") })
            {
                var result = HarnessRules.Search(catalog, version, 1, new(sample.Query, sample.Category));
                Check.Equal(sample.Id, result.Entries[0].Id);
                var projected = HarnessJson.Element(result).GetProperty("entries")[0];
                foreach (string key in new[] { "aliases", "canonicalName", "source", "page", "sourceRevision", "sourceHash" })
                    Check.True(!projected.TryGetProperty(key, out _));
            }
            foreach (var sample in new[] {
                (Id: "equipment:xphb:psychic-blade", Needle: "60/120"),
                (Id: "equipment:xdmg:revolver", Needle: "在你下个回合开始前"),
                (Id: "magic_item:xdmg:ioun-stone-reserve", Needle: "环阶总和不超过4"),
                (Id: "magic_item:xdmg:portable-hole", Needle: "未处于全掩护后"),
                (Id: "equipment:xphb:trinket", Needle: "331422-W") })
                Check.True(package.Entries.Single(e => e.Id == sample.Id).Text.Contains(sample.Needle, StringComparison.Ordinal), sample.Id);
        }
        // Generated spell-association metadata must not contradict the authoritative feat text.
        foreach (string name in new[] { "fey-touched", "shadow-touched", "telekinetic", "telepathic" })
        {
            var entry = package.Entries.Single(e => e.Id == "feat:xphb:" + name);
            Check.True(!entry.Text.Contains("随职业", StringComparison.Ordinal), entry.Id);
            Check.True(entry.Text.Contains("施法属性：依所属规则正文确定", StringComparison.Ordinal), entry.Id);
            Check.Equal(entry.Id, HarnessRules.Search(catalog, version, 1, new(entry.Name, "feat")).Entries[0].Id);
        }
        foreach (string name in new[] { "magic-initiate", "fey-touched", "shadow-touched", "telepathic" })
        {
            var entry = package.Entries.Single(e => e.Id == "feat:xphb:" + name);
            Check.True(!entry.Text.Contains("\n每日：", StringComparison.Ordinal), entry.Id);
            foreach (string term in new[] { "限次施法（使用与恢复条件见正文）", "长休", "法术位", "不表示同时获得所有分组" })
                Check.True(entry.Text.Contains(term, StringComparison.Ordinal), entry.Id + ": " + term);
        }
        // Every maintained body, including long tables, must traverse without loss.
        foreach (var entry in package.Entries)
        {
            var complete = new StringBuilder(); int offset = 0;
            do
            {
                var page = HarnessRules.Read(catalog, version, 1, new(entry.Id, offset, 1000));
                complete.Append(page.Text);
                if (page.NextOffset is null) break;
                Check.True(page.NextOffset > offset); offset = page.NextOffset.Value;
            } while (true);
            Check.Equal(entry.Text, complete.ToString());
        }
        const string maintainedId = "spell:xphb:fireball";
        var fireball = package.Entries.Single(e => e.Id == maintainedId);
        foreach (string needle in new[] { "8d6", "20尺", "150尺", "敏捷豁免", "4环", "1d6", "蝙蝠粪" })
            Check.True(fireball.Text.Contains(needle, StringComparison.Ordinal), "Missing maintained fireball detail: " + needle);
        var fixture = new Fixture();
        Check.Equal(version, fixture.Publish(File.ReadAllText(Path.Combine(directory, version + ".json"))));
        var received = new StringBuilder(); int nextOffset = 0; var dice = new SequenceDice();
        var model = new Model((n, request) =>
        {
            if (n == 1) return Tool("rules_search", new { query = "火球术", category = "spell" });
            if (n == 2)
            {
                var result = Output(request, "rules_search");
                Check.Equal(maintainedId, result.GetProperty("entries")[0].GetProperty("id").GetString());
                return Tool("rules_read", new { id = maintainedId, limit = 120 });
            }
            var page = Output(request, "rules_read");
            Check.Equal(version, page.GetProperty("catalogVersion").GetString());
            Check.Equal(nextOffset, page.GetProperty("offset").GetInt32());
            Check.Equal(fireball.Text.Length, page.GetProperty("totalCharacters").GetInt32());
            foreach (string key in new[] { "source", "page", "sourceRevision", "sourceHash" }) Check.True(!page.TryGetProperty(key, out _));
            received.Append(page.GetProperty("text").GetString());
            var next = page.GetProperty("nextOffset");
            if (next.ValueKind != JsonValueKind.Null)
            {
                nextOffset = next.GetInt32();
                return Tool("rules_read", new { id = maintainedId, offset = nextOffset, limit = 120 });
            }
            Check.Equal(fireball.Text, received.ToString());
            return Text("已按需查阅本地中文火球术全文，未执行施法。");
        });
        await using var host = await Host.Start(dice: dice, configure: fixture.Configure(model, pi: true));
        var owner = await Create(host); string id = owner.Snapshot.Id;
        var run = await Start(host, owner.Snapshot, "查看火球术的完整效果和升环，不施法");
        run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
        Check.Equal(fireball.Text, received.ToString()); Check.Equal(0, dice.Count);
        var after = (await host.Get(id))!;
        Check.Equal(HarnessJson.Serialize(owner.Snapshot.Character), HarnessJson.Serialize(after.Character));
        Check.Equal(HarnessJson.Serialize(owner.Snapshot.WorldMemory), HarnessJson.Serialize(after.WorldMemory));
        var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
        Check.Equal(version, saved.RulesCatalogVersion);
        Check.True(saved.OfferedIds.Length == 0 && saved.OfferedMemoryIds is null);
        Console.WriteLine($"MAINTAINED RULES real Pi/MCP: {package.Entries.Length} strict-loaded and paged bodies; complete Fireball, {model.Calls} fake calls, 0 dice/resources/remote rules calls; pack {version}");
    }

    private sealed class DisconnectAfterRead : IHarnessRuntime
    {
        public Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct) =>
            new Loop().Execute(execution, async (call, token) =>
            {
                var reply = await callback(call, token);
                if (call.Kind == "tool" && HarnessJson.Read<HarnessToolRequest>(call.Payload).Name == "rules_read") throw new IOException("fixture read disconnect");
                return reply;
            }, ct);
    }
    public static async Task InterruptedReadsNeverRebase()
    {
        foreach (bool missing in new[] { false, true })
        {
            var fixture = new Fixture(); string first = fixture.Publish(Package(Entry()));
            var model = new Model((n, request) =>
            {
                if (n == 1) return Tool("rules_read", new { id = RuleId });
                Check.Equal(first, Output(request, "rules_read").GetProperty("catalogVersion").GetString());
                Check.Equal(Body, Output(request, "rules_read").GetProperty("text").GetString()); return Text("原版读取恢复。");
            });
            var host = await Host.Start(configure: fixture.Configure(model, new DisconnectAfterRead()));
            try
            {
                var owner = await Create(host); string id = owner.Snapshot.Id; var run = await Start(host, owner.Snapshot); run = await Settled(host, id, run.Id);
                Check.Equal("interrupted", run.Status);
                var store = host.App.Services.GetRequiredService<HarnessRunStore>(); var saved = store.Read(id, PartyEngine.HostId, run.Id)!;
                var step = saved.Steps.Single(s => s.ToolName == "rules_read"); step.Status = "started"; step.Result = null; step.Outcome = null; store.Save(saved);
                fixture.Publish(Package(Entry(text: "不能替代未完成读取的新版本。")));
                if (missing) File.Delete(Path.Combine(fixture.Root, first + ".json"));
                string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, configure: fixture.Configure(model));
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version));
                run = await Settled(host, id, run.Id); Check.Equal(missing ? "failed" : "completed", run.Status);
                Check.Equal(missing ? "rules_catalog_unavailable" : "", run.Error); Check.Equal(missing ? 1 : 2, model.Calls);
                if (missing) Check.Equal(owner.Snapshot.Version, (await host.Get(id))!.Version);
            }
            finally { await host.DisposeAsync(); }
        }
    }

    public static async Task FrozenCatalogsAndCorruptBindings()
    {
        string[] hashes = ["1e9fb4d9891e507f0afa12114e9122a55fbc92fd7ad5367c4c261c17bbd05146", "6ac18cf35c4836acad2e06919c2de4b799aee31f68a67c5e082253d7efe9befb",
            "488b5eeb31b64448e403574ff6e6ed577e3eb03695275d3b241a01223c51ad25", "4b1fabef000fc6a7019d5918c407d859132eace566c146a150c330ded8dd7649"];
        for (int i = 0; i <= 3; i++) Check.Equal(hashes[i], HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(i))));
        var fixture = new Fixture(); string version = fixture.Publish(Package(Entry()));
        var model = new Model((n, request) =>
        {
            Check.True(request.Tools.All(t => t.Name is not ("rules_read" or "rules_search")));
            if (n == 1) return Tool("rules_scope");
            Check.Equal(2, n); var scope = Output(request, "rules_scope"); Check.True(!scope.TryGetProperty("localRules", out _));
            Check.Equal("XPHB", scope.GetProperty("source").GetString()); return Text("旧契约不变。");
        });
        await using var host = await Host.Start(configure: fixture.Configure(model, pi: true)); var owner = await Create(host); string id = owner.Snapshot.Id;
        var auth = await host.App.Services.GetRequiredService<GameService>().AuthorizeHarness(id, owner.AccessToken, default);
        var legacy = new HarnessRun { Id = Id(), IntentId = Id(), CampaignId = id, ActorId = auth.ActorId, Fingerprint = new string('a', 64), Input = "旧v3",
            Profile = auth.Profile, Limits = new(), Version = owner.Snapshot.Version, ToolContractVersion = 3, Turns = [HarnessJson.Serialize(new { input = "旧v3", ruleset = "dnd2024" })] };
        Check.True(!HarnessJson.Element(legacy).TryGetProperty("rulesCatalogVersion", out _));
        var store = host.App.Services.GetRequiredService<HarnessRunStore>(); store.Create(legacy);
        File.WriteAllText(Path.Combine(fixture.Root, "active.json"), "broken"); // Must not upgrade or touch the library for an old run.
        await Post<HarnessRunView>(host, id, $"harness/runs/{legacy.Id}/resume", new HarnessResumeRequest(Id(), legacy.Version));
        var run = await Settled(host, id, legacy.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error); Check.Equal(2, model.Calls);
        string file = Path.Combine(host.Root, "harness", id, JsonFiles.Hash(auth.ActorId), "closed", legacy.Id[..2], legacy.Id + ".json");
        string original = File.ReadAllText(file);
        foreach (var entry in new[] { (3, version), (4, "../x"), (4, version.ToUpperInvariant()), (99, version) })
        {
            var json = JsonNode.Parse(original)!.AsObject(); json["toolContractVersion"] = entry.Item1; json["rulesCatalogVersion"] = entry.Item2;
            File.WriteAllText(file, json.ToJsonString()); byte[] before = File.ReadAllBytes(file);
            Error("harness_corrupt_run", () => store.Read(id, auth.ActorId, legacy.Id)); Check.True(before.SequenceEqual(File.ReadAllBytes(file)));
        }
        File.WriteAllText(file, original);
        var state = (await host.Get(id))!;
        var denied = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs", new HarnessInputRequest(Id(), state.Version, "新运行不能使用坏包"));
        Check.Equal(HttpStatusCode.Conflict, denied.StatusCode); Check.Equal(2, model.Calls);
    }
}
