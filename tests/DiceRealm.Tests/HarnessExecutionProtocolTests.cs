using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessExecutionProtocolTests
{
    internal static JsonElement Frame(HarnessModelRequest request)
    {
        var message = request.Messages.Last();
        Check.Equal("user", message.Role);
        using var doc = JsonDocument.Parse(message.Content);
        Check.Equal("execution_state", doc.RootElement.GetProperty("kind").GetString());
        Check.Equal(15, doc.RootElement.GetProperty("contract").GetInt32());
        return doc.RootElement.Clone();
    }
    internal static string Choice(HarnessModelRequest request, string label) => Frame(request).GetProperty("context")
        .GetProperty("intent").GetProperty("candidates").EnumerateArray()
        .First(c => c.GetProperty("label").GetString()!.Contains(label, StringComparison.Ordinal)).GetProperty("id").GetString()!;
    private sealed class Images : IMapImageGenerator
    {
        public bool Enabled => true;
        public string CacheIdentity => "execution-protocol-test";
        public int Calls;
        public Task<byte[]> Generate(MapGenerationJob job, CancellationToken ct) { Interlocked.Increment(ref Calls); return Task.FromResult(AssetTests.Png); }
    }
    public static Task CatalogIsShortAndFrozen()
    {
        // Captured from the pre-v15 production catalog before implementation.
        string[] frozen =
        [
            "1e9fb4d9891e507f0afa12114e9122a55fbc92fd7ad5367c4c261c17bbd05146",
            "6ac18cf35c4836acad2e06919c2de4b799aee31f68a67c5e082253d7efe9befb",
            "488b5eeb31b64448e403574ff6e6ed577e3eb03695275d3b241a01223c51ad25",
            "4b1fabef000fc6a7019d5918c407d859132eace566c146a150c330ded8dd7649",
            "d768150255c155baf375fbd4c27b3b6d9e8ae13e7c4b4dd324fcefce28d48a9a",
            "df73540bca035d30aa9bfce33f88544407190d0c3d8ee971783cd5cf2101165e",
            "19c7c6a424fccd2f2ad2a84ec6d38db16a4c7579aaf0347dd2e1352936e4398f",
            "1adde70c276a586a72a1be091e7fd7af5f237ee07ebc2496cf0a69ad2a6426e4",
            "08cda1fd41df3bb3aa648a9fea35b933c90d1fd6b06851b68abd4a15b893d20e",
            "81934bf955282d68ef2bf3546cc7bd80447c02ca55d1b5377ed9d97293755eed",
            "7f6eb0ac756062120c3562733add5c2b29c33ccead09b937d478a209abe45e48",
            "70e2203d3e22fa6c040d1c5d29eab59369e1a901837edbf0acfa2b3d20550849",
            "f554e64312c2bf27ab225884e4914b7b22a16a5a30d6d2fb00d2781fb47109ad",
            "a56f0a6f71128dc9a2ed29d977b21486d1593d52e64ea9fdb69c7a0707c6e6ac",
            "d485b67211fe15e42d159c595c79f2d54da2645a0f1cc4e89223c939b07aceec",
            "d869115a27b58b549b96d9e6188550523bc13ab6b680ebb7e3dcd5a25e36e75b",
        ];
        for (int i = 0; i < frozen.Length; i++) Check.Equal(frozen[i], HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(i))));
        Check.Equal("71f997d24717b0d312d3ea94c8b66dc90f8053944e478a1b21497bc7351f371c", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(16))));
        // Captured from the delivered v17 runtime package, not calculated from the new catalog.
        Check.Equal("9eb7fe2255c1ac9c1801e7ebf29def597386ab07c0445d7aac10674b344ae87e", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(17))));
        // Captured from the unchanged v18 assembly before the self-context implementation.
        Check.Equal("55e6caa46c36adcbb5275c9a0aa1bcd97ba3c4b2a7a5eb5bec955611d1f79f35", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(18))));
        // Captured from the delivered v21 package before these changes (not from this catalog).
        Check.Equal("320fa9e15db02497a86cfd23ddcc7149c728e22ecb9c9e1613f3b927563ab7a6", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(19))));
        Check.Equal("cdcb171324801c25b149a6002c7fd69d4a4e418a17b9acc7e3ab10b58311b3a5", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(20))));
        Check.Equal("9d9b3009031029ec499c903fd0b04aeb303d0eb5e63e1416197516cd42c09315", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(21))));
        // Captured from artifacts/ux-round2-optimization/runtime/server before v23 integration.
        Check.Equal("5545988dea775df9421177f4697c3a152e8c10ddec8be971d44b55963fc91825", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(22))));
        // Independently captured from artifacts/dm-context-fix/runtime/server before v24 edits.
        Check.Equal("10146d234bd719931fe6a3dcf86e11397db385563d9e350178f34368f3f7e1f2", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(23))));
        // Captured independently from the delivered story-intent-new-room v24 assembly.
        Check.Equal("47f4c5e2683bdfa21b75e79bb73da0be445dc73903ff614964027535a35885bd", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(24))));
        // Captured from the delivered supplies-context-optimization assembly before v26 edits.
        Check.Equal("9aee857f2fe2f2a988551920b606d17ffedcdd16cfc482c630cfa02f92cc3e7e", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(25))));
        // Captured from the delivered workbench-story-map-layout v26 assembly before board integration.
        Check.Equal("57c3e3231b127eb3c3bbd374c7f1f92b5df9fabc0c9e0f022703604274987da8", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(26))));
        // Captured independently from shared-board-tokens/delivery v27 before the flow correction.
        Check.Equal("948837f9bdee4c54cc27eb9e92482fd78e2a838aaf439c4a04e824e668e99e12", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(27))));
        // Captured independently from artifacts/map-contract/runtime-final v28 before v29 edits.
        Check.Equal("d004bf777e641e561d10844799b948055e4b6e2f5118a9121600e9d56c7cba1d", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(28))));
        // Captured from the delivered history-pagination v29 assembly before the checklist implementation.
        Check.Equal("1f98df3ad9df87b595c0b53669498aaaa3b69bc8507fc288dfded3777aa82954", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(29))));
        // v30 delivered the same frozen tool catalog as v29; only the parent frame changed.
        Check.Equal("1f98df3ad9df87b595c0b53669498aaaa3b69bc8507fc288dfded3777aa82954", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(30))));
        // Captured independently from the real-run v33 package before the v34 changes.
        Check.Equal("c5dcee88c942b9500cc296559d6a7a0a3c226c600edb188cd70ee6672ab6ed88", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(31))));
        Check.Equal("2368287e65c63202e2566ee89d2f227eb757360d5ce8fe2e9f782aaec9522196", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(32))));
        Check.Equal("4c38f080c10aa1e86069c8ca04b0ec2b7501a2fea204d0a5c6c69a3e3f395f80", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(33))));
        Check.Equal("a9dc83e21425567558450480e216b3d6d0329e126d4efcf222345810e134d872", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(34))));
        Check.Equal("00c36dd4a8cff9adc8edb6c2621d1d11155494568c38e339a2c59057ea86062d", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(35))));
        // Captured independently from the real-run runtime-v36-timeline assembly before v37.
        Check.Equal("6911d8ce66a8c88cde46724daf69b754804bff0c7c4e903657aead26275d79fd", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(36))));
        // Independently captured from the shipped player-operation-logs v37 assembly.
        Check.Equal("70db2016fbe0bf0cba52eccf8d46f9b73aa8ef8fdee473dc22003622b04543a6", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(37))));
        // Independently captured from the delivered opening-map-story-privacy v38 assembly.
        Check.Equal("93b866c3600d084529257507c90cef15fe179dad0d2ea7c3cc6e4cab4bd977d7", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(38))));
        // Independently captured from the delivered dm-position-roll-combat runtime-final v39 assembly.
        Check.Equal("464491e732ddfda7f70c45dc858433aaf03ca5ba89277893b12954eb00c8e0d7", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(39))));
        // Captured from the delivered combat-story-delivery/runtime v40 assembly, not this implementation.
        using var v40Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v40.json")));
        Check.Equal(v40Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(40)).GetRawText());
        // Independently captured from delivered combat-story-delivery/runtime-ready v41.
        using var v41Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v41.json")));
        Check.Equal(v41Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(41)).GetRawText());
        // Independently captured from delivered per-map-scale/runtime-ready v42 before knowledge visibility.
        using var v42Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v42.json")));
        Check.Equal(v42Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(42)).GetRawText());
        // Captured from the delivered workbench-combat-information runtime, before v44.
        using var v43Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v43.json")));
        Check.Equal(v43Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(43)).GetRawText());
        string v43Checklist = JsonSerializer.Deserialize<string>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-checklist-v43.json")))!;
        Check.Equal(v43Checklist, HarnessDmChecklist.InstructionsFor(43));
        // Independently captured from delivered narrative-roll-timing/runtime-ready v44.
        using var v44Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v44.json")));
        Check.Equal(v44Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(44)).GetRawText());
        // Captured independently from the delivered runtime-usage-delivery v45, not this source.
        using var v45Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v45.json")));
        Check.Equal(v45Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(45)).GetRawText());
        string v45Checklist = JsonSerializer.Deserialize<string>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-checklist-v45.json")))!;
        Check.Equal(v45Checklist, HarnessDmChecklist.InstructionsFor(45));
        // Captured from the delivered v46 assembly before this implementation.
        using var v46Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v46.json")));
        Check.Equal(v46Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(46)).GetRawText());
        string v46Checklist = JsonSerializer.Deserialize<string>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-checklist-v46.json")))!;
        Check.Equal(v46Checklist, HarnessDmChecklist.InstructionsFor(46));
        using var v47Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v47.json")));
        Check.Equal(v47Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(47)).GetRawText());
        foreach (bool combat in new[] { false, true })
        {
            string golden = JsonSerializer.Deserialize<string>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", combat ? "harness-combat-checklist-v47.json" : "harness-checklist-v47.json")))!;
            Check.Equal(golden, HarnessDmChecklist.InstructionsFor(47, combat));
            Check.True(HarnessDmChecklist.InstructionsFor(48, combat).Contains("DM允许主动向当前玩家提问"));
            Check.True(!HarnessDmChecklist.InstructionsFor(48, combat).Contains("缺失会改变后果的意图或目标才ask_player"));
        }
        // Captured independently from the shipped quick-retelling-alerts v48 runtime.
        using var v48Golden = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "harness-tools-v48.json")));
        Check.Equal(v48Golden.RootElement.GetRawText(), HarnessJson.Element(HarnessTools.ForVersion(48)).GetRawText());
        foreach (bool combat in new[] { false, true })
        {
            string golden = JsonSerializer.Deserialize<string>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", combat ? "harness-combat-checklist-v48.json" : "harness-checklist-v48.json")))!;
            Check.Equal(golden, HarnessDmChecklist.InstructionsFor(48, combat));
        }
        // Captured from the delivered roll-time-combat-ready v50 DLL, not this source tree.
        Check.Equal("96c47e3b86b5cfaf56ccc007e6f3eaf694123257c633d9462e3f3bec1b0dcd5f", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(49))));
        Check.Equal("cee03b1c43d3c624e36f22281ac059aed1cf5961bb5dc3e45a39ead75ccd6120", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(50))));
        Check.Equal("92df0c0a182ba50f0a4e7ac2d4779f78ae92b23b1bf7843214c9484755b63bc3", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(49))));
        Check.Equal("c9b1fd594d9636d6a76131872775bb473495f401de1984d1c704426788695331", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(49, true))));
        Check.Equal("224e2a59c612f23ced255631b32e7177062526eeebc973c79fd02f8a4edd245d", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(50))));
        Check.Equal("0769ce303080bd7d3b3d69cbab1c22ac0d07da74fa1c730d76835247d9a813b8", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(50, true))));
        Check.Equal("a682d76052a894a82f3bb5c64ba042e068a80db50cbe46d52fff6f06c8db0744", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(51))));
        Check.Equal("cc58c38217a0557efc2d5f7150896137e91f3e3aff0616e07f2188089df61d40", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(51))));
        Check.Equal("3ae65d4d217e33087dc935715501e58f94eaacbd595c70ea942fa4e35ad9d288", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(51, true))));
        Check.Equal("6b339fd7085256211ee08e4c4e51596dec314516102db2ba0aee0e2d451053b0", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(52))));
        Check.Equal("8074b77206d9ea14111ff63cdae16e156bb2a6387eb0720c44967d9b26a3094d", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(52, true))));
        // Independently read from the delivered agent-dm-tools-20261103 v55 assembly.
        Check.Equal("0e0f9d45dcf9b848c91a5b8e1152d1874d6162bc8580812eec18ebb719da7bba", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(55))));
        Check.Equal("6b339fd7085256211ee08e4c4e51596dec314516102db2ba0aee0e2d451053b0", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(55))));
        Check.Equal("ba2583046cc05227eb0b53e6a849f5a28eb644b5b441e5f5a63ff8dd609833ec", HarnessJson.Fingerprint(HarnessJson.Element(HarnessDmChecklist.InstructionsFor(55, true))));
        Check.Equal(59, HarnessTools.CurrentVersion);
        // v59 adds only the exploration check reference; tools and the combat checklist stay as in v58.
        Check.Equal(HarnessJson.Serialize(HarnessTools.ForVersion(58)), HarnessJson.Serialize(HarnessTools.ForVersion(59)));
        Check.Equal(HarnessDmChecklist.InstructionsFor(58) + "\n\n" + HarnessDmChecklist.CheckReferenceRule, HarnessDmChecklist.InstructionsFor(59));
        Check.Equal(HarnessDmChecklist.InstructionsFor(58, true), HarnessDmChecklist.InstructionsFor(59, true));
        // v58 changes only opening_commit's description: a later entrant's short public arrival line.
        Check.Equal(HarnessDmChecklist.InstructionsFor(57), HarnessDmChecklist.InstructionsFor(58));
        Check.Equal(HarnessDmChecklist.InstructionsFor(57, true), HarnessDmChecklist.InstructionsFor(58, true));
        Check.Equal(HarnessJson.Serialize(HarnessTools.ForVersion(57).Where(t => t.Name != "opening_commit")),
            HarnessJson.Serialize(HarnessTools.ForVersion(58).Where(t => t.Name != "opening_commit")));
        Check.True(HarnessTools.ForVersion(58).Single(t => t.Name == "opening_commit").Description.Contains("writeArrival"));
        Check.True(!HarnessTools.ForVersion(57).Single(t => t.Name == "opening_commit").Description.Contains("writeArrival"));
        Check.Equal(HarnessOpenings.EntryInstruction(57) + " " + HarnessOpenings.ArrivalRule, HarnessOpenings.EntryInstruction(58));
        // v57 adds only the exploration no-echo line; tools, combat checklist and v56 stay as they were.
        Check.Equal(HarnessJson.Serialize(HarnessTools.ForVersion(56)), HarnessJson.Serialize(HarnessTools.ForVersion(57)));
        Check.Equal(HarnessDmChecklist.InstructionsFor(56) + "\n\n" + HarnessDmChecklist.NoEchoRule, HarnessDmChecklist.InstructionsFor(57));
        Check.Equal(HarnessDmChecklist.InstructionsFor(56, true), HarnessDmChecklist.InstructionsFor(57, true));
        Check.True(!HarnessDmChecklist.InstructionsFor(56).Contains(HarnessDmChecklist.NoEchoRule, StringComparison.Ordinal));
        Check.Equal(HarnessJson.Serialize(HarnessTools.ForVersion(53)), HarnessJson.Serialize(HarnessTools.ForVersion(54)));
        Check.True(HarnessTools.ForVersion(53).Single(t => t.Name == "world_record").Description.Contains("inputContinues=true"));
        Check.True(HarnessTools.ForVersion(53).Single(t => t.Name == "combat_continue").Description.Contains("Turn-only NPC"));
        Check.True(HarnessDmChecklist.InstructionsFor(53, true).Contains("移动叙事帧暂时不提供下一步候选"));
        Check.Equal(HarnessJson.Serialize(HarnessTools.ForVersion(51)), HarnessJson.Serialize(HarnessTools.ForVersion(52)));
        Check.True(HarnessTools.ForVersion(51).Single(t => t.Name == "ctx_search").Description.StartsWith("Preferred story recall"));
        Check.True(HarnessTools.ForVersion(51).Single(t => t.Name == "encounter_prepare").Description.Contains("not legal occupied cells"));
        Check.True(HarnessDmChecklist.InstructionsFor(51, true).Contains("自动队列为空不等于完整玩家意图已完成"));
        Check.True(HarnessTools.ForVersion(50).Single(t => t.Name == "check_request").Description.Contains("MUST include dc"));
        Check.True(HarnessDmChecklist.InstructionsFor(50).Contains("必须在投掷前明确DC"));
        Check.True(!HarnessTools.ForVersion(48).Any(t => t.Name == "combat_continue"));
        Check.True(HarnessTools.ForVersion(49).Any(t => t.Name == "combat_continue"));
        Check.True(HarnessDmChecklist.InstructionsFor(49, true).Contains("combat_continue"));
        Check.True(!HarnessTools.ForVersion(45).Single(t => t.Name == "encounter_prepare").InputSchema.GetProperty("properties").TryGetProperty("encounterId", out _));
        Check.True(HarnessTools.ForVersion(46).Single(t => t.Name == "encounter_prepare").InputSchema.GetProperty("properties").TryGetProperty("encounterId", out _));
        Check.True(!HarnessTools.ForVersion(43).Single(t => t.Name == "check_request").InputSchema.GetRawText().Contains("checkType"));
        Check.True(HarnessTools.ForVersion(44).Single(t => t.Name == "check_request").InputSchema.GetRawText().Contains("checkType"));
        Check.True(!HarnessTools.ForVersion(42).Single(t => t.Name == "world_record").InputSchema.GetRawText().Contains("privateMessages"));
        Check.True(HarnessTools.ForVersion(43).Single(t => t.Name == "world_record").InputSchema.GetRawText().Contains("privateMessages"));
        Check.True(!HarnessTools.ForVersion(41).Any(t => t.Name == "map_select"));
        Check.True(HarnessTools.ForVersion(42).Any(t => t.Name == "map_select"));
        Check.True(HarnessTools.ForVersion(40).Single(t => t.Name == "check_request").Description != HarnessTools.ForVersion(39).Single(t => t.Name == "check_request").Description);
        Check.True(HarnessTools.ForVersion(39).Single(t => t.Name == "token_move").Description != HarnessTools.ForVersion(38).Single(t => t.Name == "token_move").Description);
        Check.True(!HarnessTools.ForVersion(37).Any(t => t.Name is "opening_commit" or "story_shared_read"));
        Check.True(HarnessTools.ForVersion(38).Any(t => t.Name == "opening_commit"));
        Check.True(HarnessTools.ForVersion(38).Any(t => t.Name == "story_shared_read"));
        Check.True(HarnessTools.ForVersion(36).Any(t => t.Name == "combat_delegate"));
        Check.True(!HarnessTools.ForVersion(35).Any(t => t.Name == "combat_delegate"));
        Check.True(HarnessTools.ForVersion(35).Any(t => t.Name == "encounter_prepare"));
        Check.True(!HarnessTools.ForVersion(34).Any(t => t.Name == "encounter_prepare"));
        Check.Equal(HarnessDmChecklist.Text, HarnessDmChecklist.InstructionsFor(34));
        Check.Equal(HarnessDmChecklist.Text.Split("# 本轮能力入口与执行边界")[0], HarnessDmChecklist.InstructionsFor(35).Split("# 本轮能力入口与执行边界")[0]);
        Check.True(HarnessTools.ForVersion(31).Any(t => t.Name == "check_request"));
        Check.True(!HarnessTools.ForVersion(30).Any(t => t.Name == "check_request"));
        Check.Equal(HarnessTools.ForVersion(26).Length + 6, HarnessTools.ForVersion(27).Length);
        int oldLength = HarnessTools.ForVersion(14).Sum(t => t.Description.Length);
        int newLength = HarnessTools.ForVersion(26).Sum(t => t.Description.Length); // v27 adds six distinct capabilities, not longer legacy tools
        Check.True(newLength * 3 < oldLength, $"Descriptions {newLength}/{oldLength}");
        Check.Equal(HarnessTools.ForVersion(14).Length, HarnessTools.All.Length);
        return Task.CompletedTask;
    }
    public static async Task MissingEncounterAndAuthoredRoutesLeadToRuling()
    {
        const string question = "公开敌人准备实施攻击；本场景无自动遭遇，请裁定该攻击，不预先判命中或落空。";
        var model = new Model((call, request) =>
        {
            var frame = Frame(request);
            Check.True(frame.GetProperty("workingContext").GetProperty("guidance").GetString()!.Contains("攻击入口=ruling_request"));
            if (call == 1) return Tool("world_routes");
            var result = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content).RootElement;
            Check.Equal("current_scene_authored_and_dynamic", result.GetProperty("scope").GetString());
            Check.True(result.GetProperty("routes").EnumerateArray().Any(r => r.GetProperty("source").GetString() == "authored" && r.GetProperty("canTravel").GetBoolean()));
            return Tool("ruling_request", new { question });
        });
        var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); }));
        var document = TestContent.Document with { Scenes = TestContent.Document.Scenes.Select(s => s.Id == "harbor"
            ? s with { Exits = [new("causeway", new(), 600)] } : s).ToArray() };
        var owner = await Create(h, document); string id = owner.Snapshot.Id;
        await Post<ActionResponse>(h, id, "characters/adjust", new AdjustCharacterRequest(Id(), owner.Snapshot.Version, "player",
            "隔离回归：倒地但没有活动战斗", "test fixture", [new("condition", "Prone", 1)]));
        // This is the v28 fallback contract; v35+ can prepare encounters and v36+ delegates combat.
        var run = await StartHistorical(h, id, new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "面对公开敌人，继续尝试前进。"), 28);
        run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "waiting", run.Status + "/" + run.Error); Check.Equal("ruling", run.Wait!.Kind);
        var state = (await h.Get(id))!;
        Check.Equal(question, state.PendingRulings.Single(r => r.Id == run.Wait.Id).Reason);
        Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), state.Version))).StatusCode);
    }

    public static async Task DirectActionAndMapUseFreshFramesThroughPi()
    {
        int initialVersion = 0;
        var model = new Model((call, request) =>
        {
            var frame = Frame(request);
            Check.Equal(Preset.SystemPrompt, request.System);
            Check.True(!frame.GetProperty("context").GetRawText().Contains("PRIVATE_PROTOCOL_SENTINEL", StringComparison.Ordinal));
            Check.True(frame.GetProperty("workingContext").GetProperty("dmOnly").GetRawText().Contains("PRIVATE_PROTOCOL_SENTINEL", StringComparison.Ordinal));
            Check.Equal("ready", frame.GetProperty("phase").GetString());
            var ids = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray().Select(c => c.GetProperty("id").GetString()).ToArray();
            var schemaIds = request.Tools.Single(t => t.Name == "actions_propose").InputSchema.GetProperty("properties").GetProperty("candidateId").GetProperty("enum").EnumerateArray().Select(x => x.GetString()).ToArray();
            Check.True(ids.SequenceEqual(schemaIds));
            if (call == 1) { initialVersion = frame.GetProperty("version").GetInt32(); return Tool("actions_propose", new { candidateId = Choice(request, "观察") }); }
            Check.Equal(initialVersion + 2, frame.GetProperty("version").GetInt32());
            if (call == 2) return Tool("map_request", new { kind = "settlement", purpose = "settlement" });
            Check.Equal(3, call);
            return Text("已经观察，示意图请求已保存。");
        });
        var images = new Images(); var dice = new SequenceDice();
        var configure = Configure(model, extra: b => { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(images: images, dice: dice, configure: configure);
        try
        {
            var owner = await Create(h, TestContent.Document with { SourceText = "PRIVATE_PROTOCOL_SENTINEL", InitialKnowledge = [new("hidden-protocol", "clue", "主持秘密", "PRIVATE_PROTOCOL_SENTINEL", "harbor", "host")] });
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "观察当前地点并提供地图");
            var run = await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request);
            run = await Settled(h, owner.Snapshot.Id, run.Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            Check.Equal(3, model.Calls); Check.Equal(0, dice.Count);
            Check.Equal(1, (await h.Get(owner.Snapshot.Id))!.Events.Count(e => e.Kind == "observe"));
            await AssetTests.Until(() => Task.FromResult(images.Calls == 1));
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
            Check.True(saved.Steps.All(s => s.ToolName is not ("context_read" or "actions_list")), "No model-funded refresh ceremony");
            var encoded = HarnessJson.Element(saved);
            Check.True(encoded.GetProperty("steps").EnumerateArray().Where(s => s.GetProperty("kind").GetString() == "model").All(s => s.TryGetProperty("executionFrame", out _)));
            string original = HarnessJson.Serialize(saved);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request)).Replayed);
            Check.Equal(3, model.Calls); Check.Equal(1, images.Calls); Check.Equal(0, dice.Count);
            Check.Equal(original, HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!));
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task SameBatchCannotReuseExpiredAuthority()
    {
        var model = new Model((call, request) =>
        {
            if (call == 1)
            {
                string id = Choice(request, "观察");
                return new("", [new("first", "actions_propose", HarnessJson.Element(new { candidateId = id })), new("stale", "actions_propose", HarnessJson.Element(new { candidateId = id }))], 10, 10);
            }
            Check.Equal(2, call);
            using var output = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content);
            Check.Equal("refresh_required", output.RootElement.GetProperty("protocol").GetProperty("phase").GetString());
            Check.True(!output.RootElement.GetProperty("protocol").GetProperty("applied").GetBoolean());
            Check.True(Frame(request).GetProperty("context").GetProperty("intent").GetProperty("candidates").GetArrayLength() > 0);
            return Text("只执行了一次观察。");
        });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        var run = await Start(h, owner.Snapshot, "观察"); run = await Settled(h, owner.Snapshot.Id, run.Id);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error);
        Check.Equal(1, (await h.Get(owner.Snapshot.Id))!.Events.Count(e => e.Kind == "observe"));
        Check.Equal(2, model.Calls);
    }
    public static async Task FrameAuthorityIsReadOnlyAndCorruptionFailsClosed()
    {
        var dice = new SequenceDice(); var model = new Model((_, _) => Text());
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(h);
        var game = h.App.Services.GetRequiredService<GameService>();
        var guest = await HarnessBoundaryTests.Guest(h, owner);
        var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
        string path = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite");
        byte[] before = File.ReadAllBytes(path);
        var frame = await game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "观察", auth.Version, default);
        Check.True(frame.Context.Intent.Candidates.Length > 0); Check.Equal(0, model.Calls); Check.Equal(0, dice.Count);
        var denied = await game.HarnessTool(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "观察", auth.Version,
            Id(), "expired-frame", new("actions_propose", HarnessJson.Element(new { candidateId = frame.Context.Intent.Candidates[0].Id }), "stale"),
            frame.Context.Intent.Candidates.Select(c => c.Id).ToArray(), default, auth.Profile, 15, false);
        Check.Equal("refresh_required", JsonDocument.Parse(denied.Reply.Content).RootElement.GetProperty("protocol").GetProperty("phase").GetString());
        Check.True(before.SequenceEqual(File.ReadAllBytes(path)), "Frame/read rejection must not even rewrite the campaign database");
        async Task Reject(Func<Task> action, string code)
        {
            try { await action(); throw new Exception("Expected refusal"); }
            catch (GameException e) { Check.Equal(code, e.Code); }
        }
        await Reject(() => game.ReadHarnessExecution(owner.Snapshot.Id, guest.AccessToken, auth.ActorId, Id(), "观察", auth.Version, default), "unauthorized");
        await Reject(() => game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "观察", auth.Version - 1, default), "stale_version");
        Check.True(before.SequenceEqual(File.ReadAllBytes(path))); Check.Equal(0, model.Calls);
        var blocked = HarnessExecutionProtocol.Capture(frame.Version, frame.Context with { CanNarrate = false, Intent = frame.Context.Intent with { Candidates = [] } }, frame.Combat);
        var projected = HarnessExecutionProtocol.Project(new(Preset.SystemPrompt, [new("user", "原文")], HarnessTools.All, 4096), blocked);
        Check.True(projected.Tools.All(t => t.Name is not ("world_record" or "actions_propose")));
        var run = await Start(h, (await h.Get(owner.Snapshot.Id))!, "只读完毕"); run = await Settled(h, owner.Snapshot.Id, run.Id);
        Check.Equal("completed", run.Status);
        string file = Directory.GetFiles(Path.Combine(h.Root, "harness"), run.Id + ".json", SearchOption.AllDirectories).Single();
        string original = File.ReadAllText(file);
        var store = h.App.Services.GetRequiredService<HarnessRunStore>();
        foreach (var damage in new Action<System.Text.Json.Nodes.JsonObject>[]
        {
            step => step.Remove("executionFrame"),
            step => step["executionFrame"]!.AsObject().Remove("dmChecklist"),
            step => step["executionFrame"]!["dmChecklist"]!["instructions"] = "只检查移动与投掷",
            step => step["executionFrame"]!["dmChecklist"]!["progress"]!["intentId"] = Id(),
            step => step["executionFrame"]!["dmChecklist"]!["progress"]!["actorId"] = "another-seat",
            step => step["executionFrame"]!["dmChecklist"]!["progress"]!["version"] = run.Version + 1,
            step => step["executionFrame"]!["contract"] = 14,
            step => step["executionFrame"]!["version"] = run.Version + 1,
            step => step["executionFrame"]!["map"] = null,
            step => step["executionFrame"]!["map"]!["prompt"] = "untrusted",
            step => step["executionFrame"]!["map"]!.AsObject().Remove("generationEnabled"),
            step => step["executionFrame"]!["map"]!["status"] = "invented",
            step => step["executionFrame"]!["map"]!["sceneId"] = "hidden-scene",
            step => step["executionFrame"]!["context"]!["intent"]!["candidates"] = null,
            step => step["executionFrame"]!["availableTools"] = new System.Text.Json.Nodes.JsonArray("context_read", "context_read")
        })
        {
            var json = System.Text.Json.Nodes.JsonNode.Parse(original)!;
            damage(json["steps"]![0]!.AsObject());
            File.WriteAllText(file, json.ToJsonString()); byte[] corrupt = File.ReadAllBytes(file);
            Check.Throws<GameException>(() => store.Read(owner.Snapshot.Id, auth.ActorId, run.Id));
            Check.True(corrupt.SequenceEqual(File.ReadAllBytes(file))); Check.Equal(1, model.Calls);
        }
        File.WriteAllText(file, original);
    }

    private sealed class Wire(Func<JsonElement, HttpResponseMessage> response) : HttpMessageHandler
    {
        public List<JsonElement> Bodies { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage message, CancellationToken ct)
        {
            using var doc = JsonDocument.Parse(await message.Content!.ReadAsStringAsync(ct));
            Bodies.Add(doc.RootElement.Clone()); return response(doc.RootElement);
        }
    }
    public static Task ProviderFramesPreserveNativeHistoryAndCompaction() => ProviderFrames(15);
    public static Task ProviderSelfFramesPreserveNativeHistoryAndCompaction() => ProviderFrames(19);
    public static async Task ProviderDmChecklistFramesPreserveNativeHistoryAndCompaction()
    {
        await ProviderFrames(29); // Historical provider frames must not acquire the new checklist.
        await ProviderFrames(30);
    }
    private static async Task ProviderFrames(int toolVersion)
    {
        await using var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("No game model"))));
        var owner = await Create(h); var game = h.App.Services.GetRequiredService<GameService>();
        var frame = await game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken, PartyEngine.HostId, Id(), "观察中文", owner.Snapshot.Version, default, toolVersion);
        var initial = new HarnessModelRequest(Preset.SystemPrompt, [new("user", toolVersion >= 23
            ? HarnessJson.Serialize(new { input = "观察中文", ruleset = "dnd2024", memory = new { } }) : "用户字面\\u4e2d不能改")],
            HarnessTools.ForVersion(toolVersion), 4096);
        string original = HarnessJson.Serialize(initial);
        if (toolVersion == 30)
            Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame, frame.Version, 29));
        foreach (string protocol in new[] { "gemini", "openai-chat" })
        {
            var config = new Microsoft.Extensions.Configuration.ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["DataPath"] = Path.Combine(Path.GetTempPath(), "execution-provider-" + Id()),
                ["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/v1", ["HarnessAi:Endpoint"] = protocol,
                ["HarnessAi:Model"] = "isolated-model", ["HarnessAi:ApiKey"] = "fake-execution-key", ["HarnessAi:RetryCount"] = "0"
            }).Build();
            using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
            object[] parts = [new { text = "私有模拟thought", thought = true, thoughtSignature = "c2lnbg==" },
                new { functionCall = new { id = "scope", name = "rules_scope", args = new { } }, thoughtSignature = "c2lnbg==" }];
            using var wire = new Wire(_ => new(HttpStatusCode.OK) { Content = JsonContent.Create(protocol == "gemini" ?
                (object)new { candidates = new[] { new { finishReason = "STOP", content = new { role = "model", parts } } } } :
                new { choices = new[] { new { finish_reason = "tool_calls", message = new { content = "", tool_calls = new[] { new { id = "scope", type = "function", function = new { name = "rules_scope", arguments = "{}" } } } } } } }) });
            using var http = new HttpClient(wire);
            IHarnessModel adapter = protocol == "gemini" ? new GeminiHarnessModel(http, config, budget) : new OpenAiHarnessModel(http, config, budget);
            var projected = HarnessExecutionProtocol.Project(initial, frame, toolVersion);
            if (toolVersion >= 30) HarnessDmChecklistTests.AssertRequest(projected);
            var reply = await adapter.Complete(projected, Id(), default);
            var firstMessages = wire.Bodies[0].GetProperty(protocol == "gemini" ? "contents" : "messages");
            string firstText = protocol == "gemini" ? firstMessages[firstMessages.GetArrayLength() - 1].GetProperty("parts")[0].GetProperty("text").GetString()! : firstMessages[firstMessages.GetArrayLength() - 1].GetProperty("content").GetString()!;
            using var firstFrame = JsonDocument.Parse(firstText);
            Check.Equal(toolVersion >= 19, firstFrame.RootElement.TryGetProperty("self", out var firstSelf));
            if (toolVersion >= 19)
            {
                Check.Equal(owner.Snapshot.Character!.Id, firstSelf.GetProperty("id").GetString());
                if (toolVersion < 23)
                {
                    Check.Equal(6, firstSelf.GetProperty("abilities").GetArrayLength());
                    Check.Equal(18, firstSelf.GetProperty("skills").GetArrayLength());
                }
                Check.Equal(owner.Snapshot.Character.Inventory.Length, firstSelf.GetProperty("inventory").GetArrayLength());
            }
            if (toolVersion >= 30) HarnessDmChecklistTests.AssertFrame(firstFrame.RootElement);
            else Check.True(!firstFrame.RootElement.TryGetProperty("dmChecklist", out _));
            // SDK transcript does not contain the transient execution frame from the first call.
            var sdk = initial with { Messages = [.. initial.Messages, new("assistant", reply.Text, reply.ToolCalls), new("tool", "{}", ToolCallId: "scope", Name: "rules_scope")],
                ProviderHistory = [new(reply, reply.ProviderContinuation)] };
            var next = HarnessExecutionProtocol.Project(sdk, frame, toolVersion);
            if (toolVersion >= 30) HarnessDmChecklistTests.AssertRequest(next);
            await adapter.Complete(next, Id(), default);
            var sent = wire.Bodies.Last();
            var messages = sent.GetProperty(protocol == "gemini" ? "contents" : "messages");
            string last = protocol == "gemini" ? messages[messages.GetArrayLength() - 1].GetProperty("parts")[0].GetProperty("text").GetString()! : messages[messages.GetArrayLength() - 1].GetProperty("content").GetString()!;
            using var current = JsonDocument.Parse(last); Check.Equal("execution_state", current.RootElement.GetProperty("kind").GetString());
            if (toolVersion >= 30) HarnessDmChecklistTests.AssertFrame(current.RootElement);
            Check.True(last.Contains("观察中文", StringComparison.Ordinal));
            if (toolVersion >= 19) Check.Equal(firstSelf.GetRawText(), current.RootElement.GetProperty("self").GetRawText());
            var declarations = protocol == "gemini" ? sent.GetProperty("tools")[0].GetProperty("functionDeclarations") : sent.GetProperty("tools");
            var action = declarations.EnumerateArray().Select(t => protocol == "gemini" ? t : t.GetProperty("function")).Single(t => t.GetProperty("name").GetString() == "actions_propose");
            Check.True(action.GetProperty(protocol == "gemini" ? "parametersJsonSchema" : "parameters").GetProperty("properties").GetProperty("candidateId").GetProperty("enum").GetArrayLength() > 0);
            if (protocol == "gemini") Check.Equal(HarnessJson.Fingerprint(HarnessJson.Element(parts)), HarnessJson.Fingerprint(messages[1].GetProperty("parts")));
            Check.Equal(original, HarnessJson.Serialize(initial));
        }
        var history = new List<HarnessModelExchange>(); var transcript = initial.Messages.ToList();
        for (int i = 0; i < 8; i++)
        {
            var reply = Tool("skills_read", new { id = "test-skill" }, "large-" + i);
            transcript.Add(new("assistant", reply.Text, reply.ToolCalls)); transcript.Add(new("tool", new string('文', 8000), ToolCallId: "large-" + i, Name: "skills_read"));
            history.Add(new(reply, null));
        }
        var full = initial with { Messages = transcript.ToArray(), ProviderHistory = history.ToArray() };
        string unchanged = HarnessJson.Serialize(full);
        var compacted = HarnessContextCompactor.Prepare(HarnessExecutionProtocol.Project(full, frame, toolVersion), providerEncoding: toolVersion >= 23);
        if (toolVersion >= 30) HarnessDmChecklistTests.AssertRequest(compacted.Request);
        Check.True(compacted.Plan is not null); HarnessContextCompactor.Validate(compacted.Plan!);
        Check.Equal(frame.Version, Frame(compacted.Request).GetProperty("version").GetInt32());
        Check.Equal(toolVersion >= 19, Frame(compacted.Request).TryGetProperty("self", out _));
        Check.Equal(unchanged, HarnessJson.Serialize(full)); Check.Equal(Preset.SystemPrompt, compacted.Request.System);
    }

    public static async Task ConsentStopsBatchAndResumeRefreshesWithoutRead()
    {
        var dice = new SequenceDice(18);
        var model = new Model((call, request) =>
        {
            if (call == 1) return new("", [new("check", "actions_propose", HarnessJson.Element(new { candidateId = Choice(request, "调查") })),
                new("forbidden-followup", "world_record", HarnessJson.Element(new NarrativeHarnessArgs("不可提前保存。", [])))], 10, 10);
            Check.Equal(2, call); Frame(request);
            Check.True(request.Messages.Any(m => m.Role == "user" && m.Content.Contains("confirmedResult", StringComparison.Ordinal)));
            return Text("仅根据真实确认结果继续。");
        });
        var configure = Configure(model, extra: b => { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var run = await Start(h, owner.Snapshot, "调查"); run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error); Check.Equal(0, dice.Count); Check.Equal(1, model.Calls);
            var waiting = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(0, waiting.ContextReadVersion); Check.Equal(0, waiting.OfferedIds.Length); Check.True(waiting.OfferedMemoryIds is null);
            var waitingProtocol = JsonDocument.Parse(waiting.Steps.Single(s => s.ToolName == "actions_propose").Outcome!.Reply.Content).RootElement.GetProperty("protocol");
            Check.Equal("awaiting_player", waitingProtocol.GetProperty("phase").GetString());
            Check.Equal(run.Wait!.Id, waitingProtocol.GetProperty("wait").GetProperty("id").GetString());
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version))).StatusCode);
            var state = (await h.Get(id))!;
            Check.True(state.Events.All(e => e.Narrative != "不可提前保存。"));
            var rolled = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), state.Version, run.Wait!.Id, "roll"));
            Check.Equal(1, dice.Count); Check.Equal(1, model.Calls);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var resume = new HarnessResumeRequest(Id(), rolled.Snapshot.Version);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            Check.Equal(2, model.Calls); Check.Equal(1, dice.Count);
            Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            Check.Equal(2, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
