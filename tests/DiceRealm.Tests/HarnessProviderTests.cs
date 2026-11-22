using System.Net;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessProviderTests
{
    private sealed class Wire(string response) : HttpMessageHandler
    {
        public int Calls;
        public string Body = "";
        public string Authorization = "";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; Body = await request.Content!.ReadAsStringAsync(ct); Authorization = request.Headers.Authorization!.ToString();
            return new(HttpStatusCode.OK) { Content = new StringContent(response, Encoding.UTF8, "application/json") };
        }
    }
    private sealed class Capture : ILogger<OpenAiHarnessModel>
    {
        public List<string> Entries { get; } = [];
        public int ExceptionObjects;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (exception is not null) ExceptionObjects++;
            Entries.Add(formatter(state, exception));
        }
    }
    public static async Task SafeFailureDiagnostics()
    {
        const string secret = "PRIVATE-provider-test-sentinel";
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["HarnessAi:RetryCount"] = "0",
            ["DataPath"] = Path.Combine(Path.GetTempPath(), "harness-provider-log-" + Id()),
            ["HarnessAi:Model"] = secret, ["HarnessAi:ApiKey"] = secret,
            ["HarnessAi:Endpoint"] = "http://127.0.0.1:1/" + secret
        }).Build();
        using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        var request = new HarnessModelRequest(secret, [new("user", secret)], HarnessTools.All, 4096);
        var cases = new[]
        {
            ("""{"choices":[{"finish_reason":"stop","message":{"content":"PRIVATE-provider-test-sentinel","tool_calls":{}}}]}""", "stage=reply", "ToolCalls = Object"),
            ("""{"choices":[{"finish_reason":"PRIVATE-provider-test-sentinel","message":{"content":"PRIVATE-provider-test-sentinel"}}]}""", "stage=reply", "Finish = other"),
            ("{broken PRIVATE-provider-test-sentinel", "stage=json", "Root = Undefined"),
            ("""{"choices":[{"finish_reason":"stop","message":{"content":"PRIVATE-provider-test-sentinel","tool_calls":[]}}],"usage":{"completion_tokens":"PRIVATE-provider-test-sentinel"}}""", "stage=usage", "OutputUsage = String")
        };
        foreach (var (response, stage, shape) in cases)
        {
            using var wire = new Wire(response); using var http = new HttpClient(wire); var capture = new Capture();
            bool failed = false;
            try { await new OpenAiHarnessModel(http, config, budget, capture).Complete(request, campaign, default); }
            catch (Exception ex) when (ex is DiceRealm.Server.Domain.GameException or JsonException or InvalidOperationException) { failed = true; }
            Check.True(failed); Check.Equal(1, wire.Calls); Check.Equal(0, capture.ExceptionObjects);
            string log = capture.Entries.Single();
            Check.True(log.Contains(stage) && log.Contains(shape) && log.Contains("status=200"));
            Check.True(!log.Contains(secret) && !log.Contains(campaign) && !log.Contains("127.0.0.1"));
        }
        Check.Equal(cases.Length, budget.Read("text", campaign, true).Total);
    }
    public static async Task NullableToolCallsAndStrictRejections()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["HarnessAi:RetryCount"] = "0",
            ["DataPath"] = Path.Combine(Path.GetTempPath(), "harness-provider-null-" + Id()),
            ["HarnessAi:Model"] = "fake-harness-model", ["HarnessAi:ApiKey"] = "fake-never-live", ["HarnessAi:Endpoint"] = "http://127.0.0.1:1/v1/chat/completions"
        }).Build();
        using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        var request = new HarnessModelRequest(Preset.SystemPrompt, [new("user", "测试最终文本")], HarnessTools.All, 4096);
        int attempts = 0;
        foreach (string field in new[] { "", ",\"tool_calls\":null", ",\"tool_calls\":[]" })
        {
            using var wire = new Wire("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"有效最终文本\"" + field + "}}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3}}");
            using var http = new HttpClient(wire); var capture = new Capture();
            var reply = await new OpenAiHarnessModel(http, config, budget, capture).Complete(request, campaign, default);
            Check.Equal("有效最终文本", reply.Text); Check.Equal(0, reply.ToolCalls.Length);
            Check.Equal(12, reply.InputTokens); Check.Equal(3, reply.OutputTokens);
            Check.Equal(1, wire.Calls); Check.Equal(0, capture.Entries.Count); attempts++;
        }
        // Nullability does not license other container types, duplicate fields or incomplete output.
        foreach (string value in new[] { "{}", "\"text\"", "1", "false", "[null]" })
        {
            using var wire = new Wire("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"text\",\"tool_calls\":" + value + "}}]}");
            using var http = new HttpClient(wire); bool failed = false;
            try { await new OpenAiHarnessModel(http, config, budget).Complete(request, campaign, default); }
            catch (InvalidOperationException) { failed = true; }
            Check.True(failed); Check.Equal(1, wire.Calls); attempts++;
        }
        foreach (string body in new[]
        {
            """{"choices":[{"finish_reason":"length","message":{"content":"incomplete","tool_calls":null}}]}""",
            """{"choices":[{"finish_reason":"stop","message":{"content":"text","tool_calls":null,"tool_calls":[]}}]}"""
        })
        {
            using var wire = new Wire(body); using var http = new HttpClient(wire); bool failed = false;
            try { await new OpenAiHarnessModel(http, config, budget).Complete(request, campaign, default); }
            catch (DiceRealm.Server.Domain.GameException) { failed = true; }
            Check.True(failed); Check.Equal(1, wire.Calls); attempts++;
        }
        Check.Equal(attempts, budget.Read("text", campaign, true).Total);
    }
    public static async Task ExactTransportAndDurableAttempts()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["HarnessAi:RetryCount"] = "0",
            ["DataPath"] = Path.Combine(Path.GetTempPath(), "harness-provider-" + Id()),
            ["HarnessAi:Model"] = "fake-harness-model", ["HarnessAi:ApiKey"] = "fake-never-live", ["HarnessAi:Endpoint"] = "http://127.0.0.1:1/v1/chat/completions"
        }).Build();
        using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        const string valid = """{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"t1","type":"function","function":{"name":"context_read","arguments":"{}"}}]}}],"usage":{"prompt_tokens":17,"completion_tokens":8}}""";
        var wire = new Wire(valid); var provider = new OpenAiHarnessModel(new HttpClient(wire), config, budget);
        var request = new HarnessModelRequest(Preset.SystemPrompt, [new("user", "玩家原文"),
            new("assistant", "", [new("previous", "rules_scope", HarnessJson.Element(new { }))]),
            new("tool", "{\"ruleset\":\"dnd2024\"}", ToolCallId: "previous", Name: "rules_scope", IsError: false)], HarnessTools.All, 4096);
        var result = await provider.Complete(request, campaign, default);
        Check.Equal("context_read", result.ToolCalls.Single().Name); Check.Equal(17, result.InputTokens); Check.Equal(8, result.OutputTokens);
        Check.Equal("Bearer fake-never-live", wire.Authorization);
        using var sent = JsonDocument.Parse(wire.Body);
        Check.Equal(Preset.SystemPrompt, sent.RootElement.GetProperty("messages")[0].GetProperty("content").GetString());
        Check.Equal("previous", sent.RootElement.GetProperty("messages")[3].GetProperty("tool_call_id").GetString());
        Check.Equal(HarnessTools.All.Length, sent.RootElement.GetProperty("tools").GetArrayLength());
        Check.Equal(1, budget.Read("text", campaign, true).Total);
        var malformed = new Wire(valid.Replace("\"arguments\":\"{}\"", "\"arguments\":\"{\\\"id\\\":1,\\\"id\\\":2}\""));
        bool rejected = false;
        try { await new OpenAiHarnessModel(new HttpClient(malformed), config, budget).Complete(request, campaign, default); }
        catch (Exception ex) when (ex is DiceRealm.Server.Domain.GameException or JsonException) { rejected = true; }
        Check.True(rejected); Check.Equal(1, malformed.Calls); Check.Equal(2, budget.Read("text", campaign, true).Total);
        using var bounded = new Wire(valid); using var client = new HttpClient(bounded);
        async Task NotSent(HarnessModelRequest value, string code, ProviderBudget? selectedBudget = null)
        {
            try { await new OpenAiHarnessModel(client, config, selectedBudget ?? budget).Complete(value, campaign, default); }
            catch (HarnessModelNotSentException ex)
            {
                Check.Equal(code, ex.Code); Check.Equal(0, bounded.Calls); Check.Equal(2, budget.Read("text", campaign, true).Total);
                return;
            }
            throw new Exception("Expected trusted pre-send rejection: " + code);
        }
        await NotSent(request with { System = new string('中', 50000) }, "harness_context_limit");
        await NotSent(request with { Messages = [new("untrusted-role", "test")] }, "harness_model_contract");
        config["HarnessAi:Endpoint"] = "http://example.invalid/unsafe";
        await NotSent(request, "harness_model_endpoint");
        config["HarnessAi:Endpoint"] = "http://127.0.0.1:1/v1/chat/completions";
        config["ProviderLimits:TextTotal"] = "0";
        await NotSent(request, "harness_model_quota_exceeded", new ProviderBudget(data, config));
        config["HarnessAi:ApiKey"] = "";
        await NotSent(request, "harness_model_disabled");
    }
}
