using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessLongMemoryTests
{
    private static PendingIntent Entry(int sequence, string narrative, string actor = PartyEngine.HostId) => new()
    {
        Id = Id(), ActorId = actor, Text = "记录旅途 " + sequence, RootSequence = sequence, Version = sequence + 1,
        Status = "completed", Published = true, Source = "harness", Narrative = narrative, NarrativeSource = "harness",
        Result = new("narrated", "adventure.narrate", "已记录", null, [])
    };
    private static void Error(string code, Action action)
    {
        try { action(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static async Task Error(string code, Func<Task> action)
    {
        try { await action(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }
    public static Task SemanticParaphrasesSummariesAndScale()
    {
        var c = TestContent.Campaign("harbor", "Long memory"); c.Version = 5000;
        var oldest = Entry(2, "守卫说明暗号是青灯。我们尚未救出囚犯，不得把计划当作成功。"); c.PendingIntents.Add(oldest);
        for (int i = 2; i <= 1200; i++) c.PendingIntents.Add(Entry(i * 2, "沿途见闻记录第" + i + "次，海面平静。"));
        var hidden = Entry(2410, "passphrase PRIVATE-DRAFT"); hidden.Published = false; c.PendingIntents.Add(hidden);
        c.PendingIntents.Add(Entry(2412, "passphrase OTHER-SEAT", "other"));
        var pending = Entry(2414, "passphrase UNSETTLED"); pending.Status = "pending"; c.PendingIntents.Add(pending);
        string before = HarnessJson.Serialize(c);
        Check.Equal(0, HarnessRecall.Search(c, new("口令")).Entries.Length);
        var semantic = HarnessLongMemory.Search(c, new("口令"));
        Check.Equal(oldest.Id, semantic.Entries.Single().Entry.IntentId);
        Check.True(semantic.Entries[0].Concepts.Contains("passphrase"));
        Check.Equal(oldest.Id, HarnessLongMemory.Search(c, new("passphrase")).Entries.Single().Entry.IntentId);
        Check.True(semantic.Entries[0].Entry.Narrative.Contains("尚未救出"));
        Check.True(!HarnessJson.Serialize(semantic).Contains("PRIVATE") && !HarnessJson.Serialize(semantic).Contains("OTHER"));
        var snapshot = HarnessLongMemory.ForRun(c, "还记得口令吗？");
        Check.True(snapshot.Archive!.Selected.Any(e => e.IntentId == oldest.Id));
        Check.Equal(1188, snapshot.Archive.TotalOlderActions);
        Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(snapshot)) <= HarnessMemories.MaximumBytes);
        Check.Equal(before, HarnessJson.Serialize(c));
        var ids = new HashSet<string>(); int cursor = 0;
        do
        {
            var page = HarnessLongMemory.Digest(c, new(cursor)); Check.Equal(1200, page.TotalEligible);
            foreach (var entry in page.Entries) Check.True(ids.Add(entry.IntentId));
            if (page.NextBefore is null) break;
            Check.True(cursor == 0 || page.NextBefore < cursor); cursor = page.NextBefore.Value;
        } while (true);
        Check.Equal(1200, ids.Count);
        c.AdventureCorrections.Add(new(oldest.RootSequence, "公开更正：该守卫从未提供密语。", "HOST-REASON-PRIVATE", PartyEngine.HostId, DateTimeOffset.UtcNow, c.Version));
        Check.Equal(0, HarnessLongMemory.Search(c, new("口令")).Entries.Length);
        Check.True(!HarnessJson.Serialize(HarnessLongMemory.ForRun(c, "守卫")).Contains("HOST-REASON"));
        foreach (var args in new[] { new HarnessSemanticArgs(null!), new("x\n"), new(new string('x', 241)), new("", -1), new("", Limit: 9), new("", Limit: 0), new("口令", 1) })
            Error("harness_invalid_payload", () => HarnessLongMemory.Search(c, args));
        Error("harness_invalid_payload", () => HarnessLongMemory.Digest(c, new(c.Version + 1)));
        var large = TestContent.Campaign("harbor", "UTF-8 summary budget"); large.Version = 200;
        for (int i = 1; i <= 35; i++) large.PendingIntents.Add(Entry(i * 2, new string('文', 4096)));
        var bounded = HarnessLongMemory.ForRun(large, "旧记录");
        Check.True(bounded.Archive!.Selected.Length > 0);
        Check.Equal(35 - bounded.Entries.Length, bounded.Archive.TotalOlderActions);
        Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(bounded)) <= HarnessMemories.MaximumBytes);
        return Task.CompletedTask;
    }
    public static Task ContextReductionPreservesOriginalGroups()
    {
        // Computed from the pre-change v4 assembly, not regenerated from the new catalog.
        Check.Equal("d768150255c155baf375fbd4c27b3b6d9e8ae13e7c4b4dd324fcefce28d48a9a",
            HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(4))));
        var messages = new List<HarnessChatMessage> { new("user", "ORIGINAL-GOAL 原始目标不可改") };
        var history = new List<HarnessModelExchange>();
        for (int i = 0; i < 10; i++)
        {
            if (i == 4) messages.Add(new("user", "PLAYER-CONSENT-RESULT 保留本人已确认结果"));
            var reply = Tool("memory_read", new { intentId = Id() }, "call-" + i);
            messages.Add(new("assistant", reply.Text, reply.ToolCalls));
            messages.Add(new("tool", "记录" + i + new string('中', 8000), ToolCallId: reply.ToolCalls[0].Id, Name: "memory_read", IsError: false));
            history.Add(new(reply, new(new string('a', 64), HarnessJson.Element(new { signature = "PRIVATE-NATIVE-" + i }))));
        }
        var request = new HarnessModelRequest("  原始system\n", messages.ToArray(), HarnessTools.All, 4096)
        { ProviderHistory = history.ToArray(), PriorProviderIdentities = [new string('a', 64)] };
        string before = HarnessJson.Serialize(request); string privateBefore = HarnessJson.Serialize(request.ProviderHistory);
        var prepared = HarnessContextCompactor.Prepare(request); Check.True(prepared.Plan is not null);
        HarnessContextCompactor.Validate(prepared.Plan!);
        Check.True(prepared.Plan!.OmittedExchanges > 0 && prepared.Plan.EffectiveBytes <= HarnessContextCompactor.TargetBytes);
        Check.Equal(before, HarnessJson.Serialize(request)); Check.Equal(privateBefore, HarnessJson.Serialize(request.ProviderHistory));
        Check.Equal(request.System, prepared.Request.System);
        Check.True(prepared.Request.Messages.Any(m => m.Content == "ORIGINAL-GOAL 原始目标不可改"));
        Check.True(prepared.Request.Messages.Any(m => m.Content.StartsWith("PLAYER-CONSENT-RESULT")));
        Check.True(prepared.Request.PriorProviderIdentities.SequenceEqual(request.PriorProviderIdentities));
        Check.True(!HarnessJson.Serialize(prepared.Request).Contains("PRIVATE-NATIVE"));
        Check.True(prepared.Request.Messages.Any(m => m.Role == "tool" && m.Content == messages[^1].Content));
        var outstanding = new HashSet<string>(); int retained = 0;
        foreach (var message in prepared.Request.Messages)
        {
            if (message.Role == "assistant")
            {
                Check.Equal(0, outstanding.Count);
                var exchange = prepared.Request.ProviderHistory[retained++];
                Check.Equal(HarnessJson.Serialize(exchange.Reply.ToolCalls), HarnessJson.Serialize(message.ToolCalls));
                foreach (var call in message.ToolCalls ?? []) outstanding.Add(call.Id);
            }
            else if (message.Role == "tool") Check.True(outstanding.Remove(message.ToolCallId!));
            else Check.Equal(0, outstanding.Count);
        }
        Check.Equal(0, outstanding.Count); Check.Equal(prepared.Request.ProviderHistory.Length, retained);
        Check.Equal(HarnessJson.Serialize(prepared.Plan), HarnessJson.Serialize(HarnessContextCompactor.Prepare(request).Plan));
        Error("harness_context_limit", () => HarnessContextCompactor.Prepare(new(new string('s', 100000), [new("user", "cannot cut")], [], 4096)));
        var broken = request.Messages.ToArray(); broken[2] = broken[2] with { ToolCallId = "wrong" };
        Error("harness_model_contract", () => HarnessContextCompactor.Prepare(request with { Messages = broken }));
        return Task.CompletedTask;
    }
    public static async Task ReadOnlyToolsAndSeatIsolation()
    {
        var model = new Model((_, _) => throw new Exception("Memory reads may not call a model")); var dice = new SequenceDice();
        await using var host = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(host);
        var guest = await HarnessBoundaryTests.Guest(host, owner); string id = owner.Snapshot.Id;
        var store = host.App.Services.GetRequiredService<CampaignStore>();
        var own = Entry(1, "暗号为青灯。"); var theirs = Entry(2, "口令为PRIVATE-GUEST", guest.Snapshot.Party!.SelfActorId);
        await store.Access(id, owner.AccessToken, true, c => { c.PendingIntents.AddRange([own, theirs]); return Task.FromResult(true); });
        var game = host.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        var snapshot = (await host.Get(id))!;
        Task<HarnessToolOutcome> Call(string token, string actor, string name, object args, int contract = 5) =>
            game.HarnessTool(id, token, actor, Id(), "回顾历史", snapshot.Version, Id(), "read-only", new(name, HarnessJson.Element(args), "read"),
                [], default, auth.Profile, contract);
        string path = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] before = File.ReadAllBytes(path);
        var search = await Call(owner.AccessToken, auth.ActorId, "memory_semantic_search", new { query = "口令" });
        Check.True(search.OfferedIds is null && search.OfferedMemoryIds is null && search.Wait is null);
        Check.True(search.Reply.Content.Contains(own.Id) && !search.Reply.Content.Contains("PRIVATE-GUEST"));
        var digest = await Call(guest.AccessToken, guest.Snapshot.Party.SelfActorId, "memory_digest", new { });
        Check.True(digest.Reply.Content.Contains(theirs.Id) && !digest.Reply.Content.Contains(own.Id));
        await Error("harness_tool_unavailable", () => Call(owner.AccessToken, auth.ActorId, "memory_semantic_search", new { query = "口令" }, 4));
        await Error("unauthorized", () => Call(guest.AccessToken, auth.ActorId, "memory_digest", new { }));
        await Error("harness_invalid_payload", () => Call(owner.AccessToken, auth.ActorId, "memory_semantic_search", new { query = "口令", actor = "other" }));
        Check.True(before.SequenceEqual(File.ReadAllBytes(path))); Check.Equal(0, model.Calls); Check.Equal(0, dice.Count);
    }
    public static async Task RealPiReductionAndExactRestart()
    {
        string skill = new string('文', 12000) + "工具原文末尾不可改";
        var model = new Model((n, request) =>
        {
            Check.Equal(Preset.SystemPrompt, request.System);
            Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(request)) <= HarnessContextCompactor.TargetBytes);
            if (n == 1 || n == 10) return Tool("context_read", id: "context-" + n);
            if (n is >= 2 and <= 9) return Tool("skills_read", new { id = "long-skill" }, "skill-" + n);
            if (n == 11)
            {
                var context = request.Messages.Last(m => m.Role == "tool" && m.Name == "context_read");
                using var json = JsonDocument.Parse(context.Content);
                Check.True(json.RootElement.TryGetProperty("context", out _), "Compaction must expire unchanged-context suppression");
                return Tool("ask_player", new { question = "已经整理旧信息，是否继续？" }, "wait");
            }
            Check.Equal(12, n);
            Check.True(request.Messages.Any(m => m.Role == "user" && m.Content == HarnessJson.Serialize(new { playerAnswer = "继续但不投掷" })));
            return Text("已使用整理后的上下文继续，没有投掷或改变旧回执。");
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(host, skills: [new("long-skill", "明确导入的长资料夹具", skill)]); string id = owner.Snapshot.Id;
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "阅读资料并持续处理这个目标，不要投掷");
            var run = await StartHistorical(host, id, request, 5); run = await Settled(host, id, run.Id, 3000);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error + "; calls=" + model.Calls); Check.Equal(11, model.Calls);
            var store = host.App.Services.GetRequiredService<HarnessRunStore>(); var saved = store.Read(id, PartyEngine.HostId, run.Id)!;
            Check.True(saved.Steps.Any(s => s.ContextPlan is not null));
            foreach (var step in saved.Steps.Where(s => s.ToolName == "skills_read"))
            {
                var reply = HarnessJson.Read<HarnessToolReply>(step.Result!.Value);
                using var json = JsonDocument.Parse(reply.Content); Check.Equal(skill, json.RootElement.GetProperty("content").GetString());
            }
            string oldSteps = HarnessJson.Serialize(saved.Steps); int count = saved.Steps.Count;
            string root = host.Root; await host.DisposeAsync();
            host = await Host.Start(root, dice, configure: configure); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(11, model.Calls);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", request)).Replayed); Check.Equal(11, model.Calls);
            await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "继续但不投掷"));
            run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            Check.Equal(12, model.Calls); Check.Equal(0, dice.Count);
            saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(oldSteps, HarnessJson.Serialize(saved.Steps.Take(count).ToList()));
        }
        finally { await host.DisposeAsync(); }
    }
    public static async Task CompactedUnknownAndCorruption()
    {
        var model = new Model((n, _) => n < 7 ? Tool("skills_read", new { id = "long" }, "read-" + n)
            : throw new HttpRequestException("Synthetic possibly-sent failure after compaction"));
        var configure = Configure(model); var host = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(host, skills: [new("long", "大文本夹具", new string('文', 12000))]);
            string id = owner.Snapshot.Id; var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "有界整理不能重复外发");
            var run = await StartHistorical(host, id, request, 5); run = await Settled(host, id, run.Id);
            Check.Equal("unknown", run.Status); Check.Equal(7, model.Calls);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.True(saved.Steps.Last().ContextPlan is not null && saved.Steps.Last().Status == "started");
            Check.Equal(7, saved.ModelAttempts);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, configure: configure);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal("unknown", (await Settled(host, id, run.Id)).Status);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", request)).Replayed); Check.Equal(7, model.Calls);
            var response = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version));
            Check.Equal(System.Net.HttpStatusCode.Conflict, response.StatusCode); Check.Equal(7, model.Calls);
            string file = Directory.EnumerateFiles(Path.Combine(root, "harness"), run.Id + ".json", SearchOption.AllDirectories).Single();
            var json = JsonNode.Parse(File.ReadAllBytes(file))!;
            json["steps"]!.AsArray().Last()!["contextPlan"]!["policy"] = "forged-policy";
            byte[] corrupt = JsonSerializer.SerializeToUtf8Bytes(json); File.WriteAllBytes(file, corrupt);
            Error("harness_corrupt_run", () => host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id));
            Check.True(corrupt.SequenceEqual(File.ReadAllBytes(file)));
        }
        finally { await host.DisposeAsync(); }
    }

}
