using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessDmToolsTests
{
    private static string Publish(string root)
    {
        // Synthetic Chinese rule bodies; ratings come from the pinned, real 2024 tables.
        LocalRuleEntry Monster(string id, string name, string canonical) => new(id, "monster", name, canonical, [],
            "仅用于主持工具身份绑定的测试正文。", "XMM", 1, LocalRulesCatalog.SourceRevision, new string('a', 64), "translated");
        LocalRuleEntry[] entries = [Monster("monster:xmm:zombie", "僵尸", "Zombie"),
            Monster("monster:xmm:skeleton", "骷髅", "Skeleton"), Monster("monster:xmm:adult-red-dragon", "成年红龙", "Adult Red Dragon")];
        var counts = new[] { "spell", "class", "subclass", "feature", "species", "background", "feat", "equipment", "magic_item", "monster", "condition", "rule", "language" }
            .ToDictionary(category => category, category => new LocalRulesCount(entries.Count(e => e.Category == category), entries.Count(e => e.Category == category)));
        var package = new LocalRulesPackage(1, "dnd2024", "zh-CN", LocalRulesCatalog.SourceRevision, ["XMM"], new(false, false, ["测试库"], counts), entries);
        byte[] bytes = Encoding.UTF8.GetBytes(HarnessJson.Serialize(package)); string version = JsonFiles.Hash(bytes);
        Directory.CreateDirectory(root); JsonFiles.WriteBytes(Path.Combine(root, version + ".json"), bytes);
        JsonFiles.Write(Path.Combine(root, "active.json"), new LocalRulesPointer(version)); return version;
    }
    private static JsonElement Body(HarnessToolOutcome result) => JsonDocument.Parse(result.Reply.Content).RootElement.Clone();
    private static JsonElement Output(HarnessModelRequest request, string name) =>
        JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool" && m.Name == name).Content).RootElement.Clone();

    public static async Task AuthoritativeReadOnlyTools()
    {
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-dm-tools-" + Id()); string pin = Publish(root);
        var model = new Model((_, _) => throw new Exception("Read-only tool must not invoke model")); var dice = new SequenceDice();
        await using var host = await Host.Start(dice: dice, configure: Configure(model, extra: b => b.Configuration["LocalRules:Directory"] = root));
        var owner = await Create(host); var guest = await HarnessBoundaryTests.Guest(host, owner);
        var game = host.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
        int cursor = (await host.Get(owner.Snapshot.Id))!.Version; string intent = Id();
        string db = Path.Combine(host.Root, "campaigns", owner.Snapshot.Id + ".sqlite"); byte[] before = File.ReadAllBytes(db);
        Task<HarnessToolOutcome> Call(string tool, object args, int contract = 55) => game.HarnessTool(owner.Snapshot.Id, owner.AccessToken,
            auth.ActorId, intent, "主持参考", cursor, Id(), Id(), new(tool, HarnessJson.Element(args), Id()), [], default,
            auth.Profile, contract, rulesCatalogVersion: pin);
        foreach (string topic in new[] { "checks", "objects", "traps", "hazards", "cr" })
        {
            var result = Body(await Call("dm_reference", new { topic })); Check.Equal("dnd2024", result.GetProperty("ruleset").GetString());
            Check.True(!result.TryGetProperty("sourceRevision", out _) && !result.TryGetProperty("evidence", out _));
        }
        var checks = Body(await Call("dm_reference", new { topic = "checks" })).GetProperty("reference").GetProperty("difficultyClasses");
        Check.True(checks.EnumerateArray().Select(x => x.GetProperty("dc").GetInt32()).SequenceEqual(new[] { 5, 10, 15, 20, 25, 30 }));
        var plan = Body(await Call("encounter_plan", new { difficulty = "moderate", query = "僵尸", count = 2 }));
        Check.Equal(2, plan.GetProperty("partyLevels").GetArrayLength());
        Check.Equal(150, plan.GetProperty("budget").GetInt32());
        var zombie = plan.GetProperty("options")[0]; Check.Equal(100, zombie.GetProperty("totalXp").GetInt32());
        Check.Equal("xmm:zombie", zombie.GetProperty("executableProfileId").GetString());
        var roster = Body(await Call("encounter_plan", new { difficulty = "high", monsters = new[] { new { id = "monster:xmm:zombie", count = 2 }, new { id = "monster:xmm:skeleton", count = 2 } } }));
        Check.Equal(200, roster.GetProperty("totalXp").GetInt32()); // No legacy 2x multiplier for four monsters.
        var dragon = Body(await Call("encounter_plan", new { difficulty = "high", monsters = new[] { new { id = "monster:xmm:adult-red-dragon", count = 1 } } }));
        Check.Equal("above_high", dragon.GetProperty("estimatedDifficulty").GetString());
        Check.True(!dragon.GetProperty("roster")[0].TryGetProperty("executableProfileId", out var executable) || executable.ValueKind == JsonValueKind.Null);
        foreach (var tier in new (decimal Cr, int Min, int Max)[] { (0m, 200, 800), (5m, 800, 8000), (11m, 8000, 64000), (17m, 60000, 600000) })
        foreach (string theme in new[] { "arcana", "armaments", "implements", "relics" })
        {
            var args = new { challengeRating = tier.Cr, kind = "hoard", theme };
            var first = await Call("treasure_generate", args); var again = await Call("treasure_generate", args);
            Check.Equal(first.Reply.Content, again.Reply.Content);
            var treasure = Body(first); int amount = treasure.GetProperty("amount").GetInt32();
            Check.True(amount >= tier.Min && amount <= tier.Max); Check.Equal("gp", treasure.GetProperty("currency").GetString());
            Check.True(treasure.GetProperty("proposalOnly").GetBoolean());
            foreach (var item in treasure.GetProperty("magicItems").EnumerateArray())
                Check.True(item.GetProperty("unavailable").GetBoolean()); // Missing Chinese item records never become invented grants.
        }
        foreach (var bad in new[] { new TreasureGenerateArgs(4.5m), new TreasureGenerateArgs(31), new TreasureGenerateArgs(1, "hoard", 2) })
        {
            try { await Call("treasure_generate", bad); throw new Exception("Invalid treasure accepted"); }
            catch (GameException ex) { Check.Equal("harness_invalid_payload", ex.Code); }
        }
        try { await Call("dm_reference", new { topic = "objects" }, 54); throw new Exception("Historical contract gained a tool"); }
        catch (GameException ex) { Check.Equal("harness_tool_unavailable", ex.Code); }
        Check.True(before.SequenceEqual(File.ReadAllBytes(db))); Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
    }

    public static async Task RealPiDirectTools()
    {
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-dm-pi-" + Id()); Publish(root);
        var dice = new SequenceDice();
        var model = new Model((n, request) =>
        {
            foreach (string name in new[] { "dm_reference", "encounter_plan", "treasure_generate" })
                Check.True(request.Tools.Any(t => t.Name == name));
            if (n == 1) return Tool("dm_reference", new { topic = "objects" });
            if (n == 2) { Check.Equal("objects", Output(request, "dm_reference").GetProperty("topic").GetString()); return Tool("encounter_plan", new { difficulty = "high", query = "僵尸" }); }
            if (n == 3) { Check.Equal(50, Output(request, "encounter_plan").GetProperty("options")[0].GetProperty("xp").GetInt32()); return Tool("treasure_generate", new { challengeRating = 0.25 }); }
            Check.Equal(4, n); Check.True(Output(request, "treasure_generate").GetProperty("proposalOnly").GetBoolean());
            return Tool("ask_player", new { question = "参考方案已备好，你打算怎样行动？" });
        });
        await using var host = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        { b.Configuration["LocalRules:Directory"] = root; b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); }));
        var owner = await Create(host); int before = owner.Snapshot.Version;
        var session = await Post<AdventureSessionView>(host, owner.Snapshot.Id, "adventure/actions", new AdventureActionRequest(Id(), before, "只查看物件规则、僵尸遭遇与战利品参考，不执行"));
        var run = await Settled(host, owner.Snapshot.Id, session.SessionId, 3000);
        Check.Equal("waiting", run.Status); Check.Equal(before, run.Version); Check.Equal(0, dice.Count); Check.Equal(4, model.Calls);
        var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
        Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion);
    }
}
