using System.Reflection;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessHistorySummaryTests
{
    private static HarnessHistoryFragment Fragment(string id, int sequence, string body, string audience = "public", string part = "narrative") =>
        new(new("event", id, sequence, part, PrivateStories.Revision(body)), audience, "speaker", "说话人", "narration", body, sequence, id);
    private static HarnessHistorySummary Draft(HarnessHistorySummaryRange range, long publication, string[]? replaces = null) =>
        new(Id(), 1, publication, range.Scope, range.Audience, range.Sources,
            "说话人声称认识守卫；只有修桥才考虑带路，未答应。", "修桥才考虑，尚未接受；这是说话人的声称。", replaces ?? []);
    private static void Error(string code, Action action)
    {
        try { action(); throw new Exception("Expected " + code); }
        catch (GameException e) { Check.Equal(code, e.Code); }
    }
    private static T Invoke<T>(object owner, string name, params object?[] args)
    {
        try { return (T)owner.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(owner, args)!; }
        catch (TargetInvocationException e) when (e.InnerException is { } inner)
        { System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(inner).Throw(); throw; }
    }

    public static Task LayeredCoverageAndSourceRaces()
    {
        var a = Fragment("event-a", 10, "我可以考虑，条件是桥先修好。");
        var b = Fragment("event-b", 11, "他没有答应。");
        var secret = Fragment("event-a", 10, "ACTOR-ONLY", "actor-a", "private:1");
        var later = Fragment("event-c", 12, "新原文。");
        HarnessHistoryFragment[] sources = [a, b, secret];
        HarnessHistorySummary Publish(HarnessHistorySource[] selected, long n, HarnessHistorySummary[] old, string[]? replaces = null)
        {
            var range = HarnessHistorySummaries.Freeze("exploration", "public", sources, selected);
            return HarnessHistorySummaries.PreparePublication(Draft(range, n, replaces), range, sources, old);
        }
        var first = Publish([a.Source], 1, []);
        var second = Publish([b.Source], 2, [first]);
        var baseline = Publish([a.Source, b.Source], 3, [first, second], [first.Id, second.Id]);
        var choice = HarnessHistorySummaries.Select("exploration", "public", [.. sources, later], [first, second, baseline],
            [a.Source], new Dictionary<string, string> { [baseline.Id] = "brief" });
        Check.Equal(1, choice.Summaries.Length); Check.Equal(baseline.Id, choice.Summaries[0].Id);
        Check.Equal("brief", choice.Summaries[0].Tier); Check.Equal(baseline.Brief, choice.Summaries[0].Text);
        Check.Equal(later, choice.Raw.Single());
        Check.Equal(a, choice.RelatedOriginalSupplements.Single().Original);
        Check.Equal("related_original_supplement", choice.RelatedOriginalSupplements.Single().Kind);
        Check.True(!HarnessJson.Serialize(choice).Contains("ACTOR-ONLY"));
        var privateChoice = HarnessHistorySummaries.Select("exploration", "actor-a", sources, [first, second, baseline], [], new Dictionary<string, string>());
        Check.Equal(secret, privateChoice.Raw.Single()); Check.Equal(0, privateChoice.Summaries.Length);
        var fallback = HarnessHistorySummaries.Select("exploration", "public", sources, [first, second, baseline with { Brief = "" }], [], new Dictionary<string, string>());
        Check.True(fallback.Summaries.Select(s => s.Id).Order().SequenceEqual(new[] { first.Id, second.Id }.Order()));
        var frozen = HarnessHistorySummaries.Freeze("exploration", "public", sources, [a.Source, b.Source]);
        Error("harness_history_summary_replacement_invalid", () => HarnessHistorySummaries.PreparePublication(Draft(frozen, 4), frozen, sources, [first, second, baseline]));
        Error("harness_history_summary_source_unavailable", () => HarnessHistorySummaries.Freeze("exploration", "public", sources, [secret.Source]));
        Error("harness_history_summary_changed", () => HarnessHistorySummaries.PreparePublication(Draft(frozen, 4, [first.Id, second.Id, baseline.Id]), frozen,
            [a with { Audience = "actor-a" }, b], [first, second, baseline]));
        var changed = a with { Source = a.Source with { Revision = PrivateStories.Revision("更正") }, Text = "更正" };
        Error("harness_history_summary_changed", () => HarnessHistorySummaries.PreparePublication(Draft(frozen, 4, [first.Id, second.Id, baseline.Id]), frozen,
            [changed, b], [first, second, baseline]));
        var afterEdit = HarnessHistorySummaries.Select("exploration", "public", [changed, b], [first, second, baseline], [], new Dictionary<string, string>());
        Check.Equal(second.Id, afterEdit.Summaries.Single().Id); Check.Equal(changed, afterEdit.Raw.Single());
        // Real long-history regression: common words such as 没有/记录/约定 must not
        // pull every old group back as an original supplement after publication.
        var noise = Enumerable.Range(20, 60).Select(n => Fragment("old-" + n, n,
            "伊岚记录闲谈，众人没有改变约定，没有回答问题；这段话只谈木杯纹理与光线。" )).ToArray();
        var quote = Fragment("specific-quote", 80, "看守砚川要求核对顺序：先验印，再开箱。印章没有验过。" );
        var recent = Fragment("recent", 81, "潮水拍打木桩。" );
        HarnessHistoryFragment[] longSources = [.. noise, quote, recent];
        var longRange = HarnessHistorySummaries.Freeze("exploration", "public", longSources, [.. noise.Select(s => s.Source), quote.Source]);
        var published = HarnessHistorySummaries.PreparePublication(Draft(longRange, 1), longRange, longSources, []);
        var context = HarnessHistoryContexts.Build(81, "actor-a", new("", "exploration", longSources, [published]),
            "我核对顺序原句，记录先前约定仍没有回答的问题，不实际打开东西。", []);
        Check.True(context.ProtectedOriginals.Contains(quote.Source));
        Check.True(context.ProtectedOriginals.Contains(recent.Source));
        Check.True(!context.ProtectedOriginals.Any(source => noise.Any(s => s.Source == source)));
        Check.Equal(quote.Source, context.Audiences[0].RelatedOriginalSupplements.Single().Original.Source);
        var common = Enumerable.Range(90, 6).Select(n => Fragment("common-" + n, n,
            "队伍继续前进。伊岚说：我先修桥；之后他说再带路。") with { ActorName = "伊岚" }).ToArray();
        var quoted = Fragment("quoted", 96, "先修桥，再带路。");
        var newest = Fragment("newest", 97, "潮水拍打木桩。");
        var commonCapture = new HarnessHistoryCapture("", "exploration", [.. common, quoted, newest], []);
        var shortQuery = HarnessHistoryContexts.Build(97, "actor-a", commonCapture, "继续", []);
        Check.True(!shortQuery.ProtectedOriginals.Any(s => common.Any(f => f.Source == s)));
        var explicitQuote = HarnessHistoryContexts.Build(97, "actor-a", commonCapture, "核对原句‘先修桥，再带路’，不要默认同意。", []);
        Check.True(explicitQuote.ProtectedOriginals.Contains(quoted.Source));
        var historicalSpeaker = HarnessHistoryContexts.Build(97, "actor-a", commonCapture, "核对伊岚先前原话。", []);
        Check.True(common.All(s => historicalSpeaker.ProtectedOriginals.Contains(s.Source)));
        return Task.CompletedTask;
    }

    private sealed class NoResummary : IHarnessHistorian
    {
        public int Calls;
        public bool Enabled => true;
        public string Identity => "ancestor-test";
        public IHarnessHistorian Capture() => this;
        public Task<HarnessHistoryText> Summarize(HarnessHistoryFragment[] sources, Func<CancellationToken, Task> authorize,
            string campaignId, CancellationToken ct, int toolContractVersion = 50)
        { Calls++; throw new Exception("Published mixed ancestors must remain raw, never resummarized as an invalid partial replacement."); }
    }

    public static async Task MixedAncestorChainDoesNotIssuePartialWork()
    {
        var helper = new NoResummary();
        var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("No gameplay model needed")),
            extra: b => b.Services.AddSingleton<IHarnessHistorian>(helper)));
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var store = h.App.Services.GetRequiredService<CampaignStore>(); var game = h.App.Services.GetRequiredService<GameService>();
            await store.Access(id, owner.AccessToken, true, c =>
            {
                c.Events.Add(new(Id(), ++c.Version, "party.join", "ADMIN_过去等待审核", "", "system", DateTimeOffset.UtcNow, null, c.ActingActorId));
                c.Events.Add(new(Id(), ++c.Version, "observe", "老船夫曾说要修桥。", "", "system", DateTimeOffset.UtcNow, null, c.ActingActorId));
                c.Events.Add(new(Id(), ++c.Version, "observe", "当前潮水涨起。", "", "system", DateTimeOffset.UtcNow, null, c.ActingActorId));
                return Task.FromResult(true);
            });
            await store.Access(id, owner.AccessToken, false, c =>
            {
                var old = Invoke<HarnessHistoryCapture>(game, "CaptureHistory", c, "", null, 50);
                var range = HarnessHistorySummaries.Freeze("exploration", "public", old.Sources,
                    old.Sources.Where(s => s.Audience == "public" && s.Version < c.Version).Select(s => s.Source).ToArray());
                var chain = new List<HarnessHistorySummary>();
                for (int i = 1; i <= 32; i++)
                {
                    var draft = Draft(range, i, chain.Select(s => s.Id).ToArray()) with { Detailed = "ADMIN_过去等待审核和修桥往事", Brief = "ADMIN_旧管理与故事混合" };
                    chain.Add(Invoke<HarnessHistorySummary>(store, "PublishHistorySummary", c, draft, range, old.Sources));
                }
                return Task.FromResult(true);
            });
            string root = h.Root; await h.DisposeAsync();
            h = await Host.Start(root, configure: Configure(new Model((_, _) => throw new Exception("No gameplay model needed")),
                extra: b => b.Services.AddSingleton<IHarnessHistorian>(helper)));
            GameSaveTests.Auth(h, owner.AccessToken);
            store = h.App.Services.GetRequiredService<CampaignStore>(); game = h.App.Services.GetRequiredService<GameService>();
            var capture = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(
                Invoke<HarnessHistoryCapture>(game, "CaptureHistory", c, "", null, 51)));
            int version = (await h.Get(id))!.Version;
            Check.Equal(32, capture.Published.Length);
            var context = HarnessHistoryContexts.Build(version, PartyEngine.HostId, capture, "继续", [], toolContractVersion: 51);
            Check.True(context.Audiences.All(a => a.Summaries.Length == 0));
            Check.True(!HarnessJson.Serialize(context).Contains("ADMIN_"));
            Check.True(context.Audiences.SelectMany(a => a.Raw).Any(f => f.Text.Contains("老船夫")));
            var run = new HarnessRun { Id = Id(), IntentId = Id(), CampaignId = id, ActorId = PartyEngine.HostId, Version = version,
                Fingerprint = new string('0', 64), Input = "继续", Limits = new(),
                ToolContractVersion = 51, Profile = (await game.AuthorizeHarness(id, owner.AccessToken, default)).Profile };
            var manager = h.App.Services.GetRequiredService<HarnessHistoryManager>();
            Check.True(await Invoke<Task<HarnessHistorySummary?>>(manager, "Prepare", run, owner.AccessToken, capture, context, "public", null) is null);
            var source = capture.Sources.Single(s => s.Text.Contains("老船夫"));
            var partial = HarnessHistorySummaries.Freeze("exploration", "public", capture.Sources, [source.Source]);
            Check.True(await Invoke<Task<HarnessHistoryWork?>>(game, "BeginHarnessHistory", run, owner.AccessToken, capture, partial, helper.Identity, CancellationToken.None, null) is null);
            Check.Equal(0, helper.Calls); Check.Equal(version, (await h.Get(id))!.Version);
            Console.WriteLine("32 published mixed ancestors survive restart; story falls back to exact raw sources, zero invalid partial helper work.");
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task PublishedBriefPrecedesTransport()
    {
        var model = new Model((n, request) =>
        {
            if (n == 1) return Tool("world_record", new NarrativeHarnessArgs("那场谈话已经结束。", []));
            using var initial = JsonDocument.Parse(request.Messages[0].Content);
            var history = HarnessJson.Read<HarnessHistoryContext>(initial.RootElement.GetProperty("memory"));
            Check.Equal("brief", history.Audiences.SelectMany(a => a.Summaries).Single().Tier);
            Check.True(HarnessJson.Serialize(request).Length < 200000);
            return Tool("world_record", new NarrativeHarnessArgs("继续查看船索。", []));
        });
        await using var h = await Host.Start(configure: Configure(model, extra: GameSaveTests.ConfigurePi));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var first = await Start(h, owner.Snapshot, "谈论旧事"); Check.Equal("completed", (await Settled(h, id, first.Id, 3000)).Status);
        var store = h.App.Services.GetRequiredService<CampaignStore>(); var game = h.App.Services.GetRequiredService<GameService>();
        await store.Access(id, owner.AccessToken, false, c =>
        {
            var capture = Invoke<HarnessHistoryCapture>(game, "CaptureHistory", c, "", null, HarnessTools.CurrentVersion);
            var range = HarnessHistorySummaries.Freeze("exploration", "public", capture.Sources,
                capture.Sources.Where(s => s.Audience == "public").Select(s => s.Source).ToArray());
            // Legal stored detailed text exceeds the candidate frame/wire boundary; brief is complete and small.
            var summary = Draft(range, 1) with { Detailed = new string('详', 1500000), Brief = "那场谈话已经结束，仍未承诺帮助。" };
            Invoke<HarnessHistorySummary>(store, "PublishHistorySummary", c, summary, range, capture.Sources);
            return Task.FromResult(true);
        });
        var next = await Start(h, (await h.Get(id))!, "查看船索"); next = await Settled(h, id, next.Id, 3000);
        Check.Equal("completed", next.Status); Check.Equal(2, model.Calls);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, next.Id)!;
        Check.Equal("brief", saved.Steps.First(s => s.Kind == "model").ExecutionFrame!.History!.Audiences.SelectMany(a => a.Summaries).Single().Tier);
    }

    public static async Task PublishedHistoryPersistenceAndFrozenPiSlots()
    {
        HarnessHistorySummary? merged = null;
        HarnessHistoryContext? original = null;
        var model = new Model((n, request) =>
        {
            if (n == 1) return Tool("world_record", new NarrativeHarnessArgs("商人说：若桥修好才考虑带路，现在没有接受。", [],
                Continuity: [new("open_question", "NOTE_ONLY 尚未回答何时修桥。") ]));
            using var initial = JsonDocument.Parse(request.Messages[0].Content);
            var history = HarnessJson.Read<HarnessHistoryContext>(initial.RootElement.GetProperty("memory"));
            Check.True(history.Audiences.SelectMany(a => a.Summaries).Any(s => s.Id == merged!.Id));
            Check.True(history.Audiences.SelectMany(a => a.Raw.Concat(a.RelatedOriginalSupplements.Select(s => s.Original)))
                .Any(s => s.Kind == "model_reported_open_question" && s.Text == "NOTE_ONLY 尚未回答何时修桥。" && s.Audience == PartyEngine.HostId));
            Check.True(history.Audiences.SelectMany(a => a.RelatedOriginalSupplements).Any(s => s.Original.Text.Contains("没有接受")));
            Check.True(request.Messages.All(m => !m.Content.Contains("source-excerpts-and-model-reported-continuity-v1")));
            original = history;
            return Tool("world_record", new NarrativeHarnessArgs("仍未接受，只是附条件考虑。", []));
        });
        var dice = new SequenceDice();
        var h = await Host.Start(dice: dice, configure: Configure(model, extra: GameSaveTests.ConfigurePi));
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var firstInput = new HarnessInputRequest(Id(), owner.Snapshot.Version, "问商人能否带路");
            var first = await Post<HarnessRunView>(h, id, "harness/runs", firstInput);
            first = await Settled(h, id, first.Id, 3000); Check.Equal("completed", first.Status);
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            var game = h.App.Services.GetRequiredService<GameService>();
            var capture = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(
                Invoke<HarnessHistoryCapture>(game, "CaptureHistory", c, "", null, HarnessTools.CurrentVersion)));
            var publicSources = capture.Sources.Where(s => s.Audience == "public").Select(s => s.Source).ToArray();
            var range = HarnessHistorySummaries.Freeze("exploration", "public", capture.Sources, publicSources);
            var draft = Draft(range, 1);
            string database = Path.Combine(h.Root, "campaigns", id + ".sqlite");
            using (var db = new SqliteConnection("Data Source=" + database + ";Pooling=False"))
            { db.Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "PRAGMA user_version"; Check.Equal(2L, (long)cmd.ExecuteScalar()!); }
            byte[] beforeInvalid = File.ReadAllBytes(database);
            await store.Access(id, owner.AccessToken, false, c =>
            {
                Error("harness_history_summary_changed", () => Invoke<HarnessHistorySummary>(store, "PublishHistorySummary", c,
                    draft with { Sources = [publicSources[0]] }, range, capture.Sources));
                return Task.FromResult(true);
            });
            Check.True(beforeInvalid.SequenceEqual(File.ReadAllBytes(database)));
            merged = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(
                Invoke<HarnessHistorySummary>(store, "PublishHistorySummary", c, draft, range, capture.Sources)));
            Check.Equal(first.Version, (await h.Get(id))!.Version);
            Check.Equal(1, Directory.GetFiles(Path.GetDirectoryName(database)!, id + ".sqlite.pre-history-v3.*.bak").Length);
            using (var db = new SqliteConnection("Data Source=" + database + ";Pooling=False"))
            { db.Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "PRAGMA user_version"; Check.Equal(3L, (long)cmd.ExecuteScalar()!); }
            var saved = await GameSaveTests.Save(h, id, "含摘要的进度");
            string root = h.Root;
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: Configure(model, extra: GameSaveTests.ConfigurePi));
            GameSaveTests.Auth(h, owner.AccessToken);
            var input = new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "问商人先前条件是否已经接受");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input);
            run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "completed", run.Error);
            var journal = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(HarnessJson.Serialize(original), HarnessJson.Serialize(journal.Steps.First(s => s.Kind == "model").ExecutionFrame!.History));
            Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed); Check.Equal(2, model.Calls);
            await GameSaveTests.Load(h, id, await GameSaveTests.Entry(h, id, saved.GetProperty("saveId").GetString()!));
            store = h.App.Services.GetRequiredService<CampaignStore>(); game = h.App.Services.GetRequiredService<GameService>();
            var restored = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(Invoke<HarnessHistoryCapture>(game, "CaptureHistory", c, "", null, HarnessTools.CurrentVersion)));
            Check.True(restored.TimelineId != capture.TimelineId); Check.Equal(merged.Id, restored.Published.Single().Id);
            var context = HarnessHistoryContexts.Build((await h.Get(id))!.Version, PartyEngine.HostId, restored, "带路条件", []);
            Check.Equal(merged.Id, context.Audiences.SelectMany(a => a.Summaries).Single().Id);
            // A draft started before restore cannot publish into the new branch.
            try
            {
                await Invoke<Task<HarnessHistorySummary>>(game, "PublishHarnessHistory", journal, owner.AccessToken,
                    capture, range, draft with { Id = Id() }, CancellationToken.None, null);
                throw new Exception("Expected stale summary branch");
            }
            catch (GameException e) { Check.Equal("harness_history_summary_changed", e.Code); }
            var snapshot = (await h.Get(id))!;
            await GameSaveTests.Write(h, id, "adventure/restart", new { requestId = Id(), expectedVersion = snapshot.Version });
            using (var db = new SqliteConnection("Data Source=" + database + ";Pooling=False"))
            { db.Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT count(*) FROM history_summaries"; Check.Equal(0L, (long)cmd.ExecuteScalar()!); }
            Check.Equal(2, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
