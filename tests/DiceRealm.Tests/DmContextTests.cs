using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class DmContextTests
{
    private static AdventureContext Context(Campaign c, string input = "询问莫娜明早出发和帮手") =>
        AdventureDirecting.Build(c, IntentContexts.Build(c, input, [], []));

    public static Task ObjectiveRevealAndLegacyBytes()
    {
        var original = TestContent.Document;
        string before = HarnessJson.Serialize(original);
        Check.True(!before.Contains("\"visible\":null"));
        var quest = original.Quests[0] with
        {
            Visible = new(), Active = new(), Objectives =
            [new("找回守灯人", new()), new("GREEN_OBJECTIVE_SENTINEL", new()) { Visible = new() { Any = ["reveal-only", "visited:causeway"] } }]
        };
        var c = TestContent.Campaign(); c.Adventure = original with { Quests = [quest] };
        ContentValidator.Validate(c.Adventure);
        Check.Equal(1, ContentRuntime.World(c).Quests.Single().Objectives.Length);
        Check.True(!HarnessJson.Serialize(Context(c)).Contains("GREEN_OBJECTIVE_SENTINEL"));
        Check.True(!HarnessJson.Serialize(StoryEngine.Snapshot(c)).Contains("GREEN_OBJECTIVE_SENTINEL"));
        c.Facts.Add("reveal-only");
        Check.Equal(2, ContentRuntime.World(c).Quests.Single().Objectives.Length);
        Check.True(HarnessJson.Serialize(Context(c)).Contains("GREEN_OBJECTIVE_SENTINEL"));
        c.Facts.Clear(); c.VisitedScenes.Add("causeway");
        Check.Equal(2, ContentRuntime.World(c).Quests.Single().Objectives.Length);
        c.Adventure = original;
        Check.Equal(before, HarnessJson.Serialize(c.Adventure));
        Check.Equal("{\"text\":\"legacy\",\"complete\":{\"all\":[],\"any\":[],\"none\":[]}}", HarnessJson.Serialize(new ContentObjective("legacy", new())));
        var invalid = original with { Quests = [quest with { Objectives = [new("bad", new()) { Visible = new() { All = ["visited:not-a-scene"] } }] }] };
        Check.Throws<GameException>(() => ContentValidator.Validate(invalid));
        return Task.CompletedTask;
    }

    public static Task SceneKnowledgeHasSourcesAndNarrowPrivateBoundary()
    {
        var c = TestContent.Campaign();
        c.Adventure = c.Adventure! with
        {
            SourceText = "NEVER_FULL_SOURCE",
            Npcs = [new("mona", "莫娜", "harbor", "", "利落直率。", new(), new(), [])],
            InitialKnowledge = [
                new("mona-host", "npc", "莫娜主持资料", "担心船只安全，没有明确今晚期限。", "harbor", "host"),
                new("else-host", "clue", "别处秘密", "NEVER_OTHER_SCENE", "causeway", "host"),
                new("hidden-host", "clue", "隐藏资料", "NEVER_HIDDEN", "harbor", "host"),
                new("mona-world", "npc", "莫娜", "莫娜说会在事成后付报酬，尚未支付。", "harbor", "public"),
                new("later-arrival", "clue", "未来见闻", "NEVER_ARRIVAL", "causeway", "arrival", "causeway")]
        };
        WorldMemories.Seed(c, c.Version);
        var index = WorldMemoryIndex.For(c);
        index.Upsert(WorldMemories.Find(c, "hidden-host")! with { Hidden = true });
        index.Upsert(new("not-imported", "clue", "主持后来私记", "NEVER_UNLISTED", "known", "harbor", 1, 0, c.Version, PartyEngine.HostId, "dm", Visibility: "host"));
        index.Upsert(new("unlocated-promise", "clue", "莫娜的承诺", "莫娜说事成后付报酬，不是预付。", "known", "", 1, 0, c.Version, PartyEngine.HostId, "harness"));
        var context = Context(c); var working = HarnessSceneContexts.Build(c, context);
        Check.Equal(1, working.People.Length); Check.Equal("npc:mona", working.People[0].Id);
        Check.Equal(2, working.People[0].Sources.Length);
        Check.True(working.PublicEvidence.Any(e => e.Id == "unlocated-promise" && e.Nature == "model_record"));
        Check.Equal(1, working.DmOnly.Length); Check.Equal("mona-host", working.DmOnly[0].Id);
        string encoded = HarnessJson.Serialize(working);
        Check.True(!encoded.Contains("NEVER_"));
        Check.True(!HarnessJson.Serialize(context).Contains("没有明确今晚期限"));
        Check.True(!HarnessJson.Serialize(HarnessWorldSearch.Search(c, new(""), 23)).Contains("没有明确今晚期限"));
        Check.True(HarnessWorldSearch.Search(c, new("不存在的查询"), 23).Coverage!.Contains("unknown"));
        index.Upsert(WorldMemories.Find(c, "mona-host")! with { Summary = "更正后仍无硬期限。", Revision = 2 });
        Check.Equal("更正后仍无硬期限。", HarnessSceneContexts.Build(c, context).DmOnly.Single().Summary);
        index.Upsert(WorldMemories.Find(c, "mona-host")! with { Hidden = true });
        Check.Equal(0, HarnessSceneContexts.Build(c, context).DmOnly.Length);
        return Task.CompletedTask;
    }

    public static Task RetrievalPrioritizesPublicNamesAndLiteralTargets()
    {
        var c = TestContent.Campaign(); WorldMemories.Seed(c, c.Version);
        var context = Context(c, "我沿已发现的西北方小径前往克拉摩巢穴。路上小心脚下。");
        var current = HarnessSceneContexts.Build(c, context, 28);
        var terms = current.Coverage.PublicReads.Where(r => r.Scope == "unlocated_input").SelectMany(r => r.Words).ToArray();
        Check.Equal("克拉摩巢穴", terms[0]); Check.Equal(4, terms.Length);
        var old = HarnessSceneContexts.Build(c, context, 27);
        Check.Equal("我沿", old.Coverage.PublicReads.First(r => r.Scope == "unlocated_input" && r.Words.Single().Length == 2).Words.Single());
        var known = context with { KnownScenes = [new("harbor", "西北方小径")], KnownMemory = [] };
        terms = HarnessSceneContexts.Build(c, known, 28).Coverage.PublicReads.Where(r => r.Scope == "unlocated_input").SelectMany(r => r.Words).ToArray();
        Check.Equal("西北方小径", terms[0]); Check.Equal("克拉摩巢穴", terms[1]);
        Check.Equal(0, c.Facts.Count); Check.Equal(0L, c.ElapsedSeconds);
        return Task.CompletedTask;
    }

    public static async Task CompactFrameAndOptionalDetailsThroughPi()
    {
        // A pinned local Chinese-name fixture, not an invented translation fallback.
        string rules = Path.Combine(Path.GetTempPath(), "dm-context-rules-" + Id()); Directory.CreateDirectory(rules);
        var entry = new LocalRuleEntry(ItemMetadata.Find("rope", null)!.Id, "equipment", "绳索", "Rope", ["麻绳"], "绳索的本地测试正文。",
            "XPHB", 0, LocalRulesCatalog.SourceRevision, new string('a', 64), "translated");
        var counts = new[] { "spell", "class", "subclass", "feature", "species", "background", "feat", "equipment", "magic_item", "monster", "condition", "rule", "language" }
            .ToDictionary(k => k, k => new LocalRulesCount(k == "equipment" ? 1 : 0, k == "equipment" ? 1 : 0));
        var package = new LocalRulesPackage(1, "dnd2024", "zh-CN", LocalRulesCatalog.SourceRevision, ["XPHB"], new(false, false, ["fixture"], counts), [entry]);
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(HarnessJson.Serialize(package)); string hash = JsonFiles.Hash(bytes);
        JsonFiles.WriteBytes(Path.Combine(rules, hash + ".json"), bytes); JsonFiles.Write(Path.Combine(rules, "active.json"), new LocalRulesPointer(hash));
        JsonElement first = default; Exception? failure = null;
        var model = new Model((call, request) =>
        {
            try
            {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            if (call == 1)
            {
                first = frame.Clone();
                Check.True(!frame.GetProperty("self").TryGetProperty("spellRoutes", out _));
                Check.True(frame.GetProperty("self").GetProperty("inventory").GetArrayLength() > 0);
                var itemSchema = request.Tools.Single(t => t.Name == "world_record").InputSchema.GetProperty("properties").GetProperty("items").GetProperty("items").GetProperty("properties").GetProperty("itemId");
                Check.True(!itemSchema.TryGetProperty("enum", out _));
                return Tool("context_read", new { scope = "character" });
            }
            using var tool = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content);
            if (call == 2)
            {
                var full = tool.RootElement.GetProperty("self");
                Check.Equal(6, full.GetProperty("abilities").GetArrayLength()); Check.Equal(18, full.GetProperty("skills").GetArrayLength());
                Check.True(full.GetProperty("spellRoutes").GetArrayLength() > 0);
                Check.True(first.GetProperty("self").GetRawText().Length < full.GetRawText().Length);
                return Tool("context_read", new { scope = "items", query = "麻绳" });
            }
            Check.Equal(3, call);
            Check.True(tool.RootElement.GetProperty("entries").EnumerateArray().Any(e => e.GetProperty("itemId").GetString() == "rope"));
            return Tool("world_record", new NarrativeHarnessArgs("她听完了打算，没有替你作出下一步决定。", []));
            }
            catch (Exception error) { failure = error; throw; }
        });
        await using var h = await Host.Start(configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Configuration["LocalRules:Directory"] = rules;
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        var owner = await Create(h, template: CharacterEngine.Wizard);
        var run = await Settled(h, owner.Snapshot.Id, (await Start(h, owner.Snapshot, "先和她聊聊明早的打算")).Id, 3000);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + failure); Check.Equal(3, model.Calls);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
        Check.True(saved.Steps.First().ExecutionFrame!.Self!.SpellRoutes.Length > 0, "Full self is still durable, not destructively pruned");
    }

    public static async Task ContinuityPersistsWithoutChangingFullHistory()
    {
        int calls = 0;
        var model = new Model((_, request) =>
        {
            calls++;
            if (calls == 4)
            {
                // Contract 45+: saved continuity is an actor-only, source-addressed model_reported_* part
                // beside the unchanged public narrative, never a replacement for it or a verified fact.
                using var initial = JsonDocument.Parse(request.Messages[0].Content);
                var audiences = initial.RootElement.GetProperty("memory").GetProperty("audiences").EnumerateArray().ToArray();
                JsonElement[] Raw(bool shared) => audiences.Single(a => (a.GetProperty("audience").GetString() == "public") == shared).GetProperty("raw").EnumerateArray().ToArray();
                Check.True(Raw(false).Any(p => p.GetProperty("kind").GetString() == "model_reported_open_question" && p.GetProperty("text").GetString()!.Contains("尚未答应")));
                Check.True(Raw(true).All(p => !p.GetProperty("kind").GetString()!.StartsWith("model_reported_")), "continuity notes stay actor-only");
                Check.True(Raw(true).Any(p => p.GetProperty("text").GetString()!.Contains("DECORATIVE_GESTURE_1")), "full narrative is kept");
            }
            return Tool("world_record", new NarrativeHarnessArgs("DECORATIVE_GESTURE_" + calls + "。莫娜说：“事成后再付酬劳。”", [],
                Private: "PRIVATE_NOTE_SENTINEL", Continuity: [new("promise", "莫娜提出事成后付酬劳，尚未支付。"), new("open_question", "玩家尚未答应，询问能否明早出发。")],
                Items: calls == 1 ? [new("rope", "", 1, new("current_scene", "harbor", HarnessItemSearchTests.StockEvidence))] : null));
        });
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h, HarnessItemSearchTests.WithEvidence(HarnessItemSearchTests.StockEvidence)); HarnessRunView run = null!; string firstIntent = "";
            for (int i = 0; i < 4; i++)
            {
                var snapshot = (await h.Get(owner.Snapshot.Id))!;
                run = await Settled(h, snapshot.Id, (await Start(h, snapshot, "第" + i + "次交谈")).Id);
                Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + model.Failure);
                if (i == 0) firstIntent = run.IntentId;
            }
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
            Check.True(saved.MemorySnapshot!.Entries[0].Narrative.Contains("DECORATIVE_GESTURE_1"));
            var game = h.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
            var recalled = await game.HarnessTool(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "核实", auth.Version, Id(), Id(),
                new("memory_read", HarnessJson.Element(new HarnessMemoryReadArgs(firstIntent)), "read"), [], default, auth.Profile, 23, true);
            using var recall = JsonDocument.Parse(recalled.Reply.Content);
            var entry = recall.RootElement.GetProperty("entry");
            Check.True(entry.GetProperty("narrative").GetString()!.Contains("DECORATIVE_GESTURE_1"));
            Check.Equal("current_scene", entry.GetProperty("acquisitions")[0].GetProperty("source").GetProperty("kind").GetString());
            Check.Equal(2, entry.GetProperty("continuity").GetArrayLength());
            Check.True(!recalled.Reply.Content.Contains("PRIVATE_NOTE_SENTINEL"));
            string path = h.Root; await h.DisposeAsync();
            h = await Host.Start(path, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false"));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            game = h.App.Services.GetRequiredService<GameService>();
            var after = await game.HarnessTool(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "核实", auth.Version, Id(), Id(),
                new("memory_read", HarnessJson.Element(new HarnessMemoryReadArgs(firstIntent)), "read"), [], default, auth.Profile, 23, true);
            Check.Equal(recalled.Reply.Content, after.Reply.Content); Check.Equal(4, calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static Task LegacyHistoryPreservesQuotesCorrectionsAndArchive()
    {
        var c = TestContent.Campaign(); c.Version = 30;
        for (int i = 1; i <= 18; i++)
            c.PendingIntents.Add(new PendingIntent { Id = Id(), ActorId = c.ActingActorId, RootSequence = i, Version = i, Text = "问询" + i,
                Source = "harness", Status = "completed", Published = true, Result = new("narrated", "narrative", "已记录。", null, []),
                NarrativeSource = "harness", Narrative = new string('景', 520) + "。莫娜说：“我没有答应今晚出发，也未付钱。”", PrivateText = "PRIVATE_LEGACY",
                Continuity = i == 14 ? [new("statement", "OBSOLETE_NOTE")] : null });
        c.PendingIntents.Add(new PendingIntent { Id = Id(), ActorId = "other-seat", RootSequence = 19, Version = 19, Text = "OTHER_SEAT",
            Source = "harness", Status = "completed", Published = true, Result = new("narrated", "narrative", "OTHER_SEAT", null, []), Narrative = "OTHER_SEAT" });
        c.AdventureCorrections.Add(new(14, "更正：从未付款。", "PRIVATE_CORRECTION_REASON", PartyEngine.HostId, DateTimeOffset.UtcNow, 20));
        string before = HarnessJson.Serialize(c);
        var history = HarnessWorkingMemories.Build(c, "莫娜", Id());
        string encoded = HarnessJson.Serialize(history);
        Check.True(!encoded.Contains("PRIVATE_") && !encoded.Contains("OTHER_SEAT") && !encoded.Contains("OBSOLETE_NOTE"));
        var corrected = history.Entries.Single(e => e.OriginSequence == 14);
        Check.Equal("host_correction", corrected.Representation); Check.Equal("更正：从未付款。", corrected.Narrative!.Text);
        var legacy = history.Entries.First(e => e.Representation == "legacy_source_extract");
        Check.True(legacy.Narrative!.Truncated);
        Check.Equal("莫娜说：“我没有答应今晚出发，也未付钱。”", legacy.QuotedText.Single().Text);
        Check.Equal(6, history.Archive!.TotalOlderActions); Check.True(history.Archive.Selected.Length > 0);
        Check.Equal(before, HarnessJson.Serialize(c));
        Check.Throws<GameException>(() => NarrativeContinuities.Validate([new("mechanical_truth", "不合法")]));
        return Task.CompletedTask;
    }

    public static Task LargeSavedFramesAndRecallRemainReadable()
    {
        var c = TestContent.Campaign();
        for (int i = 0; i < 16; i++) c.WorldMemory.Add(new("large-" + i, "clue", "公开条目" + i, new string('文', 800), "known", "harbor", 1, 0, c.Version, c.ActingActorId, "harness"));
        var context = Context(c); var memory = HarnessWorkingMemories.Build(c, "询问", Id());
        var frame = HarnessExecutionProtocol.Capture(c.Version, context, null, HarnessCharacterContext.Capture(c, 23), 23,
            new("harbor", "missing", false), HarnessSceneContexts.Build(c, context), false, memory);
        Check.True(System.Text.Encoding.UTF8.GetByteCount(HarnessJson.Serialize(frame)) > 131072);
        var initial = HarnessJson.Serialize(new { input = context.Intent.Text, ruleset = "dnd2024", memory = HarnessMemories.Build(c) });
        var request = HarnessExecutionProtocol.Project(new(Preset.SystemPrompt, [new("user", initial)], HarnessTools.ForVersion(23), 4096), frame, 23);
        Check.True(HarnessContextCompactor.Prepare(request, providerEncoding: true).Plan is null);
        var intent = new PendingIntent { Id = Id(), ActorId = c.ActingActorId, RootSequence = 1, Version = c.Version, Text = new string('问', 1000),
            Source = "harness", Status = "completed", Published = true, Result = new("narrated", "narrative", "记录", null, []), Narrative = new string('文', 4096), NarrativeSource = "harness",
            Continuity = Enumerable.Range(0, 16).Select(i => new NarrativeContinuityEntry("statement", new string('记', 238) + i)).ToArray(),
            StoryAcquisitions = Enumerable.Range(0, 16).Select(i => new StoryItemGrant("", "道具" + i, 1, new("current_scene", "harbor", new string('据', 240)))).ToArray() };
        c.PendingIntents.Add(intent);
        var read = HarnessRecall.Read(c, new(intent.Id), 23);
        Check.Equal(intent.Narrative, read.Entry.Narrative); Check.Equal(intent.Text, read.Entry.Input);
        Check.Equal(16, read.Entry.ExtrasCoverage!.ContinuityTotal); Check.Equal(16, read.Entry.ExtrasCoverage.AcquisitionsTotal);
        Check.True(read.Entry.Continuity!.Length < 16);
        Check.True(System.Text.Encoding.UTF8.GetByteCount(HarnessJson.Serialize(read)) <= HarnessRecall.MaximumReadBytes);
        Check.True(!HarnessJson.Serialize(HarnessRecall.Read(c, new(intent.Id), 22)).Contains("extrasCoverage"));
        return Task.CompletedTask;
    }

    public static Task QuotedEvidencePreservesOutsideNegation()
    {
        var c = TestContent.Campaign(); c.Version = 5;
        for (int i = 1; i <= 3; i++) c.PendingIntents.Add(new PendingIntent { Id = Id(), ActorId = c.ActingActorId, RootSequence = i, Version = i,
            Text = "问期限", Source = "harness", Status = "completed", Published = true, Result = new("narrated", "narrative", "记录", null, []), NarrativeSource = "harness",
            Narrative = new string('景', 200) + "。莫娜没有说过“今晚一定出发”，那只是你的猜测。" });
        var first = HarnessWorkingMemories.Build(c, "期限", Id()).Entries[0];
        Check.Equal("legacy_source_extract", first.Representation);
        Check.Equal("莫娜没有说过“今晚一定出发”，那只是你的猜测。", first.QuotedText.Single().Text);
        Check.Equal(201, first.QuotedText[0].SourceOffset); Check.True(!first.QuotedText[0].Truncated);
        return Task.CompletedTask;
    }

    public static async Task AcquisitionSourcesRejectHistoricalAndPrivateReferences()
    {
        var model = new Model((_, _) => Text());
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h, TestContent.Document with { InitialKnowledge = [new("private-gift", "npc", "不可领取", "私有赠物", "harbor", "host")] });
        var game = h.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
        string database = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite"); byte[] before = File.ReadAllBytes(database);
        foreach (var source in new StoryItemSource?[] { null, new("history", Id(), "旧事件口头提过，今天补发"),
            new("current_scene", "causeway", "异地领取"), new("public_memory", "private-gift", "私有资料提及"), new("rules", "rope", "目录有此物") })
        {
            try
            {
                await game.HarnessTool(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, Id(), "核实旧包裹", auth.Version, Id(), Id(),
                    new("world_record", HarnessJson.Element(new NarrativeHarnessArgs("不应保存。", [], Items: [new("rope", "", 1, source)])), "grant"),
                    [], default, auth.Profile, 23, true, ["private-gift"]);
                throw new Exception("Expected source rejection");
            }
            catch (GameException e) { Check.Equal("invalid_story_items", e.Code); }
            Check.True(before.SequenceEqual(File.ReadAllBytes(database)), "Rejected batch writes nothing");
        }
        Check.Equal(0, model.Calls);
    }
}
