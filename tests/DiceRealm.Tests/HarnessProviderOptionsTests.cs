using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessProviderOptionsTests
{
    private const string Secret = "private-options-sentinel";
    private sealed class Wire(Func<int, JsonElement, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public readonly List<string> Bodies = [];
        public readonly List<long> Times = [];
        public int Calls => Bodies.Count;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            string body = await request.Content!.ReadAsStringAsync(ct);
            Bodies.Add(body); Times.Add(Stopwatch.GetTimestamp());
            using var doc = JsonDocument.Parse(body);
            return await respond(Bodies.Count, doc.RootElement, ct);
        }
    }
    private sealed class Capture<T> : ILogger<T>
    {
        public readonly List<string> Lines = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> format)
        { Check.True(exception is null); Lines.Add(format(state, exception)); }
    }
    private static IConfigurationRoot Config(string protocol = "gemini") => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["DataPath"] = Path.Combine(Path.GetTempPath(), "harness-options-" + Id()),
        ["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/v1", ["HarnessAi:Endpoint"] = protocol,
        ["HarnessAi:Model"] = "fake-model", ["HarnessAi:ApiKey"] = Secret,
        ["HarnessAi:RetryInitialDelayMilliseconds"] = "1",
        ["ProviderLimits:TextTotal"] = "100", ["ProviderLimits:TextDaily"] = "100", ["ProviderLimits:TextCampaignDaily"] = "100"
    }).Build();
    private static HarnessModelRequest Request() => new("系统中文原文", [new("user", "玩家中文原文")], HarnessTools.All, 4096);
    private static HttpResponseMessage Raw(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status)
    { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    private static HttpResponseMessage Gemini(HarnessModelReply reply) => Raw(HarnessJson.Serialize(new
    {
        candidates = new[] { new { finishReason = "STOP", content = new { role = "model", parts = NativeParts(reply) } } },
        usageMetadata = new { promptTokenCount = 10, candidatesTokenCount = 3, thoughtsTokenCount = 7 }
    }));
    private static object[] NativeParts(HarnessModelReply reply) => [new { text = Secret, thought = true }, new { text = reply.Text, thoughtSignature = "c2lnbg==" },
        .. reply.ToolCalls.Select(t => (object)new { functionCall = new { name = t.Name, args = t.Arguments, id = t.Id }, thoughtSignature = "c2lnbg==" })];
    private static HttpResponseMessage OpenAi() => Raw("""{"choices":[{"finish_reason":"stop","message":{"content":"完成","tool_calls":null}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}""");
    private static async Task<Exception> Failure(Func<Task> call)
    {
        try { await call(); } catch (Exception ex) { return ex; }
        throw new Exception("Expected provider rejection");
    }
    public static async Task ReadableUnicodeThinkingAndFrozenHistory()
    {
        const string literal = "字面反斜杠 \\u4e2d 与引号\"换行\n保留";
        string turn = HarnessJson.Serialize(new { input = "观察灯塔 " + literal, ruleset = "dnd2024", memory = new { text = "历史潮痕与守港人" } });
        string tool = HarnessJson.Serialize(new { text = "工具中文结果", literal });
        foreach (string protocol in new[] { "gemini", "openai-chat" })
        {
            var config = Config(protocol); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
            using var wire = new Wire((_, _, _) => Task.FromResult(protocol == "gemini" ? Gemini(Tool("context_read")) : OpenAi()));
            using var http = new HttpClient(wire);
            IHarnessModel model = protocol == "gemini" ? new GeminiHarnessModel(http, config, budget) : new OpenAiHarnessModel(http, config, budget);
            var request = Request() with { Messages = [new("user", turn)] };
            string before = HarnessJson.Serialize(request), fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(request));
            var first = await model.Complete(request, Id(), default);
            Check.Equal(before, HarnessJson.Serialize(request)); Check.Equal(fingerprint, HarnessJson.Fingerprint(HarnessJson.Element(request)));
            Check.True(wire.Bodies[0].Contains("系统中文原文") && wire.Bodies[0].Contains("观察灯塔") && wire.Bodies[0].Contains("历史潮痕与守港人"));
            Check.True(!wire.Bodies[0].Contains("\\u89C2", StringComparison.OrdinalIgnoreCase));
            using var body = JsonDocument.Parse(wire.Bodies[0]);
            string actual = protocol == "gemini" ? body.RootElement.GetProperty("contents")[0].GetProperty("parts")[0].GetProperty("text").GetString()! :
                body.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!;
            Check.True(actual.Contains("观察灯塔") && actual.Contains("历史潮痕与守港人"));
            using var inner = JsonDocument.Parse(actual); Check.Equal("观察灯塔 " + literal, inner.RootElement.GetProperty("input").GetString());
            if (protocol == "gemini")
            {
                var thinking = body.RootElement.GetProperty("generationConfig").GetProperty("thinkingConfig");
                Check.Equal("high", thinking.GetProperty("thinkingLevel").GetString()); Check.True(thinking.GetProperty("includeThoughts").GetBoolean());
                Check.True(!first.Text.Contains(Secret)); Check.Equal(10, first.OutputTokens);
                var next = request with { Messages = [.. request.Messages, new("assistant", first.Text, first.ToolCalls), new("tool", tool, ToolCallId: first.ToolCalls[0].Id, Name: "context_read")], ProviderHistory = [new(first, first.ProviderContinuation)] };
                await model.Complete(next, Id(), default);
                using var follow = JsonDocument.Parse(wire.Bodies[1]);
                Check.Equal(HarnessJson.Fingerprint(HarnessJson.Element(NativeParts(Tool("context_read")))),
                    HarnessJson.Fingerprint(follow.RootElement.GetProperty("contents")[1].GetProperty("parts")));
                string output = follow.RootElement.GetProperty("contents")[2].GetProperty("parts")[0].GetProperty("functionResponse").GetProperty("response").GetProperty("output").GetString()!;
                Check.True(output.Contains("工具中文结果")); using var parsed = JsonDocument.Parse(output); Check.Equal(literal, parsed.RootElement.GetProperty("literal").GetString());
            }
            else
            {
                Check.Equal("high", body.RootElement.GetProperty("reasoning_effort").GetString());
                var next = request with { Messages = [..request.Messages, new("assistant", "", [new("previous", "context_read", HarnessJson.Element(new { query = "灯塔" }))]), new("tool", tool, ToolCallId: "previous", Name: "context_read")] };
                await model.Complete(next, Id(), default);
                using var follow = JsonDocument.Parse(wire.Bodies[1]);
                Check.True(follow.RootElement.GetProperty("messages")[3].GetProperty("content").GetString()!.Contains("工具中文结果"));
                Check.True(follow.RootElement.GetProperty("messages")[2].GetProperty("tool_calls")[0].GetProperty("function").GetProperty("arguments").GetString()!.Contains("灯塔"));
            }
            // Plain user text and its literal escape sequence are not decoded as arbitrary JSON.
            await model.Complete(Request() with { Messages = [new("user", literal)] }, Id(), default);
            using var plain = JsonDocument.Parse(wire.Bodies[^1]);
            string plainText = protocol == "gemini" ? plain.RootElement.GetProperty("contents")[0].GetProperty("parts")[0].GetProperty("text").GetString()! : plain.RootElement.GetProperty("messages")[1].GetProperty("content").GetString()!;
            Check.Equal(literal, plainText);
            await model.Complete(Request() with { Messages = [new("user", "初始原文"), new("user", turn)] }, Id(), default);
            using var userJson = JsonDocument.Parse(wire.Bodies[^1]);
            string preserved = protocol == "gemini" ? userJson.RootElement.GetProperty("contents")[1].GetProperty("parts")[0].GetProperty("text").GetString()! : userJson.RootElement.GetProperty("messages")[2].GetProperty("content").GetString()!;
            Check.Equal(turn, preserved); // later user-authored JSON is not the system-owned first envelope

        }
    }
    public static async Task ConfigurationDefaultsOverridesAndValidation()
    {
        var config = Config(); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
        using var wire = new Wire((_, _, _) => Task.FromResult(Gemini(Text()))); using var http = new HttpClient(wire);
        config["HarnessAi:ThinkingLevel"] = "low"; config["HarnessAi:IncludeThoughts"] = "false";
        await new GeminiHarnessModel(http, config, budget).Complete(Request(), Id(), default);
        using var doc = JsonDocument.Parse(wire.Bodies.Single()); var thinking = doc.RootElement.GetProperty("generationConfig").GetProperty("thinkingConfig");
        Check.Equal("low", thinking.GetProperty("thinkingLevel").GetString()); Check.True(!thinking.GetProperty("includeThoughts").GetBoolean());
        config["HarnessAi:ThinkingLevel"] = "off";
        await new GeminiHarnessModel(http, config, budget).Complete(Request(), Id(), default);
        using var off = JsonDocument.Parse(wire.Bodies[^1]); Check.Equal(0, off.RootElement.GetProperty("generationConfig").GetProperty("thinkingConfig").GetProperty("thinkingBudget").GetInt32());
        config["HarnessAi:Endpoint"] = "openai-chat";
        using var openWire = new Wire((_, _, _) => Task.FromResult(OpenAi())); using var openHttp = new HttpClient(openWire);
        await new OpenAiHarnessModel(openHttp, config, budget).Complete(Request(), Id(), default);
        using var open = JsonDocument.Parse(openWire.Bodies.Single()); Check.True(!open.RootElement.TryGetProperty("reasoning_effort", out _));
        foreach (var (key, value) in new[] { ("ThinkingLevel", "invalid"), ("IncludeThoughts", "yes"), ("RetryCount", "-1"), ("RetryCount", "11"), ("RetryInitialDelayMilliseconds", "0"), ("RetryInitialDelayMilliseconds", "60001"), ("AttemptTimeoutSeconds", "0"), ("AttemptTimeoutSeconds", "601") })
        {
            var invalid = Config(); invalid["HarnessAi:" + key] = value;
            Check.Throws<InvalidOperationException>(() => new GeminiHarnessModel(http, invalid, budget));
        }
        Check.Equal(2, wire.Calls); Check.Equal(1, openWire.Calls);
    }
    public static async Task DefaultThreeIncreasingRetriesAndDurableBudget()
    {
        var config = Config(); config["HarnessAi:RetryInitialDelayMilliseconds"] = null; // prove real default 1,2,4 seconds
        using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        var log = new Capture<GeminiHarnessModel>(); int extra = 0;
        using var wire = new Wire((i, _, _) => Task.FromResult(i < 4 ? Raw("{\"usageMetadata\":{}}") : Gemini(Text("恢复完成"))));
        using var http = new HttpClient(wire);
        var request = Request() with { BeforeProviderRetry = _ => { extra++; return Task.CompletedTask; } };
        Check.Equal(HarnessJson.Serialize(Request()), HarnessJson.Serialize(request));
        var reply = await new GeminiHarnessModel(http, config, budget, log).Complete(request, campaign, default);
        Check.Equal("恢复完成", reply.Text); Check.Equal(4, wire.Calls); Check.Equal(3, extra);
        Check.Equal(1, wire.Bodies.Distinct().Count()); Check.Equal(4, new ProviderBudget(data, config).Read("text", campaign, true).Total);
        for (int i = 1; i < 4; i++) Check.True(Stopwatch.GetElapsedTime(wire.Times[i - 1], wire.Times[i]).TotalMilliseconds >= (1000 << (i - 1)) - 50);
        foreach (int delay in new[] { 1000, 2000, 4000 }) Check.True(log.Lines.Any(l => l.Contains("delayMs=" + delay)));
        Check.True(log.Lines.All(l => !l.Contains(Secret) && !l.Contains("玩家中文原文")));
    }
    private sealed class HistorianClients(Wire wire) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(wire, disposeHandler: false);
    }
    public static async Task HistorianThreeRetriesFrozenInputAndAuthorization()
    {
        HarnessHistoryFragment[] sources = [new(new("event", "ended-dialogue", 12, "public", "revision"),
            "public", "player", "伊岚", "dialogue", "只有修桥后才考虑带路，尚未接受。", 12)];
        string summary = HarnessJson.Serialize(new HarnessHistoryText("尚未接受。", "尚未接受。"));
        foreach (string protocol in new[] { "gemini", "openai-chat" })
        {
            var config = Config();
            config["TextAi:Endpoint"] = protocol; config["TextAi:BaseUrl"] = "http://127.0.0.1:1/v1";
            config["TextAi:ApiKey"] = Secret; config["TextAi:Model"] = "history-helper";
            using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
            var settings = new AiConfigurationStore(data, config);
            int authorized = 0; string campaign = Id();
            using (var wire = new Wire((i, _, _) => Task.FromResult(i switch
            {
                1 => Raw("", HttpStatusCode.ServiceUnavailable),
                2 => Raw(protocol == "gemini" ? "{\"candidates\":[]}" : "{\"choices\":[]}"),
                3 => Raw("{broken"),
                _ => protocol == "gemini" ? Gemini(Text(summary)) : Raw(HarnessJson.Serialize(new
                {
                    choices = new[] { new { finish_reason = "stop", message = new { content = summary } } },
                    usage = new { prompt_tokens = 10, completion_tokens = 3 }
                }))
            })))
            {
                var historian = new ConfiguredHarnessHistorian(settings, new HistorianClients(wire), budget).Capture();
                var result = await historian.Summarize(sources, _ => { authorized++; return Task.CompletedTask; }, campaign, default);
                Check.Equal("尚未接受。", result.Detailed); Check.Equal("尚未接受。", result.Brief);
                Check.Equal(4, wire.Calls); Check.Equal(4, authorized); Check.Equal(1, wire.Bodies.Distinct().Count());
                Check.Equal(4, new ProviderBudget(data, config).Read("text", campaign, true).Total);
            }
            string[] rejectedBodies = protocol == "gemini" ?
            [
                """{"promptFeedback":{"blockReason":"SAFETY"}}""",
                """{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"{broken"}]}}]}"""
            ] :
            [
                """{"choices":[{"finish_reason":"length","message":{"content":"{broken"}}]}""",
                """{"choices":[{"finish_reason":"content_filter","message":{}}]}""",
                """{"choices":[{"finish_reason":"stop","message":{"refusal":"denied","content":"{broken"}}]}"""
            ];
            foreach (string body in rejectedBodies)
            {
                using var wire = new Wire((_, _, _) => Task.FromResult(Raw(body)));
                campaign = Id();
                var historian = new ConfiguredHarnessHistorian(settings, new HistorianClients(wire), budget);
                await Failure(() => historian.Summarize(sources, _ => Task.CompletedTask, campaign, default));
                Check.Equal(1, wire.Calls);
                Check.Equal(1, new ProviderBudget(data, config).Read("text", campaign, true).CampaignToday);
            }
            foreach (string failure in new[] { "unauthorized", "cancelled", "revoked" })
            {
                using var cancelled = new CancellationTokenSource();
                authorized = 0; campaign = Id();
                using var wire = new Wire((_, _, _) =>
                {
                    if (failure == "cancelled") { cancelled.Cancel(); throw new HttpRequestException(Secret); }
                    return Task.FromResult(Raw("", failure == "unauthorized" ? HttpStatusCode.Unauthorized : HttpStatusCode.ServiceUnavailable));
                });
                var historian = new ConfiguredHarnessHistorian(settings, new HistorianClients(wire), budget);
                var error = await Failure(() => historian.Summarize(sources, _ =>
                {
                    authorized++;
                    if (failure == "revoked" && authorized > 1) throw new UnauthorizedAccessException();
                    return Task.CompletedTask;
                }, campaign, cancelled.Token));
                Check.Equal(1, wire.Calls); Check.Equal(failure == "revoked" ? 2 : 1, authorized);
                Check.Equal(1, new ProviderBudget(data, config).Read("text", campaign, true).CampaignToday);
                if (failure == "revoked") Check.True(error is UnauthorizedAccessException);
            }
        }
    }
    public static async Task SilentHangTimesOutAndRetries()
    {
        var config = Config(); config["HarnessAi:AttemptTimeoutSeconds"] = "1"; config["HarnessAi:RetryInitialDelayMilliseconds"] = "1";
        using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        // The first attempt never answers; only its own limit may end it, not the caller's token.
        using var wire = new Wire(async (i, _, ct) => { if (i == 1) await Task.Delay(Timeout.Infinite, ct); return Gemini(Text("恢复完成")); });
        using var http = new HttpClient(wire);
        var reply = await new GeminiHarnessModel(http, config, budget).Complete(Request(), campaign, default);
        Check.Equal("恢复完成", reply.Text); Check.Equal(2, wire.Calls); Check.Equal(1, wire.Bodies.Distinct().Count());
        Check.Equal(2, new ProviderBudget(data, config).Read("text", campaign, true).Total);
    }
    public static async Task RetryClassificationsCancellationAndQuota()
    {
        var config = Config("openai-chat"); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        using (var wire = new Wire((i, _, _) => Task.FromResult(i switch
        { 1 => Raw("", HttpStatusCode.ServiceUnavailable), 2 => Raw("", HttpStatusCode.TooManyRequests), 3 => Raw("{broken"), _ => OpenAi() })))
        using (var http = new HttpClient(wire))
        {
            await new OpenAiHarnessModel(http, config, budget).Complete(Request(), campaign, default);
            Check.Equal(4, wire.Calls); Check.Equal(1, wire.Bodies.Distinct().Count());
        }
        foreach (var status in new[] { HttpStatusCode.BadRequest, HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.NotFound })
        {
            using var wire = new Wire((_, _, _) => Task.FromResult(Raw(Secret, status))); using var http = new HttpClient(wire);
            await Failure(() => new OpenAiHarnessModel(http, config, budget).Complete(Request(), campaign, default)); Check.Equal(1, wire.Calls);
        }
        foreach (string body in new[] { "{\"choices\":[{\"finish_reason\":\"content_filter\",\"message\":{}}]}", "{\"choices\":[{\"finish_reason\":\"length\",\"message\":{}}]}" })
        {
            using var wire = new Wire((_, _, _) => Task.FromResult(Raw(body))); using var http = new HttpClient(wire);
            await Failure(() => new OpenAiHarnessModel(http, config, budget).Complete(Request(), campaign, default)); Check.Equal(1, wire.Calls);
        }
        using (var wire = new Wire((i, _, _) => i == 1 ? throw new HttpRequestException(Secret) : i == 2 ? throw new TaskCanceledException(Secret) : Task.FromResult(OpenAi())))
        using (var http = new HttpClient(wire))
        { await new OpenAiHarnessModel(http, config, budget).Complete(Request(), campaign, default); Check.Equal(3, wire.Calls); }
        using (var cancelled = new CancellationTokenSource())
        using (var wire = new Wire((_, _, _) => { cancelled.Cancel(); throw new HttpRequestException(Secret); }))
        using (var http = new HttpClient(wire))
        { await Failure(() => new OpenAiHarnessModel(http, config, budget).Complete(Request(), campaign, cancelled.Token)); Check.Equal(1, wire.Calls); }
        using (var wire = new Wire((_, _, _) =>
        {
            var response = Raw("{}", HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(61));
            return Task.FromResult(response);
        }))
        using (var http = new HttpClient(wire))
        { await Failure(() => new OpenAiHarnessModel(http, config, budget).Complete(Request(), campaign, default)); Check.Equal(1, wire.Calls); }
        config["HarnessAi:RetryCount"] = "1";
        using (var wire = new Wire((_, _, _) => Task.FromResult(Raw("{}", HttpStatusCode.RequestTimeout))))
        using (var http = new HttpClient(wire))
        { await Failure(() => new OpenAiHarnessModel(http, config, budget).Complete(Request(), campaign, default)); Check.Equal(2, wire.Calls); }
        config["HarnessAi:RetryCount"] = "3";
        var quotaConfig = Config(); quotaConfig["ProviderLimits:TextTotal"] = "1";
        using var quotaData = new DataDirectory(quotaConfig); var quota = new ProviderBudget(quotaData, quotaConfig);
        using var bad = new Wire((_, _, _) => Task.FromResult(Raw("{}"))); using var badHttp = new HttpClient(bad);
        var failed = await Failure(() => new GeminiHarnessModel(badHttp, quotaConfig, quota).Complete(Request(), campaign, default));
        Check.True(failed is ProviderQuotaException && failed is not HarnessModelNotSentException); Check.Equal(1, bad.Calls);
        Check.Equal(1, quota.Read("text", campaign, true).Total);
        config["HarnessAi:RetryCount"] = "0";
        using var disabled = new Wire((_, _, _) => Task.FromResult(Raw("{}"))); using var disabledHttp = new HttpClient(disabled);
        await Failure(() => new OpenAiHarnessModel(disabledHttp, config, budget).Complete(Request(), campaign, default)); Check.Equal(1, disabled.Calls);
    }
    private static Action<WebApplicationBuilder> Provider(Wire wire, int maximum = 16, int delay = 1) => b =>
    {
        b.Configuration["Harness:Enabled"] = "true"; b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
        b.Configuration["Harness:MaxModelCalls"] = maximum.ToString(); b.Configuration["HarnessAi:RetryInitialDelayMilliseconds"] = delay.ToString();
        b.Configuration["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/v1"; b.Configuration["HarnessAi:Endpoint"] = "gemini";
        b.Configuration["HarnessAi:Model"] = "fake-model"; b.Configuration["HarnessAi:ApiKey"] = Secret;
        b.Services.AddHttpClient<GeminiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => wire);
    };
    private static HarnessRun Stored(Host h, CreatedCampaign owner, string id) => h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, owner.Snapshot.Party!.SelfActorId, id)!;
    private static int Usage(Host h, string id) => h.App.Services.GetRequiredService<ProviderBudget>().Read("text", id, true).Total;
    public static async Task RealPiRetryNeverRepeatsCommittedToolAndReplay()
    {
        using var wire = new Wire((i, _, _) => Task.FromResult(i switch
        {
            1 => Gemini(Tool("world_record", new NarrativeHarnessArgs("重试前已记线索。", [new("", "clue", "唯一重试线索", "只提交一次", "known", "harbor")], Complete: false))),
            2 => Raw("{\"usageMetadata\":{}}"), _ => Gemini(Text("重试后完成。"))
        }));
        var dice = new SequenceDice(); string root, bytes; CreatedCampaign owner; HarnessInputRequest input; HarnessRunView run;
        await using (var h = await Host.Start(dice: dice, configure: Provider(wire)))
        {
            root = h.Root; owner = await Create(h); string id = owner.Snapshot.Id;
            input = new(Id(), owner.Snapshot.Version, "记录一次线索后完成");
            run = await Post<HarnessRunView>(h, id, "harness/runs", input); run = await Settled(h, id, run.Id, maximumPolls: 3000);
            Check.Equal("completed", run.Status); Check.Equal(3, run.ModelAttempts); Check.Equal(1, run.ToolSteps); Check.Equal(3, wire.Calls); Check.Equal(3, Usage(h, id));
            Check.Equal(wire.Bodies[1], wire.Bodies[2]); Check.Equal(0, dice.Count);
            var logged = h.App.Services.GetRequiredService<ModelRequestLog>().List(id, null, 10, false).Requests.Reverse().ToArray();
            Check.True(logged.Length == 3 && logged.All(e => e.RunId == run.Id && e.Input == "记录一次线索后完成" && e.Finished && e.Client == "GeminiHarnessModel"));
            Check.Equal("1,1,2", string.Join(',', logged.Select(e => e.Attempt)));
            var snapshot = (await h.Get(id))!; Check.Equal(owner.Snapshot.Version + 2, snapshot.Version);
            Check.Equal(1, snapshot.WorldMemory!.Count(x => x.Name == "唯一重试线索"));
            var saved = Stored(h, owner, run.Id); Check.Equal(2, saved.Steps.Count(s => s.Kind == "model")); Check.True(saved.Steps.All(s => s.Status == "done"));
            bytes = HarnessJson.Serialize(saved);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed); Check.Equal(3, wire.Calls);
        }
        await using (var h = await Host.Start(root, dice: dice, configure: Provider(wire)))
        {
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); string id = owner.Snapshot.Id;
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed); Check.Equal(3, wire.Calls); Check.Equal(3, Usage(h, id));
            Check.Equal(bytes, HarnessJson.Serialize(Stored(h, owner, run.Id))); Check.Equal(0, dice.Count);
        }
    }
    public static async Task RealPiExhaustionLimitCancellationAndRestart()
    {
        foreach (int cap in new[] { 16, 2 })
        {
            using var wire = new Wire((_, _, _) => Task.FromResult(Raw("{}"))); string root; CreatedCampaign owner; HarnessInputRequest input;
            int expected = Math.Min(4, cap);
            await using (var h = await Host.Start(configure: Provider(wire, cap)))
            {
                root = h.Root; owner = await Create(h); string id = owner.Snapshot.Id; input = new(Id(), owner.Snapshot.Version, "模型故障没有游戏行动");
                var run = await Post<HarnessRunView>(h, id, "harness/runs", input); run = await Settled(h, id, run.Id, maximumPolls: 3000);
                Check.Equal("unknown", run.Status); Check.Equal(expected, run.ModelAttempts); Check.Equal(expected, wire.Calls); Check.Equal(expected, Usage(h, id));
                Check.Equal(0, run.ToolSteps); Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version);
                Check.Equal("started", Stored(h, owner, run.Id).Steps.Single().Status);
            }
            await using (var h = await Host.Start(root, configure: Provider(wire, cap)))
            {
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                var replay = await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", input);
                Check.True(replay.Replayed); Check.Equal("unknown", replay.Status); Check.Equal(expected, wire.Calls); Check.Equal(expected, Usage(h, owner.Snapshot.Id));
            }
        }
        using var first = new SemaphoreSlim(0);
        using var cancelWire = new Wire((_, _, _) => { first.Release(); return Task.FromResult(Raw("{}")); });
        await using var host = await Host.Start(configure: Provider(cancelWire, delay: 1000)); var player = await Create(host);
        var pending = await Start(host, player.Snapshot); await first.WaitAsync(TimeSpan.FromSeconds(10));
        using var cancel = await host.Http.PostAsync($"/api/v1/campaigns/{player.Snapshot.Id}/harness/runs/{pending.Id}/cancel", null);
        Check.Equal(HttpStatusCode.OK, cancel.StatusCode);
        var settled = await Settled(host, player.Snapshot.Id, pending.Id, maximumPolls: 3000);
        Check.Equal("unknown", settled.Status); Check.Equal(1, cancelWire.Calls); Check.Equal(1, settled.ModelAttempts); Check.Equal(0, settled.ToolSteps);
    }
    public static async Task RetryRechecksCurrentVersionAndDeadline()
    {
        foreach (bool deadline in new[] { false, true })
        {
            using var first = new SemaphoreSlim(0);
            using var wire = new Wire((_, _, _) => { first.Release(); return Task.FromResult(Raw("{}")); });
            await using var h = await Host.Start(configure: b =>
            {
                Provider(wire, delay: deadline ? 2000 : 500)(b);
                if (deadline) { b.Configuration["Harness:TimeoutSeconds"] = "1"; b.Services.AddSingleton<IHarnessRuntime>(new Loop()); }
            });
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var run = await Start(h, owner.Snapshot);
            Check.True(await first.WaitAsync(TimeSpan.FromSeconds(10)));
            if (!deadline)
            {
                var action = await h.Act(owner.Snapshot, "observe");
                Check.True(action.Snapshot.Version > owner.Snapshot.Version);
            }
            run = await Settled(h, id, run.Id, maximumPolls: 3000);
            Check.Equal("unknown", run.Status); Check.Equal(1, wire.Calls); Check.Equal(1, run.ModelAttempts); Check.Equal(1, Usage(h, id));
            Check.Equal(0, run.ToolSteps);
        }
    }

}
