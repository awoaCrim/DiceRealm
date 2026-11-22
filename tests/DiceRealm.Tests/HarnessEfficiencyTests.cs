using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessEfficiencyTests
{
    private static JsonElement Output(HarnessModelRequest request, string name) =>
        JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool" && m.Name == name).Content).RootElement.Clone();
    private static HarnessModelReply Batch(params string[] names) => new("", names.Select((name, i) =>
        new HarnessToolCall("read-" + i, name, HarnessJson.Element(new { }))).ToArray(), 10, 10);

    public static async Task CompactReadsAndFreshAuthorization()
    {
        int completeBytes = 0, compactBytes = 0;
        var model = new Model((i, request) =>
        {
            if (i == 1) return Batch("context_read", "actions_list");
            if (i == 2)
            {
                var context = Output(request, "context_read");
                var list = Output(request, "actions_list");
                Check.True(context.GetProperty("context").GetProperty("intent").GetProperty("candidates").GetArrayLength() > 0);
                Check.True(list.TryGetProperty("candidatesUnchanged", out var unchanged) && unchanged.GetBoolean(), "duplicate action list must reference the previously offered IDs");
                Check.True(!list.TryGetProperty("candidates", out _));
                completeBytes = Encoding.UTF8.GetByteCount(context.GetRawText()); compactBytes = Encoding.UTF8.GetByteCount(list.GetRawText());
                Check.True(compactBytes * 5 < completeBytes);
                return Tool("context_read");
            }
            if (i == 3)
            {
                var context = Output(request, "context_read");
                Check.True(context.GetProperty("contextUnchanged").GetBoolean());
                Check.True(!context.TryGetProperty("context", out _));
                return Tool("ask_player", new { question = "继续观察还是调查？" });
            }
            if (i == 4) return Batch("actions_list", "context_read");
            if (i == 5)
            {
                // Answer did not change the game version, but it invalidated the prior read lease.
                var list = Output(request, "actions_list"); var context = Output(request, "context_read");
                Check.True(list.GetProperty("candidates").GetArrayLength() > 0);
                Check.True(context.TryGetProperty("context", out var body));
                Check.True(!body.GetProperty("intent").TryGetProperty("candidates", out _));
                Check.True(context.GetProperty("candidatesUnchanged").GetBoolean());
                var choice = list.GetProperty("candidates").EnumerateArray().First(c => c.GetProperty("label").GetString()!.Contains("观察"));
                return Tool("actions_propose", new { candidateId = choice.GetProperty("id").GetString() });
            }
            if (i == 6) return Tool("context_read");
            if (i == 7)
            {
                Check.True(Output(request, "context_read").GetProperty("context").GetProperty("intent").GetProperty("candidates").GetArrayLength() > 0);
                return Text("观察已经由服务器完成。");
            }
            throw new Exception("Unexpected model call " + i);
        });
        var configure = Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(host); string id = owner.Snapshot.Id;
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "观察");
            var run = await StartV14(host, id, request);
            run = await Settled(host, id, run.Id, 3000);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error); Check.Equal(3, model.Calls);
            Check.Equal(owner.Snapshot.Version, (await host.Get(id))!.Version); Check.Equal(0, dice.Count);
            string root = host.Root; await host.DisposeAsync();
            host = await Host.Start(root, dice: dice, configure: configure);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", request)).Replayed); Check.Equal(3, model.Calls);
            var resume = new HarnessResumeRequest(Id(), run.Version, "继续观察");
            await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", resume);
            run = await Settled(host, id, run.Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error); Check.Equal(7, model.Calls);
            Check.True((await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            var state = (await host.Get(id))!;
            Check.Equal(1, state.Events.Count(e => e.Kind == "observe")); Check.Equal(0, dice.Count); Check.Equal(7, model.Calls);
            Console.WriteLine($"EFFICIENCY full_context_bytes={completeBytes} unchanged_list_bytes={compactBytes}");
        }
        finally { await host.DisposeAsync(); }
    }

    public static async Task WaitingStillExpiresCandidates()
    {
        string? candidate = null;
        var model = new Model((i, request) =>
        {
            if (i == 1) return Tool("actions_list");
            if (i == 2)
            {
                candidate = Output(request, "actions_list").GetProperty("candidates")[0].GetProperty("id").GetString();
                return Tool("ask_player", new { question = "目标？" });
            }
            return Tool("actions_propose", new { candidateId = candidate });
        });
        await using var host = await Host.Start(configure: Configure(model)); var owner = await Create(host);
        var run = await StartV14(host, owner.Snapshot.Id, new HarnessInputRequest(Id(), owner.Snapshot.Version, "调查现场")); run = await Settled(host, owner.Snapshot.Id, run.Id);
        await Post<HarnessRunView>(host, owner.Snapshot.Id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "就是原来的目标"));
        run = await Settled(host, owner.Snapshot.Id, run.Id);
        Check.Equal("failed", run.Status); Check.Equal("intent_option_unavailable", run.Error);
        Check.Equal(owner.Snapshot.Version, (await host.Get(owner.Snapshot.Id))!.Version);
    }

    public static async Task LegacyToolContractRestart()
    {
        var model = new Model((i, request) =>
        {
            Check.Equal("List currently legal offered actions and their target/source/cost. Call before proposing an action; IDs expire on state writes.", request.Tools.Single(t => t.Name == "actions_list").Description);
            if (i == 1) return Batch("actions_list", "context_read", "actions_list");
            if (i == 2)
            {
                Check.True(Output(request, "actions_list").TryGetProperty("candidates", out _));
                Check.True(Output(request, "context_read").GetProperty("context").GetProperty("intent").TryGetProperty("candidates", out _));
                return Tool("ask_player", new { question = "旧运行等待答复。" });
            }
            return Text("旧契约原样重建后继续。");
        });
        var configure = Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var host = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(host); string id = owner.Snapshot.Id;
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "旧版输入");
            var auth = await host.App.Services.GetRequiredService<GameService>().AuthorizeHarness(id, owner.AccessToken, default);
            var legacy = new HarnessRun
            {
                Id = request.RequestId, IntentId = Id(), CampaignId = id, ActorId = auth.ActorId,
                Fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(request)), Input = request.Text,
                Profile = auth.Profile, Limits = new(), Version = request.ExpectedVersion,
                Turns = [HarnessJson.Serialize(new { input = request.Text, ruleset = "dnd2024" })]
            };
            host.App.Services.GetRequiredService<HarnessRunStore>().Create(legacy);
            Check.True(!HarnessJson.Element(legacy).TryGetProperty("toolContractVersion", out _));
            await Post<HarnessRunView>(host, id, $"harness/runs/{legacy.Id}/resume", new HarnessResumeRequest(Id(), legacy.Version));
            var run = await Settled(host, id, legacy.Id, 3000); Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            var before = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, auth.ActorId, run.Id)!;
            string steps = HarnessJson.Serialize(before.Steps);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, configure: configure);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", request)).Replayed); Check.Equal(2, model.Calls);
            await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "继续"));
            run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            var after = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, auth.ActorId, run.Id)!;
            Check.Equal(steps, HarnessJson.Serialize(after.Steps.Take(before.Steps.Count).ToList()));
            Check.Equal(3, model.Calls); Check.Equal(0, after.ToolContractVersion);
        }
        finally { await host.DisposeAsync(); }
    }

    public static Task UnchangedMemoryRetainsProvenance()
    {
        var campaign = TestContent.Campaign("harbor", "No-op");
        var original = new WorldMemoryEntry("known-clue", "clue", "路标", "码头有一个路标。", "known", "harbor", 7, 1, 1, "original-actor", "dm");
        campaign.WorldMemory.Add(original);
        var proposal = new WorldMemoryProposal(original.Id, original.Kind, " 路标 ", original.Summary + "\n", original.Status, original.SceneId);
        var ids = new HashSet<string> { original.Id }; var scenes = new HashSet<string> { "harbor" };
        var plan = WorldMemories.Plan(campaign, [proposal], ids, scenes, 3, "harness");
        Check.Equal(0, plan.Length); WorldMemories.Apply(campaign, plan); Check.Equal(original, campaign.WorldMemory.Single());
        Check.Throws<GameException>(() => WorldMemories.Plan(campaign, [proposal, proposal], ids, scenes, 3, "harness"));
        Check.Throws<GameException>(() => WorldMemories.Plan(campaign, [proposal, proposal with { Summary = "实际修改" }], ids, scenes, 3, "harness"));
        Check.Throws<GameException>(() => WorldMemories.Plan(campaign, [proposal], new HashSet<string>(), scenes, 3, "harness"));
        Check.Throws<GameException>(() => WorldMemories.Plan(campaign, [proposal with { SceneId = "unvisited" }], ids, scenes, 3, "harness"));
        plan = WorldMemories.Plan(campaign, [proposal with { Summary = "新增路线说明。" }], ids, scenes, 3, "harness");
        Check.Equal(1, plan.Length); Check.Equal(8, plan[0].Revision); Check.Equal(original.OriginSequence, plan[0].OriginSequence);
        return Task.CompletedTask;
    }

    public static async Task UnchangedMemoryNarrativeReceiptAndRestart()
    {
        WorldMemoryEntry? original = null;
        var model = new Model((i, request) =>
        {
            if (i == 1) return Tool("world_record", new NarrativeHarnessArgs("第一段公开叙事。", [new("", "clue", "记忆幂等", "内容保持不变。", "known", "harbor")], Complete: false));
            if (i == 2)
            {
                original = HarnessJson.Read<WorldMemoryEntry>(Output(request, "world_record").GetProperty("memory")[0]);
                return Tool("context_read"); // contract 3 expires object references on every write
            }
            if (i == 3)
                return Tool("world_record", new NarrativeHarnessArgs("第二段叙事仍须保存。", [new(original!.Id, original.Kind, original.Name, original.Summary, original.Status, original.SceneId)], Complete: false));
            if (i == 4)
            {
                Check.Equal(0, Output(request, "world_record").GetProperty("memory").GetArrayLength());
                return Tool("ask_player", new { question = "下一步？" });
            }
            return Text("已经保存原记忆与新叙事。");
        });
        var host = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(host); string id = owner.Snapshot.Id;
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "记下线索");
            var run = await Post<HarnessRunView>(host, id, "harness/runs", request); run = await Settled(host, id, run.Id);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            var snapshot = (await host.Get(id))!; Check.Equal(original!, snapshot.WorldMemory!.Single());
            Check.True(snapshot.Events.Any(e => e.Narrative == "第二段叙事仍须保存。"));
            int version = snapshot.Version;
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, configure: Configure(model));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", request)).Replayed);
            Check.Equal(4, model.Calls); Check.Equal(version, (await host.Get(id))!.Version);
            await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), version, "继续"));
            run = await Settled(host, id, run.Id); Check.Equal("completed", run.Status);
            Check.Equal(original!, (await host.Get(id))!.WorldMemory!.Single()); Check.Equal(5, model.Calls);
        }
        finally { await host.DisposeAsync(); }
    }
}
