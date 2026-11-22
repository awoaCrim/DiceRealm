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

internal static class HarnessGeminiTests
{
    private const string Secret = "PRIVATE-native-test-sentinel";
    private static readonly string Signature = Convert.ToBase64String(Encoding.UTF8.GetBytes(Secret));
    private sealed class Wire(Func<int, JsonElement, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int Calls, MetadataCalls, CountCalls;
        public string Address = "", Key = "", Authorization = "";
        public List<JsonElement> Bodies { get; } = [];
        public List<string> RawBodies { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            string address = request.RequestUri!.AbsoluteUri;
            if (request.Method == HttpMethod.Get)
            {
                MetadataCalls++;
                throw new Exception("Generation must not request model metadata");
            }
            if (address.EndsWith(":countTokens", StringComparison.Ordinal))
            {
                CountCalls++;
                throw new Exception("Generation must not issue countTokens");
            }
            int count = Interlocked.Increment(ref Calls);
            Address = address;
            Key = request.Headers.TryGetValues("x-goog-api-key", out var values) ? values.Single() : "";
            Authorization = request.Headers.Authorization?.ToString() ?? "";
            string raw = await request.Content!.ReadAsStringAsync(ct); RawBodies.Add(raw);
            using var body = JsonDocument.Parse(raw);
            Bodies.Add(body.RootElement.Clone());
            return respond(count, body.RootElement);
        }
    }
    private sealed class Capture : ILogger<GeminiHarnessModel>
    {
        public List<string> Entries { get; } = [];
        public int Exceptions;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (exception is not null) Exceptions++;
            Entries.Add(formatter(state, exception));
        }
    }
    private static IConfigurationRoot Config() => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["HarnessAi:RetryCount"] = "0",
            ["DataPath"] = Path.Combine(Path.GetTempPath(), "native-harness-" + Id()),
        ["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/proxy/v1beta/", ["HarnessAi:ApiKey"] = Secret,
        ["HarnessAi:Endpoint"] = "gemini", ["HarnessAi:Model"] = "fake-gemini-model",
        ["ProviderLimits:TextTotal"] = "100", ["ProviderLimits:TextDaily"] = "100", ["ProviderLimits:TextCampaignDaily"] = "100"
    }).Build();
    private static HarnessModelRequest Request() => new(Preset.SystemPrompt, [new("user", "明确测试原文")], HarnessTools.All, 4096);
    private static HttpResponseMessage Raw(string value, HttpStatusCode status = HttpStatusCode.OK) => new(status)
    { Content = new StringContent(value, Encoding.UTF8, "application/json") };
    private static HttpResponseMessage Response(object[] parts, string finish = "STOP", object? usage = null) => Raw(HarnessJson.Serialize(new
    {
        candidates = new[] { new { content = new { role = "model", parts }, finishReason = finish } },
        usageMetadata = usage ?? new { promptTokenCount = 17, candidatesTokenCount = 8, thoughtsTokenCount = 4, cachedContentTokenCount = 5 }
    }));
    private static object[] Parts(HarnessModelReply reply, string? nativeId = "native_call")
    {
        var parts = new List<object>
        {
            new { text = Secret, thought = true, thoughtSignature = Signature },
            new { text = reply.Text, thoughtSignature = Signature }
        };
        foreach (var call in reply.ToolCalls)
        {
            var function = new Dictionary<string, object> { ["name"] = call.Name, ["args"] = call.Arguments };
            if (nativeId is not null) function["id"] = nativeId;
            parts.Add(new { functionCall = function, thoughtSignature = Signature });
        }
        parts.Add(new { text = "", thoughtSignature = Signature });
        return parts.ToArray();
    }
    private static HarnessModelRequest Follow(HarnessModelRequest request, HarnessModelReply reply) => request with
    {
        Messages = [.. request.Messages, new("assistant", reply.Text, reply.ToolCalls), .. reply.ToolCalls.Select(t => new HarnessChatMessage("tool", "原样工具结果", ToolCallId: t.Id, Name: t.Name, IsError: false))],
        ProviderHistory = [.. request.ProviderHistory, new(reply, reply.ProviderContinuation)]
    };
    private static async Task Rejected(Func<Task<HarnessModelReply>> action, string code)
    {
        try { await action(); }
        catch (HarnessModelNotSentException ex) { Check.Equal(code, ex.Code); return; }
        throw new Exception("Expected native pre-send rejection: " + code);
    }

    public static async Task TransportPartsAndPrivateMetadata()
    {
        var config = Config(); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        var firstParts = Parts(Tool("context_read"));
        using var wire = new Wire((i, _) => i == 1 ? Response(firstParts) : Response(Parts(Text("最终回复"))));
        using var http = new HttpClient(wire); var model = new GeminiHarnessModel(http, config, budget);
        var request = Request(); string oldJson = HarnessJson.Serialize(request);
        var first = await model.Complete(request, campaign, default);
        Check.Equal("native_call", first.ToolCalls.Single().Id); Check.Equal("", first.Text);
        Check.Equal(17, first.InputTokens); Check.Equal(12, first.OutputTokens);
        Check.Equal("http://127.0.0.1:1/proxy/v1beta/models/fake-gemini-model:generateContent", wire.Address);
        Check.Equal(Secret, wire.Key); Check.Equal("", wire.Authorization);
        var sent = wire.Bodies[0];
        Check.Equal(Preset.SystemPrompt, sent.GetProperty("systemInstruction").GetProperty("parts")[0].GetProperty("text").GetString());
        Check.Equal(4096, sent.GetProperty("generationConfig").GetProperty("maxOutputTokens").GetInt32());
        Check.True(sent.GetProperty("generationConfig").GetProperty("thinkingConfig").GetProperty("includeThoughts").GetBoolean());
        Check.Equal("high", sent.GetProperty("generationConfig").GetProperty("thinkingConfig").GetProperty("thinkingLevel").GetString());
        var declarations = sent.GetProperty("tools")[0].GetProperty("functionDeclarations");
        Check.Equal(HarnessTools.All.Length, declarations.GetArrayLength());
        Check.Equal(HarnessJson.Fingerprint(HarnessTools.All[0].InputSchema), HarnessJson.Fingerprint(declarations[0].GetProperty("parametersJsonSchema")));
        var follow = Follow(request, first);
        var final = await model.Complete(follow with { MaxTokens = 0 }, campaign, default);
        Check.True(!wire.Bodies[1].GetProperty("generationConfig").TryGetProperty("maxOutputTokens", out _));
        var contents = wire.Bodies[1].GetProperty("contents");
        Check.Equal(HarnessJson.Fingerprint(HarnessJson.Element(firstParts)), HarnessJson.Fingerprint(contents[1].GetProperty("parts")));
        var functionResponse = contents[2].GetProperty("parts")[0].GetProperty("functionResponse");
        Check.Equal("native_call", functionResponse.GetProperty("id").GetString());
        Check.Equal("原样工具结果", functionResponse.GetProperty("response").GetProperty("output").GetString());
        Check.Equal("最终回复", final.Text); Check.Equal(0, final.ToolCalls.Length);
        Check.Equal(2, budget.Read("text", campaign, true).Total);
        Check.True(!HarnessJson.Serialize(first).Contains(Signature) && !HarnessJson.Serialize(first).Contains(Secret));
        Check.Equal(oldJson, HarnessJson.Serialize(request with { ProviderHistory = follow.ProviderHistory }));
        var roundtrip = HarnessJson.Read<HarnessModelReply>(HarnessJson.Element(first)); Check.True(roundtrip.ProviderContinuation is null);
        // JsonIgnore is an input boundary too: a supplied wire value cannot forge parent-owned metadata.
        using var forged = JsonDocument.Parse(oldJson[..^1] + ",\"providerHistory\":[{\"private\":true}]}");
        Check.Equal(0, HarnessJson.Read<HarnessModelRequest>(forged.RootElement).ProviderHistory.Length);
        Check.Equal(HarnessJson.Serialize(new { text = first.Text, toolCalls = first.ToolCalls, inputTokens = first.InputTokens, outputTokens = first.OutputTokens }), HarnessJson.Serialize(first));
    }

    public static async Task MissingNativeIdsAndMultiToolResponses()
    {
        var config = Config(); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
        var nativeParts = new object[]
        {
            new { text = "段一", thoughtSignature = Signature },
            new { functionCall = new { name = "context_read", args = new { } }, thoughtSignature = Signature },
            new { text = "段二" },
            new { functionCall = new { name = "rules_scope", args = new { }, id = "second_id" } },
            new { text = "", thoughtSignature = Signature }
        };
        using var wire = new Wire((i, _) => i == 1 ? Response(nativeParts) : Response([new { text = "完成" }])); using var http = new HttpClient(wire);
        var model = new GeminiHarnessModel(http, config, budget); string campaign = Id(); var request = Request();
        var first = await model.Complete(request, campaign, default); Check.Equal("段一段二", first.Text);
        Check.True(first.ToolCalls[0].Id.StartsWith("gemini_")); Check.Equal("second_id", first.ToolCalls[1].Id);
        var follow = Follow(request, first); follow.Messages[^1] = follow.Messages[^1] with { IsError = true };
        // Persist metadata independently, exactly as the coordinator/store does.
        var stored = HarnessJson.Read<HarnessProviderContinuation>(HarnessJson.Element(first.ProviderContinuation));
        follow = follow with { ProviderHistory = [new(HarnessJson.Read<HarnessModelReply>(HarnessJson.Element(first)), stored)] };
        await model.Complete(follow, campaign, default);
        var contents = wire.Bodies[1].GetProperty("contents"); Check.Equal(3, contents.GetArrayLength());
        var results = contents[2].GetProperty("parts"); Check.Equal(2, results.GetArrayLength());
        Check.True(!results[0].GetProperty("functionResponse").TryGetProperty("id", out _));
        Check.Equal("second_id", results[1].GetProperty("functionResponse").GetProperty("id").GetString());
        Check.Equal("原样工具结果", results[1].GetProperty("functionResponse").GetProperty("response").GetProperty("error").GetString());
        Check.Equal(HarnessJson.Fingerprint(HarnessJson.Element(nativeParts)), HarnessJson.Fingerprint(contents[1].GetProperty("parts")));
        Check.Equal(2, wire.Calls);
    }

    public static async Task CurrentOfferedToolsAndNativeBoardHistory()
    {
        var config = Config(); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
        string campaign = Id(); var parts = Parts(Tool("token_spawn", new { mapId = Id(), spawns = Array.Empty<object>() }));
        using var wire = new Wire((_, _) => Response(parts)); using var http = new HttpClient(wire);
        var model = new GeminiHarnessModel(http, config, budget);
        var request = Request() with { Tools = HarnessTools.ForVersion(27) };
        var reply = await model.Complete(request, campaign, default);
        Check.Equal("token_spawn", reply.ToolCalls.Single().Name);
        // A previous valid call stays replayable when this frame offers only read tools.
        var follow = Follow(request, reply) with { Tools = request.Tools.Where(t => t.Name == "token_read").ToArray() };
        using var finalWire = new Wire((_, _) => Response(Parts(Text("完成")))); using var finalHttp = new HttpClient(finalWire);
        await new GeminiHarnessModel(finalHttp, config, budget).Complete(follow, campaign, default);
        var history = finalWire.Bodies.Single().GetProperty("contents")[1].GetProperty("parts");
        Check.Equal(HarnessJson.Fingerprint(HarnessJson.Element(parts)), HarnessJson.Fingerprint(history));
        bool rejected = false;
        try { await model.Complete(follow, campaign, default); }
        catch (GameException error) { Check.Equal("harness_model_output", error.Code); rejected = true; }
        Check.True(rejected, "A real but unoffered tool must still be rejected");
        var changed = follow.Messages.ToArray();
        changed[1] = changed[1] with { ToolCalls = [reply.ToolCalls.Single() with { Name = "token_move" }] };
        await Rejected(() => model.Complete(follow with { Messages = changed }, campaign, default), "harness_model_contract");
        Check.Equal(2, wire.Calls);
    }

    public static async Task BoardToolsThroughRealPi()
    {
        string mapId = "", firstId = "";
        using var wire = new Wire((i, body) =>
        {
            HarnessModelReply reply;
            if (i == 1) reply = Tool("token_spawn", new { mapId, spawns = new[]
            {
                new { existingId = "", kind = "object", source = new { kind = "custom" }, appearance = new { name = "公开示意甲" }, x = .2, y = .3 },
                new { existingId = "", kind = "object", source = new { kind = "custom" }, appearance = new { name = "公开示意乙" }, x = .6, y = .3 }
            } });
            else
            {
                var last = body.GetProperty("contents").EnumerateArray().Last();
                using var frame = JsonDocument.Parse(last.GetProperty("parts")[0].GetProperty("text").GetString()!);
                var tokens = frame.RootElement.GetProperty("board").GetProperty("state").GetProperty("tokens");
                Check.Equal(2, tokens.GetArrayLength());
                if (i == 2)
                {
                    firstId = tokens[0].GetProperty("id").GetString()!;
                    Check.True(firstId != tokens[1].GetProperty("id").GetString());
                    reply = Tool("token_move", new { mapId, entityId = firstId, destination = new { x = .4, y = .5 } });
                }
                else if (i == 3) reply = Tool("token_read", new { entityId = firstId });
                else reply = Tool("world_record", new NarrativeHarnessArgs("两件公开物体的位置已保存。", []));
            }
            return Response(Parts(reply, "board_native_" + i));
        });
        await using var h = await Host.Start(configure: Provider(wire));
        var owner = await Create(h); string id = owner.Snapshot.Id; mapId = SharedBoardTests.Install(h, id).Id;
        var run = await Start(h, (await h.Get(id))!, "放置并移动两件公开示意物，查看第一件。");
        run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(4, wire.Calls);
        var board = (await h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board"))!;
        Check.Equal(2, board.Tokens.Length); Check.Equal(.4, board.Tokens.Single(t => t.Id == firstId).X);
        Check.Equal(0, board.RecentOperations.Length);
    }

    public static async Task PreflightAndExplicitConfiguration()
    {
        var config = Config(); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        using var wire = new Wire((_, _) => Response(Parts(Tool("context_read")))); using var http = new HttpClient(wire);
        var model = new GeminiHarnessModel(http, config, budget); var first = await model.Complete(Request(), campaign, default); var follow = Follow(Request(), first);
        async Task Fail(HarnessModelRequest request, string code = "harness_model_contract")
        {
            await Rejected(() => new GeminiHarnessModel(http, config, budget).Complete(request, campaign, default), code);
            Check.Equal(1, wire.Calls); Check.Equal(1, budget.Read("text", campaign, true).Total);
        }
        await Fail(follow with { ProviderHistory = [] });
        await Fail(follow with { ProviderHistory = [new(first, null)] });
        var changed = follow.Messages.ToArray(); changed[1] = changed[1] with { Content = "伪造关联" };
        await Fail(follow with { Messages = changed });
        changed = follow.Messages.ToArray(); changed[^1] = changed[^1] with { ToolCallId = "foreign_call" }; await Fail(follow with { Messages = changed });
        await Fail(Request() with { System = new string('中', 50000) }, "harness_context_limit");
        await Fail(Request() with { MaxTokens = 4097 });
        config["HarnessAi:Model"] = "changed-model"; await Fail(follow); config["HarnessAi:Model"] = "fake-gemini-model";
        foreach (string address in new[] { "http://not-loopback.invalid/v1beta", "https://user:pass@example.invalid/v1beta", "https://example.invalid/v1beta?key=secret", "https://example.invalid/v1beta#fragment", "relative", "" })
        {
            config["HarnessAi:BaseUrl"] = address; await Fail(Request(), "harness_model_endpoint");
        }
        config["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/proxy/v1beta/";
        foreach (string endpoint in new[] { "openai-chat", "http://127.0.0.1:1/v1/chat/completions", "unsupported" })
        { config["HarnessAi:Endpoint"] = endpoint; await Fail(Request(), "harness_model_endpoint"); }
        config["HarnessAi:Endpoint"] = "gemini";
        foreach (string invalidKey in new[] { "bad\r\nkey", "bad key", "非ASCII", new string('k', 8193) })
        { config["HarnessAi:ApiKey"] = invalidKey; await Fail(Request(), "harness_model_credentials"); }
        config["HarnessAi:ApiKey"] = Secret;
        config["ProviderLimits:TextTotal"] = "1";
        await Rejected(() => new GeminiHarnessModel(http, config, new ProviderBudget(data, config)).Complete(Request(), campaign, default), "harness_model_quota_exceeded");
        config["HarnessAi:ApiKey"] = ""; await Fail(Request(), "harness_model_disabled"); config["HarnessAi:ApiKey"] = Secret;
        // Selecting an OpenAI endpoint is explicit even when the model name mentions Gemini.
        config["HarnessAi:Endpoint"] = "openai-chat"; config["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/custom/v1";
        await Rejected(() => new OpenAiHarnessModel(http, config, budget).Complete(follow, campaign, default), "harness_model_contract");
        using var openWire = new Wire((_, _) => Raw("""{"choices":[{"finish_reason":"stop","message":{"content":"ok","tool_calls":null}}]}"""));
        using var openHttp = new HttpClient(openWire); await new OpenAiHarnessModel(openHttp, config, budget).Complete(Request(), campaign, default);
        Check.Equal("http://127.0.0.1:1/custom/v1/chat/completions", openWire.Address); Check.Equal("Bearer " + Secret, openWire.Authorization); Check.Equal("", openWire.Key);
    }

    public static async Task StrictOutputsAndSafeDiagnostics()
    {
        var config = Config(); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        string valid = HarnessJson.Serialize(new { candidates = new[] { new { content = new { role = "model", parts = new[] { new { text = Secret } } }, finishReason = "STOP" } } });
        var responses = new[]
        {
            valid.Replace("STOP", "MAX_TOKENS"), valid.Replace("STOP", "SAFETY"), valid.Replace("STOP", Secret),
            "{broken " + Secret,
            valid.Replace("\"text\":", "\"text\":\"duplicate\",\"text\":"),
            valid.Replace("\"parts\":[", "\"parts\":[{\"inlineData\":{}},"),
            valid.Replace("\"parts\":[", "\"parts\":[{\"text\":\"\",\"thoughtSignature\":\"invalid\"},"),
            valid.Replace("\"text\":", "\"thought\":true,\"text\":"),
            valid[..^1] + ",\"usageMetadata\":{\"thoughtsTokenCount\":-1}}",
            valid[..^1] + ",\"usageMetadata\":{\"promptTokenCount\":\"" + Secret + "\"}}",
            "{\"candidates\":[],\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}",
            new string('x', 256 * 1024 + 1)
        };
        foreach (string response in responses)
        {
            using var wire = new Wire((_, _) => Raw(response)); using var http = new HttpClient(wire); var capture = new Capture();
            bool failed = false;
            try { await new GeminiHarnessModel(http, config, budget, capture).Complete(Request(), campaign, default); }
            catch (Exception ex) when (ex is not HarnessModelNotSentException) { failed = true; }
            Check.True(failed); Check.Equal(1, wire.Calls); Check.Equal(0, capture.Exceptions);
            Check.True(capture.Entries.Count == 1 && !capture.Entries[0].Contains(Secret) && !capture.Entries[0].Contains(Signature));
        }
        Check.Equal(responses.Length, budget.Read("text", campaign, true).Total);
        using var missing = new Wire((_, _) => Raw(valid)); using var missingHttp = new HttpClient(missing);
        var estimated = await new GeminiHarnessModel(missingHttp, config, budget).Complete(Request(), campaign, default);
        Check.Equal(Encoding.UTF8.GetByteCount(missing.RawBodies.Single()), estimated.InputTokens);
        Check.Equal(Encoding.UTF8.GetByteCount(valid), estimated.OutputTokens);
    }

    private static Action<WebApplicationBuilder> Provider(Wire wire, bool realPi = true, string model = "fake-gemini-model", int limit = 20) => b =>
    {
        b.Configuration["Harness:Enabled"] = "true";
        b.Configuration["HarnessAi:RetryCount"] = "0"; // explicit old no-retry compatibility; default retry tested separately
        b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
        b.Configuration["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/proxy/v1beta/";
        b.Configuration["HarnessAi:ApiKey"] = Secret; b.Configuration["HarnessAi:Endpoint"] = "gemini"; b.Configuration["HarnessAi:Model"] = model;
        b.Configuration["ProviderLimits:TextTotal"] = limit.ToString(System.Globalization.CultureInfo.InvariantCulture);
        // Override only transport, leaving the production DI endpoint selection in place.
        b.Services.AddHttpClient<GeminiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => wire);
        if (!realPi) b.Services.AddSingleton<IHarnessRuntime, Loop>();
    };
    private static HarnessRun Stored(Host h, CreatedCampaign owner, string id) => h.App.Services.GetRequiredService<HarnessRunStore>()
        .Read(owner.Snapshot.Id, owner.Snapshot.Party!.SelfActorId, id)!;
    private static int Usage(Host h, CreatedCampaign owner) => h.App.Services.GetRequiredService<ProviderBudget>().Read("text", owner.Snapshot.Id, true).Total;

    public static async Task RealPiConsentRestartAndReplay()
    {
        var originals = new List<JsonElement>();
        using var wire = new Wire((i, body) =>
        {
            var history = body.GetProperty("contents").EnumerateArray().Where(c => c.GetProperty("role").GetString() == "model").ToArray();
            Check.Equal(i - 1, history.Length);
            for (int j = 0; j < history.Length; j++) Check.Equal(HarnessJson.Fingerprint(originals[j]), HarnessJson.Fingerprint(history[j].GetProperty("parts")));
            string candidate = "";
            if (i == 2)
            {
                var result = body.GetProperty("contents").EnumerateArray().SelectMany(c => c.GetProperty("parts").EnumerateArray())
                    .Last(p => p.TryGetProperty("functionResponse", out _)).GetProperty("functionResponse").GetProperty("response").GetProperty("output").GetString()!;
                candidate = Candidate(Request() with { Messages = [new("tool", result)] }, TestContent.Document.Scenes.Single(s => s.Id == "harbor").Actions.Single(a => a.Kind == "investigate").Label);
            }
            HarnessModelReply reply = i switch
            {
                1 => Tool("context_read"), 2 => Tool("actions_propose", new { candidateId = candidate }), 3 => Tool("checks_result"),
                4 => Tool("world_record", new NarrativeHarnessArgs("原生协议测试记录。", [new("", "clue", "Gemini 回归线索", "非机械测试", "known", "harbor")])),
                5 => Text("Gemini 原生集成已验证。"), _ => throw new Exception("Unexpected native call")
            };
            var parts = Parts(reply, i == 2 ? null : "native_" + i); originals.Add(HarnessJson.Element(parts)); return Response(parts);
        });
        var dice = new SequenceDice(18); string root; CreatedCampaign owner; HarnessRunView run; HarnessInputRequest input; RollResponseRequest roll;
        await using (var h = await Host.Start(dice: dice, configure: Provider(wire)))
        {
            Check.True(h.App.Services.GetRequiredService<IHarnessModel>() is ConfiguredHarnessModel);
            Check.Equal("gemini", h.App.Services.GetRequiredService<AiConfigurationStore>().Read().Main.Provider);
            root = h.Root; owner = await Create(h); input = new(Id(), owner.Snapshot.Version, "调查现场");
            run = await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", input); run = await Settled(h, owner.Snapshot.Id, run.Id, 3000);
            Check.True(run.Status == "waiting", $"Native consent expected waiting, got {run.Status}/{run.Error}; attempts={run.ModelAttempts}"); Check.Equal("roll", run.Wait!.Kind); Check.Equal(0, dice.Count); Check.Equal(2, wire.Calls);
            var saved = Stored(h, owner, run.Id); Check.Equal(2, saved.Steps.Count(s => s.ProviderContinuation is not null));
            Check.True(saved.Steps.Where(s => s.Kind == "model").All(s => !s.Result!.Value.GetRawText().Contains(Signature)));
            Check.True(HarnessJson.Serialize(saved).Contains(Signature));
            roll = new(Id(), run.Version, run.Wait.Id, "roll"); var result = await Post<ActionResponse>(h, owner.Snapshot.Id, "rolls/respond", roll);
            Check.Equal(1, dice.Count); Check.Equal(2, wire.Calls); run = run with { Version = result.Snapshot.Version };
        }
        await using (var h = await Host.Start(root, dice, configure: Provider(wire)))
        {
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); string id = owner.Snapshot.Id;
            Check.Equal(1, (await h.Http.GetFromJsonAsync<HarnessActiveRuns>($"/api/v1/campaigns/{id}/harness/runs/active"))!.Runs.Length);
            Check.Equal(2, wire.Calls); Check.Equal(2, Usage(h, owner));
            var resume = new HarnessResumeRequest(Id(), run.Version);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume); run = await Settled(h, id, run.Id, 3000);
            Check.Equal("completed", run.Status); Check.Equal("原生协议测试记录。", run.Text); Check.Equal(4, wire.Calls); Check.Equal(4, Usage(h, owner)); Check.Equal(1, dice.Count);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed);
            Check.Equal(4, wire.Calls); Check.Equal(1, dice.Count);
            Check.Equal(1, (await h.Get(id))!.WorldMemory!.Count(m => m.Name == "Gemini 回归线索"));
            Check.Equal(116, Stored(h, owner, run.Id).Tokens);
            foreach (string route in new[] { "", "/activity", $"/harness/runs/{run.Id}", "/harness/runs/active" })
            {
                string json = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}" + route);
                Check.True(!json.Contains(Secret) && !json.Contains(Signature) && !json.Contains("providerContinuation"));
            }
        }
    }

    public static async Task InvalidCredentialsNeverBecomeUnknown()
    {
        foreach (bool gemini in new[] { true, false })
        {
            using var wire = new Wire((_, _) => throw new Exception("Must not send invalid credentials"));
            await using var h = await Host.Start(configure: b =>
            {
                Provider(wire, false)(b);
                b.Configuration["HarnessAi:ApiKey"] = "bad\r\ninjected-key";
                if (!gemini)
                {
                    b.Configuration["HarnessAi:Endpoint"] = "openai-chat";
                    b.Services.AddHttpClient<OpenAiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => wire);
                }
            });
            var owner = await Create(h); var run = await Start(h, owner.Snapshot); run = await Settled(h, owner.Snapshot.Id, run.Id);
            Check.Equal("failed", run.Status); Check.Equal("harness_model_credentials", run.Error);
            Check.Equal(1, run.ModelAttempts); Check.Equal(0, wire.Calls); Check.Equal(0, Usage(h, owner));
            Check.True(Stored(h, owner, run.Id).Steps.Single().Result is null);
        }
    }

    public static async Task ChangedProviderAndUnknownAreNotRetried()
    {
        using var wire = new Wire((i, _) => i == 1 ? Response(Parts(Tool("ask_player", new { question = "继续？" }))) : Raw("harness_model_quota_exceeded " + Secret, HttpStatusCode.TooManyRequests));
        string root; CreatedCampaign owner; HarnessRunView run;
        await using (var h = await Host.Start(configure: Provider(wire, false)))
        {
            root = h.Root; owner = await Create(h); run = await Start(h, owner.Snapshot); run = await Settled(h, owner.Snapshot.Id, run.Id);
            Check.Equal("waiting", run.Status); Check.Equal(1, Usage(h, owner));
        }
        await using (var h = await Host.Start(root, configure: Provider(wire, false, "changed-model")))
        {
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); string id = owner.Snapshot.Id;
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "继续"));
            run = await Settled(h, id, run.Id); Check.Equal("failed", run.Status); Check.Equal("harness_model_contract", run.Error);
            Check.Equal(1, wire.Calls); Check.Equal(1, Usage(h, owner));
            var next = await Start(h, (await h.Get(id))!); next = await Settled(h, id, next.Id);
            Check.Equal("unknown", next.Status); Check.Equal("harness_model_unknown", next.Error); Check.Equal(2, wire.Calls); Check.Equal(2, Usage(h, owner));
            Check.True(Stored(h, owner, next.Id).Steps.Single().ProviderContinuation is null);
        }
        await using (var h = await Host.Start(root, configure: Provider(wire, false)))
        {
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await h.Http.GetStringAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/harness/runs/active");
            Check.Equal(2, wire.Calls); Check.Equal(2, Usage(h, owner));
        }
    }
    public static async Task CombatChildNativeHistoryAndUnknownIdentity()
    {
        foreach (int contract in new[] { 44, 45 })
        foreach (bool unknown in new[] { false, true })
        {
            var document = StandardCombatTests.Document();
            string label = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
            var originals = new Dictionary<int, JsonElement>();
            using var wire = new Wire((i, body) =>
            {
                var contents = body.GetProperty("contents");
                using var frameJson = JsonDocument.Parse(contents[contents.GetArrayLength() - 1].GetProperty("parts")[0].GetProperty("text").GetString()!);
                var frame = frameJson.RootElement;
                int[] expected = i switch { 3 => [2], 4 when contract < 45 => [2, 3], 5 => [1], _ => [] }; 
                if (i == 4 && contract >= 45)
                    Check.True(body.GetRawText().Contains("原生战斗记录3"), "Closed input is supplied as sourced history, without its native Parts.");
                var history = contents.EnumerateArray().Where(c => c.GetProperty("role").GetString() == "model").ToArray();
                Check.Equal(expected.Length, history.Length);
                for (int j = 0; j < expected.Length; j++)
                    Check.Equal(HarnessJson.Serialize(originals[expected[j]]), HarnessJson.Serialize(history[j].GetProperty("parts")));
                Check.Equal(i is 1 or 5 ? Preset.SystemPrompt : "独立原生战斗提示", body.GetProperty("systemInstruction").GetProperty("parts")[0].GetProperty("text").GetString());
                if (unknown && i == 2) throw new IOException("lost first battle provider response");
                HarnessModelReply reply;
                if (i == 1) reply = Tool("combat_delegate", new CombatDelegateArgs(frame.GetProperty("agent").GetProperty("encounterId").GetString()!, "真实交锋。", []));
                else if (i == 2)
                {
                    string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                        .Single(c => c.GetProperty("label").GetString() == label).GetProperty("id").GetString()!;
                    reply = Tool("actions_propose", new { candidateId = candidate });
                }
                else reply = Tool("world_record", new NarrativeHarnessArgs("原生战斗记录" + i, [], Private: "OWN_BATTLE_PRIVATE_" + i));
                var parts = Parts(reply, "battle-native-" + i);
                originals.Add(i, HarnessJson.Element(parts)); return Response(parts);
            });
            var dice = new SequenceDice(20, 1);
            var h = await Host.Start(dice: dice, configure: Provider(wire));
            try
            {
                var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("原生战斗恢复", "Arden", document,
                    Preset with { CombatSystemPrompt = "独立原生战斗提示" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
                Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
                var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
                string id = owner.Snapshot.Id;
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                var parent = await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "我守住位置。"), contract);
                Check.Equal("delegated", (await Settled(h, id, parent.Id, 3000)).Status);
                var session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
                var child = await Settled(h, id, session.Inputs[0].RunId, 3000);
                Check.Equal(unknown ? "unknown" : "waiting", child.Status);
                var stored = Stored(h, owner, child.Id);
                Check.True(stored.Steps.First(s => s.Kind == "model").ProviderIdentity is { Length: 64 });
                if (unknown) Check.True(stored.Steps.All(s => s.ProviderContinuation is null));
                if (!unknown)
                {
                    var snapshot = (await h.Get(id))!;
                    snapshot = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll"))).Snapshot;
                    await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), snapshot.Version));
                    Check.Equal("completed", (await Settled(h, id, child.Id, 3000)).Status);
                }
                int beforeRestart = wire.Calls;
                string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice, configure: Provider(wire, model: unknown ? "changed-model" : "fake-gemini-model"));
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                var latest = (await h.Get(id))!;
                Check.Equal(beforeRestart, wire.Calls);
                var next = await Start(h, latest, "我向对方喊话。"); next = await Settled(h, id, next.Id, 3000);
                if (unknown)
                {
                    Check.True(next.Status == "failed" && next.Error == "harness_model_contract", next.Status + ":" + next.Error);
                    Check.Equal(beforeRestart, wire.Calls); Check.Equal(0, dice.Count); Check.Equal(2, Usage(h, owner));
                    Check.True(Stored(h, owner, next.Id).CombatHistory!.ProviderIdentities.Length == 1);
                }
                else
                {
                    Check.True(next.Status == "completed", next.Status + ":" + next.Error);
                    latest = (await h.Get(id))!;
                    latest = (await h.Act(latest, "combat.disengage")).Snapshot;
                    latest = (await h.Act(latest, "combat.move", "0," + latest.Combat!.Units.Single(u => u.Id == "player").Y)).Snapshot;
                    await h.Act(latest, "combat.retreat");
                    Check.Equal("completed", (await Settled(h, id, parent.Id, 3000)).Status);
                    Check.Equal(5, wire.Calls); Check.Equal(2, dice.Count);
                }
            }
            finally { await h.DisposeAsync(); }
        }
    }

    public static async Task ProtectedChainThroughRealPiAndRestart()
    {
        string skill = new string('文', 12000) + "末尾：尚未答应，只考虑带人回来。";
        var originals = new List<JsonElement>();
        using var wire = new Wire((i, body) =>
        {
            var native = body.GetProperty("contents").EnumerateArray().Where(c => c.GetProperty("role").GetString() == "model").ToArray();
            Check.Equal(originals.Count, native.Length);
            for (int n = 0; n < native.Length; n++)
                Check.Equal(HarnessJson.Serialize(originals[n]), HarnessJson.Serialize(native[n].GetProperty("parts")));
            var results = body.GetProperty("contents").EnumerateArray().SelectMany(c => c.GetProperty("parts").EnumerateArray())
                .Where(p => p.TryGetProperty("functionResponse", out _)).Select(p => p.GetProperty("functionResponse")).ToArray();
            foreach (var result in results.Where(r => r.GetProperty("name").GetString() == "skills_read"))
            {
                using var output = JsonDocument.Parse(result.GetProperty("response").GetProperty("output").GetString()!);
                Check.Equal(skill, output.RootElement.GetProperty("content").GetString());
            }
            if (i >= 7) Check.Equal(1, results.Count(r => r.GetProperty("name").GetString() == "encounter_read"));
            HarnessModelReply reply = i switch
            {
                1 => Tool("world_record", new NarrativeHarnessArgs("已经听到公开说明。", [], Complete: false)),
                >= 2 and <= 5 => Tool("skills_read", new { id = "long" }),
                6 => Tool("encounter_read"),
                7 => Tool("ask_player", new { question = "仍未答应，是否继续询问？" }),
                8 => Tool("world_record", new NarrativeHarnessArgs("继续询问，尚未接受委托。", [])),
                _ => throw new Exception("Unexpected generation count")
            };
            var parts = Parts(reply, "preserved_" + i);
            originals.Add(HarnessJson.Element(parts));
            return Response(parts);
        });
        var dice = new SequenceDice(); var h = await Host.Start(dice: dice, configure: Provider(wire));
        try
        {
            var owner = await Create(h, skills: [new("long", "完整长资料", skill)]);
            string id = owner.Snapshot.Id;
            var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "走近后查看，再询问条件；我还没有答应。");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input);
            run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            Check.Equal(7, wire.Calls); Check.Equal(0, dice.Count);
            Check.True(Encoding.UTF8.GetByteCount(wire.RawBodies[6]) > 128 * 1024);
            var saved = Stored(h, owner, run.Id);
            Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion);
            foreach (var step in saved.Steps.Where(s => s.Kind == "model"))
            {
                Check.Equal(HarnessContextCompactor.HistoryPolicy, step.ContextPlan!.Policy);
                Check.Equal(0, step.ContextPlan.OmittedExchanges);
                Check.Equal(17, step.ContextPlan.ReportedInputTokens!.Value);
                Check.True(step.ContextPlan.InputBudget is null);
                HarnessContextCompactor.Validate(step.ContextPlan, protectedHistory: true);
            }
            var encounter = saved.Steps.Single(s => s.ToolName == "encounter_read");
            string outputText = HarnessJson.Read<HarnessToolReply>(encounter.Result!.Value).Content;
            var response = wire.Bodies[6].GetProperty("contents").EnumerateArray().SelectMany(c => c.GetProperty("parts").EnumerateArray())
                .Single(p => p.TryGetProperty("functionResponse", out var r) && r.GetProperty("name").GetString() == "encounter_read").GetProperty("functionResponse");
            Check.Equal(encounter.ToolRequest!.ToolCallId, response.GetProperty("id").GetString());
            using (var expected = JsonDocument.Parse(outputText))
            using (var actual = JsonDocument.Parse(response.GetProperty("response").GetProperty("output").GetString()!))
                Check.Equal(HarnessJson.Serialize(expected.RootElement), HarnessJson.Serialize(actual.RootElement));
            string oldSteps = HarnessJson.Serialize(saved.Steps); int count = saved.Steps.Count;
            string root = h.Root; await h.DisposeAsync();
            h = await Host.Start(root, dice, configure: Provider(wire));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.Equal(7, wire.Calls);
            var resume = new HarnessResumeRequest(Id(), run.Version, "继续问，但仍未接受。");
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            run = await Settled(h, id, run.Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            saved = Stored(h, owner, run.Id);
            Check.Equal(oldSteps, HarnessJson.Serialize(saved.Steps.Take(count).ToList()));
            Check.Equal(2, saved.Steps.Count(s => s.ToolName == "world_record"));
            Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            Check.Equal(8, wire.Calls); Check.Equal(8, Usage(h, owner)); Check.Equal(0, dice.Count);
            Check.Equal(0, wire.MetadataCalls); Check.Equal(0, wire.CountCalls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task ProtectedFailureNoticeKeepsSettledEffects()
    {
        foreach (var rejection in new[] { HarnessModelRejection.TransportLimit, HarnessModelRejection.BudgetUnknown,
            HarnessModelRejection.ContextPreparation, HarnessModelRejection.ContextLimit })
        {
            var model = new Model((n, _) => n == 1
                ? Tool("world_record", new NarrativeHarnessArgs("已经保存的公开对话。", [], Complete: false))
                : throw new HarnessModelNotSentException(rejection));
            await using var h = await Host.Start(configure: Configure(model));
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "继续了解情况");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input); run = await Settled(h, id, run.Id);
            Check.Equal("failed", run.Status); Check.Equal(2, model.Calls);
            Check.Equal(owner.Snapshot.Version + 1, run.Version);
            var view = await h.Http.GetFromJsonAsync<AdventureSessionView>($"/api/v1/campaigns/{id}/adventure/sessions/{run.Id}");
            Check.Equal("failed", view!.Phase); Check.True(view.Notice.Contains("已保存") && view.Notice.Contains("后续回应"));
            Check.True(!view.Notice.Contains("继续描述行动"));
            var progress = await h.App.Services.GetRequiredService<HarnessRunService>().HostProgress(id, owner.AccessToken, default);
            Check.Equal(view.Notice, progress.Runs.Single(r => r.Id == run.Id).Notice);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.Equal(2, model.Calls); Check.Equal(run.Version, (await h.Get(id))!.Version);
        }
    }

    public static async Task ProtectedTransportAndFrozenRetry()
    {
        var config = Config(); config["HarnessAi:RetryCount"] = "1";
        using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        using var wire = new Wire((i, _) => i == 1 ? Raw("{}", HttpStatusCode.ServiceUnavailable) : Response(Parts(Text("已完成"))));
        using var http = new HttpClient(wire); var model = new GeminiHarnessModel(http, config, budget);
        var original = Request() with { Messages = [new("user", new string('原', 60000) + "完整结尾")], MaxTokens = 0 };
        var prepared = HarnessContextCompactor.PreserveCurrent(original);
        Check.Equal(original.Messages[0].Content, prepared.Request.Messages[0].Content);
        int retries = 0;
        await model.Complete(prepared.Request with { BeforeProviderRetry = _ =>
        {
            retries++; config["HarnessAi:Model"] = "changed-after-started";
            return Task.CompletedTask;
        } }, campaign, default);
        Check.Equal(1, retries); Check.Equal(2, wire.Calls);
        Check.Equal(0, wire.MetadataCalls); Check.Equal(0, wire.CountCalls);
        Check.Equal(wire.RawBodies[0], wire.RawBodies[1]);
        Check.True(Encoding.UTF8.GetByteCount(wire.RawBodies[0]) > 128 * 1024);
        Check.Equal(2, budget.Read("text", campaign, true).Total);
        await Rejected(() => model.Complete(prepared.Request with
        {
            Messages = [new("user", new string('x', 8 * 1024 * 1024))]
        }, campaign, default), "harness_transport_limit");
        Check.Equal(2, wire.Calls); Check.Equal(2, budget.Read("text", campaign, true).Total);
        await Rejected(() => model.Complete(original, campaign, default), "harness_context_limit");
        Check.Equal(2, wire.Calls); // old direct-call contract retains its historical limit
    }

    public static async Task ProtectedResponseUsageWithoutPreflight()
    {
        var config = Config();
        using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config); string campaign = Id();
        using var wire = new Wire((i, _) => i == 1 ? Response(Parts(Text("已收到完整原文"))) :
            Raw(HarnessJson.Serialize(new { candidates = new[] { new { content = new { role = "model", parts = new[] { new { text = "无usage仍正常回应" } } }, finishReason = "STOP" } } })));
        var log = new ModelRequestLog(data);
        using var logged = new ModelRequestLogHandler(log, nameof(GeminiHarnessModel)) { InnerHandler = wire };
        using var http = new HttpClient(logged); var model = new GeminiHarnessModel(http, config, budget);
        int authorizations = 0;
        string image = Convert.ToBase64String([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9]);
        var request = HarnessContextCompactor.PreserveCurrent(Request() with
        {
            MaxTokens = 0, Messages = [new("user", "图中原话：他说可能考虑，并没有答应。") { Images = [new("image/jpeg", image)] }]
        }).Request with
        {
            BeforeProviderRequest = (_, _) => { authorizations++; config["HarnessAi:Model"] = "changed-after-capture"; return Task.CompletedTask; }
        };
        ModelRequestScope.Current = new(campaign, "usage-slot", "隔离正常生成检查");
        HarnessModelReply reply;
        try { reply = await model.Complete(request, campaign, default); }
        finally { ModelRequestScope.Current = null; }
        Check.Equal(1, authorizations); Check.Equal(1, wire.Calls);
        Check.Equal(17, reply.ReportedInputTokens!.Value); Check.Equal(17, reply.InputTokens); Check.Equal(12, reply.OutputTokens);
        Check.Equal("http://127.0.0.1:1/proxy/v1beta/models/fake-gemini-model:generateContent", wire.Address);
        var sent = wire.Bodies[0];
        Check.Equal(image, sent.GetProperty("contents")[0].GetProperty("parts")[1].GetProperty("inlineData").GetProperty("data").GetString());
        Check.Equal(request.System, sent.GetProperty("systemInstruction").GetProperty("parts")[0].GetProperty("text").GetString());
        Check.Equal(request.Tools.Length, sent.GetProperty("tools")[0].GetProperty("functionDeclarations").GetArrayLength());
        var logs = log.List(campaign, null, 10, false).Requests;
        Check.Equal(1, logs.Length); Check.Equal(1, logs[0].Attempt);
        var missing = await model.Complete(request, campaign, default);
        Check.True(missing.ReportedInputTokens is null); Check.Equal(0, missing.InputTokens); Check.Equal(0, missing.OutputTokens);
        Check.Equal(2, wire.Calls); Check.Equal(0, wire.MetadataCalls); Check.Equal(0, wire.CountCalls);
        Check.Equal(2, budget.Read("text", campaign, true).Total);
        try
        {
            await model.Complete(request with { BeforeProviderRequest = (_, _) => throw HarnessJson.Conflict("forbidden") }, campaign, default);
            throw new Exception("Expected authorization failure");
        }
        catch (GameException ex) { Check.Equal("forbidden", ex.Code); }
        Check.Equal(2, wire.Calls); Check.Equal(2, budget.Read("text", campaign, true).Total);
    }

    public static async Task CompactionNativeHistory()
    {
        var config = Config(); using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
        using var wire = new Wire((i, _) => Response(Parts(Tool("skills_read", new { id = "long-skill" }), "native_" + i)));
        using var http = new HttpClient(wire); var model = new GeminiHarnessModel(http, config, budget); string campaign = Id();
        var original = Request(); HarnessPreparedContext? reduced = null;
        for (int i = 0; i < 8; i++)
        {
            var prepared = HarnessContextCompactor.Prepare(original);
            if (prepared.Plan is not null) reduced = prepared;
            var reply = await model.Complete(prepared.Request, campaign, default);
            original = Follow(original, reply);
            original.Messages[^1] = original.Messages[^1] with { Content = new string('原', 12000) + "END-" + i };
            original = original with { PriorProviderIdentities = [reply.ProviderContinuation!.Identity] };
        }
        Check.True(reduced?.Plan is not null); Check.Equal(8, wire.Calls);
        var contents = wire.Bodies[^1].GetProperty("contents").EnumerateArray().Where(c => c.GetProperty("role").GetString() == "model").ToArray();
        Check.Equal(reduced!.Request.ProviderHistory.Length, contents.Length);
        for (int i = 0; i < contents.Length; i++)
        {
            var native = reduced.Request.ProviderHistory[i].Continuation!.Data.GetProperty("parts");
            Check.Equal(HarnessJson.Fingerprint(native), HarnessJson.Fingerprint(contents[i].GetProperty("parts")));
        }
        Check.True(!HarnessJson.Serialize(reduced.Request).Contains(Signature));
        Check.True(!HarnessJson.Serialize(reduced.Plan).Contains(Secret));
        var allSummarized = reduced.Request with { Messages = [new("user", "只剩摘要仍不能更换原生供应商身份")], ProviderHistory = [] };
        config["HarnessAi:Model"] = "changed-model";
        await Rejected(() => new GeminiHarnessModel(http, config, budget).Complete(allSummarized, campaign, default), "harness_model_contract");
        Check.Equal(8, wire.Calls); Check.Equal(8, budget.Read("text", campaign, true).Total);
        config["HarnessAi:Endpoint"] = "openai-chat"; config["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/v1";
        await Rejected(() => new OpenAiHarnessModel(http, config, budget).Complete(allSummarized, campaign, default), "harness_model_contract");
        Check.Equal(8, wire.Calls);
    }

}
