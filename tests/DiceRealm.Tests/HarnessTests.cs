using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class HarnessTests
{
    internal static string Id() => Guid.NewGuid().ToString();
    internal static readonly HarnessPreset Preset = new("test-only-preset", 1, "  用户原文\n不替换 system prompt。\n");
    internal sealed class Model(Func<int, HarnessModelRequest, CancellationToken, Task<HarnessModelReply>> complete) : IHarnessModel
    {
        private int calls;
        public int Calls => calls;
        public bool Enabled => true;
        public List<HarnessModelRequest> Requests { get; } = [];
        // First assertion thrown inside the scripted reply; the run itself only reports harness_model_unknown.
        public Exception? Failure { get; private set; }
        public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
        {
            Requests.Add(request);
            try { return await complete(Interlocked.Increment(ref calls), request, ct); }
            catch (Exception e) when (e is not OperationCanceledException) { Failure ??= e; throw; }
        }
        public Model(Func<int, HarnessModelRequest, HarnessModelReply> complete) : this((i, r, _) => Task.FromResult(complete(i, r))) { }
    }
    // Test double for coordinator failure injection. Real Pi/MCP tests use PiHarnessRuntime instead.
    internal sealed class Loop : IHarnessRuntime
    {
        public int Executions;
        public async Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct)
        {
            Executions++;
            var messages = new List<HarnessChatMessage>(); int models = 0, tools = 0;
            string text = ""; bool stopped = false;
            for (int turn = 0; turn < execution.Turns.Length; turn++)
            {
                messages.Add(new("user", execution.Turns[turn])); stopped = false;
                int sequence = 0, toolSequence = 0;
                while (true)
                {
                    var reply = HarnessJson.Read<HarnessModelReply>(await callback(new($"{turn}:model:{sequence}", "model", turn, sequence++,
                        HarnessJson.Element(new HarnessModelRequest(execution.SystemPrompt, messages.ToArray(), execution.Tools, 4096))), ct));
                    models++; text = reply.Text;
                    messages.Add(new("assistant", text, reply.ToolCalls));
                    foreach (var tool in reply.ToolCalls)
                    {
                        if (stopped) { messages.Add(new("tool", "stopped", ToolCallId: tool.Id, Name: tool.Name, IsError: true)); continue; }
                        var result = HarnessJson.Read<HarnessToolReply>(await callback(new($"{turn}:tool:{toolSequence}", "tool", turn, toolSequence++,
                            HarnessJson.Element(new HarnessToolRequest(tool.Name, tool.Arguments, tool.Id))), ct));
                        tools++; messages.Add(new("tool", result.Content, ToolCallId: tool.Id, Name: tool.Name, IsError: result.IsError));
                        stopped = result.Stop;
                    }
                    if (stopped || reply.ToolCalls.Length == 0) break;
                }
            }
            return new(stopped, text, models, tools);
        }
    }
    internal static HarnessModelReply Tool(string name, object? args = null, string id = "tool-1") =>
        new("", [new(id, name, HarnessJson.Element(args ?? new { }))], 10, 10);
    internal static HarnessModelReply Text(string text = "检定已经结算，公开叙事已保存。") => new(text, [], 10, 10);
    internal static string Candidate(HarnessModelRequest request, string label)
    {
        var last = request.Messages.Last(m => m.Role == "tool");
        using var document = JsonDocument.Parse(last.Content);
        var root = document.RootElement;
        var candidates = root.TryGetProperty("context", out var context) ? context.GetProperty("intent").GetProperty("candidates") : root.GetProperty("candidates");
        return candidates.EnumerateArray().Single(x => x.GetProperty("label").GetString() == label).GetProperty("id").GetString()!;
    }
    internal static Model AdventureModel() => new((i, r) => i switch
    {
        1 => Tool("context_read"),
        2 => Tool("actions_propose", new { candidateId = Candidate(r, TestContent.Document.Scenes.Single(s => s.Id == "harbor").Actions.Single(a => a.Kind == "investigate").Label) }),
        3 => Tool("checks_result"),
        4 => Tool("world_record", new NarrativeHarnessArgs("发现一份公开线索。", [new("", "clue", "Harness 回归线索", "仅用于隔离测试的非机械信息。", "known", "harbor")])),
        5 => Text(),
        _ => throw new Exception("Unexpected real model call " + i)
    });
    internal static Action<WebApplicationBuilder> Configure(IHarnessModel model, IHarnessRuntime? runtime = null, Action<WebApplicationBuilder>? extra = null) => b =>
    {
        b.Configuration["Harness:Enabled"] = "true";
        b.Services.AddSingleton(model);
        b.Services.AddSingleton<IHarnessRuntime>(runtime ?? new Loop());
        extra?.Invoke(b);
    };
    internal static async Task<CreatedCampaign> Create(Host h, AdventureDocument? adventure = null, string template = CharacterEngine.Fighter, HarnessSkill[]? skills = null)
    {
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("隔离 Harness", "Arden", adventure ?? TestContent.Document,
            Preset, skills ?? [new("test-skill", "只读用户技能说明", "技能原文\n不能执行 shell。")], Build: FullCreationTests.Named("Arden", template)));
        if (!response.IsSuccessStatusCode) throw new Exception(await response.Content.ReadAsStringAsync());
        var result = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", result.AccessToken); return result;
    }
    internal static async Task<HarnessRunView> Start(Host h, CampaignSnapshot s, string text = "调查现场") =>
        await Post<HarnessRunView>(h, s.Id, "harness/runs", new HarnessInputRequest(Id(), s.Version, text));
    // Only historical contract tests use this persisted fixture; production has no downgrade switch.
    internal static Task<HarnessRunView> StartV14(Host h, string campaign, HarnessInputRequest request) => StartHistorical(h, campaign, request, 14);
    internal static async Task<HarnessRunView> StartHistorical(Host h, string campaign, HarnessInputRequest request, int contract)
    {
        string token = h.Http.DefaultRequestHeaders.Authorization!.Parameter!;
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(campaign, token, default);
        var context = await game.ValidateHarnessStart(campaign, token, request.ExpectedVersion, default, request.Text);
        var run = new HarnessRun
        {
            Id = request.RequestId, IntentId = Id(), CampaignId = campaign, ActorId = auth.ActorId,
            Fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(request)), Input = request.Text,
            Profile = context.Profile, MemorySnapshot = context.Memory, Version = request.ExpectedVersion,
            ToolContractVersion = contract, RulesCatalogVersion = context.RulesCatalogVersion, Limits = new(),
            Turns = [HarnessJson.Serialize(new { input = request.Text, ruleset = "dnd2024", memory = context.Memory })]
        };
        h.App.Services.GetRequiredService<HarnessRunStore>().Create(run);
        return await Post<HarnessRunView>(h, campaign, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version));
    }
    internal static async Task<T> Post<T>(Host h, string campaign, string route, object body)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/{route}", body);
        if (!response.IsSuccessStatusCode) throw new Exception(response.StatusCode + " " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<T>())!;
    }
    internal static async Task<HarnessRunView> Settled(Host h, string campaign, string id, int maximumPolls = 400)
    {
        for (int i = 0; i < maximumPolls; i++)
        {
            var run = (await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{campaign}/harness/runs/{id}"))!;
            if (run.Status is not ("running" or "cancelling")) return run;
            await Task.Delay(25);
        }
        throw new Exception("Harness did not settle");
    }
    public static async Task ConsentReplayAndRestart()
    {
        var dice = new SequenceDice(18); var model = AdventureModel(); var loop = new Loop();
        var h = await Host.Start(dice: dice, broken: new BrokenText(), configure: Configure(model, loop));
        var owner = await Create(h); var s = owner.Snapshot;
        Check.Equal("active", s.Content!.Status); Check.True(s.Content.Prompts is null);
        var request = new HarnessInputRequest(Id(), s.Version, "调查现场");
        var initial = await Post<HarnessRunView>(h, s.Id, "harness/runs", request);
        var run = await Settled(h, s.Id, initial.Id);
        Check.Equal("waiting", run.Status); Check.Equal("roll", run.Wait!.Kind); Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
        s = (await h.Get(s.Id))!; Check.True(s.PendingRoll is not null); Check.Equal(run.Version, s.Version);
        // Neither prose confirmation nor direct runtime resume can consent to a roll.
        var premature = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version));
        Check.Equal(HttpStatusCode.Conflict, premature.StatusCode); Check.Equal(0, dice.Count);
        var replay = await Post<HarnessRunView>(h, s.Id, "harness/runs", request);
        Check.True(replay.Replayed); Check.Equal(1, loop.Executions);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/harness/runs", request with { Text = "不同" })).StatusCode);
        var roll = new RollResponseRequest(Id(), s.Version, run.Wait.Id, "roll");
        var rolled = await Post<ActionResponse>(h, s.Id, "rolls/respond", roll); s = rolled.Snapshot;
        Check.Equal(1, dice.Count); Check.True(rolled.Resolution.Check is not null); Check.Equal(2, model.Calls);
        var root = h.Root; await h.DisposeAsync();
        h = await Host.Start(root, dice, broken: new BrokenText(), configure: Configure(model, loop));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Check.Equal("waiting", (await Settled(h, s.Id, run.Id)).Status); Check.Equal(2, model.Calls);
        var resume = new HarnessResumeRequest(Id(), s.Version);
        await Post<HarnessRunView>(h, s.Id, $"harness/runs/{run.Id}/resume", resume);
        run = await Settled(h, s.Id, run.Id);
        Check.Equal("completed", run.Status); Check.Equal(4, model.Calls); Check.Equal(1, dice.Count);
        Check.True(model.Requests.All(r => r.System == Preset.SystemPrompt));
        s = (await h.Get(s.Id))!; Check.Equal(1, s.WorldMemory!.Count(m => m.Name == "Harness 回归线索"));
        var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!;
        Check.Equal(1, activity.Entries.Length); Check.Equal("调查现场", activity.Entries[0].Origin!.Input);
        var detail = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{s.Id}/activity/{activity.Entries[0].Sequence}"))!;
        Check.Equal(rolled.Resolution.Check!.Total, detail.InitialResult!.Check!.Total);
        Check.Equal(rolled.Resolution.RollId, detail.InitialResult.RollId);
        Check.Equal(run.Text, detail.Narrative);
        Check.True(detail.Steps!.Any(step => step.Result.RollId == rolled.Resolution.RollId && step.Result.Check is not null));
        Check.True((await Post<HarnessRunView>(h, s.Id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
        Check.True((await Post<ActionResponse>(h, s.Id, "rolls/respond", roll)).Replayed); Check.Equal(1, dice.Count);
        var legacy = new ActionRequest(Id(), s.Version, "natural", Text: "不要调用旧 AI");
        foreach (string route in new[] { "actions", "actions/input", "actions/interpret" })
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/{route}", legacy)).StatusCode);
        await h.DisposeAsync();
    }
    public static async Task SensitiveSourceAndCancelledConsent()
    {
        // Match the label from actual available actions rather than inventing a source command.
        var configured = new Model((i, r) =>
        {
            if (i == 1) return Tool("actions_list");
            using var doc = JsonDocument.Parse(r.Messages.Last(m => m.Role == "tool").Content);
            string choice = doc.RootElement.GetProperty("candidates").EnumerateArray().First(c => c.GetProperty("label").GetString()!.Contains("Mage Armor")).GetProperty("id").GetString()!;
            return Tool("actions_propose", new { candidateId = choice });
        });
        var dice = new SequenceDice(); await using var h = await Host.Start(dice: dice, configure: Configure(configured));
        var owner = await Create(h, template: CharacterEngine.Wizard);
        var run = await Start(h, owner.Snapshot, "法师护甲"); run = await Settled(h, owner.Snapshot.Id, run.Id);
        Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind);
        var s = (await h.Get(owner.Snapshot.Id))!; Check.Equal(2, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
        var cancelled = await Post<ActionResponse>(h, s.Id, "intents/respond", new IntentResponseRequest(Id(), s.Version, run.Wait.Id, "cancel"));
        await Post<HarnessRunView>(h, s.Id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), cancelled.Snapshot.Version));
        run = await Settled(h, s.Id, run.Id); Check.Equal("cancelled", run.Status); Check.Equal(2, configured.Calls);
        Check.Equal(0, dice.Count); Check.Equal(2, CharacterEngine.Value(cancelled.Snapshot.Character.Required(), "Spell Slots (1st)"));
    }
    public static async Task CommittedToolsSurviveModelFailure()
    {
        var model = new Model((i, _) => i == 1 ? Tool("world_record", new NarrativeHarnessArgs("已经保存的公开叙事。",
            [new("", "clue", "已经保存", "不能回滚", "known", "harbor")], Complete: false)) : throw new HttpRequestException("private-provider-sentinel"));
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        var run = await Start(h, owner.Snapshot); run = await Settled(h, owner.Snapshot.Id, run.Id);
        Check.Equal("unknown", run.Status); Check.Equal("harness_model_unknown", run.Error);
        Check.True((await h.Get(owner.Snapshot.Id))!.WorldMemory!.Any(m => m.Name == "已经保存"));
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/harness/runs/{run.Id}/resume",
            new HarnessResumeRequest(Id(), run.Version))).StatusCode);
        Check.Equal(2, model.Calls); Check.True(!HarnessJson.Serialize(run).Contains("sentinel"));
    }
    public static async Task LimitsUnknownAndNonblockingReads()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (_, _, ct) => { entered.SetResult(); await release.Task.WaitAsync(ct); return Text(); });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        var run = await Start(h, owner.Snapshot); await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Check.Equal(owner.Snapshot.Version, (await h.Get(owner.Snapshot.Id))!.Version);
        await h.Http.PostAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/harness/runs/{run.Id}/cancel", null);
        run = await Settled(h, owner.Snapshot.Id, run.Id); Check.Equal("unknown", run.Status); Check.Equal(1, model.Calls);
        release.SetResult(); Check.Equal(owner.Snapshot.Version, (await h.Get(owner.Snapshot.Id))!.Version);
        var infinite = new Model((_, _) => Tool("rules_scope"));
        await using var capped = await Host.Start(configure: Configure(infinite, extra: b => b.Configuration["Harness:MaxModelCalls"] = "2"));
        var c = await Create(capped); var limited = await Start(capped, c.Snapshot); limited = await Settled(capped, c.Snapshot.Id, limited.Id);
        Check.Equal("failed", limited.Status); Check.Equal("harness_model_limit", limited.Error); Check.Equal(2, infinite.Calls);
    }
}
