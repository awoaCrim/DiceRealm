using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class AiSettingsTests
{
    private static AiProviderEdit Off => new(false, "openai-chat", "", "", "keep");
    private static AiSettingsEdit Edit(long version, string model = "test-main", string key = "private-test-key") =>
        new(Guid.NewGuid().ToString(), version, new(true, "openai-chat", "http://127.0.0.1:1/v1", model, "replace", key), Off);
    public static async Task ImageSettingsAndFrozenCalls()
    {
        var wire = new ImageHandler();
        string root;
        AiSettingsEdit saved;
        await using (var host = await Host.Start(configure: builder =>
        {
            builder.Configuration["ImageAi:Endpoint"] = "http://127.0.0.1:1/legacy-images";
            builder.Configuration["ImageAi:Model"] = "legacy-image";
            builder.Configuration["ImageAi:ApiKey"] = "legacy-image-key";
            builder.Services.AddHttpClient<OpenAiImages>().ConfigurePrimaryHttpMessageHandler(() => wire);
        }))
        {
            root = host.Root;
            var store = host.App.Services.GetRequiredService<AiConfigurationStore>();
            var generator = ActivatorUtilities.CreateInstance<ConfiguredImages>(host.App.Services);
            Check.Equal("legacy-image", store.Read().Image!.Model); Check.True(generator.Enabled);
            var old = new AiSettingsEdit(Guid.NewGuid().ToString(), 0, Off, Off);
            Check.True(!JsonSerializer.Serialize(old, JsonFiles.Options).Contains("image"));
            store.Save(old); Check.Equal("legacy-image", store.Read().Image!.Model);
            var image = new AiImageEdit(true, "http://127.0.0.1:1/images/generations", "", "image-before", "replace", "private-image-before");
            saved = new(Guid.NewGuid().ToString(), 1, Off, Off, image);
            var view = store.Save(saved); Check.True(view.Image!.HasApiKey); Check.Equal(0, wire.Calls.Count);
            Check.True(!JsonSerializer.Serialize(view).Contains("private-image"));
            var job = new MapGenerationJob(Guid.NewGuid().ToString(), "", "lease", generator.CacheIdentity, AssetTests.Spec(), 1);
            var first = generator.Generate(job, default);
            await wire.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            store.Save(saved with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = 2, Image = image with { Model = "image-after", ApiKey = "private-image-after", SendResponseFormat = false } });
            wire.Release.TrySetResult(); await first;
            try { await generator.Generate(job, default); throw new Exception("Changed provider identity accepted"); }
            catch (ImageGenerationException ex) { Check.Equal("image_provider_changed", ex.Code); }
            await generator.Generate(job with { ProviderIdentity = generator.CacheIdentity }, default);
            Check.Equal(2, wire.Calls.Count);
            Check.Equal(("image-before", "private-image-before", true), wire.Calls[0]);
            Check.Equal(("image-after", "private-image-after", false), wire.Calls[1]);
            Check.Equal(2, host.App.Services.GetRequiredService<ProviderBudget>().Read("image", "", true).Total);
            store.Save(new(Guid.NewGuid().ToString(), 3, Off, Off));
            Check.Equal("image-after", store.Read().Image!.Model);
            Check.Equal(2L, store.Save(saved).Version); Check.Equal(4L, store.Read().Version);
            Check.Throws<GameException>(() => store.Save(saved with { RequestId = Guid.NewGuid().ToString(), ExpectedVersion = 4, Image = image with { Endpoint = "https://invalid.test/?secret=1" } }));
        }
        await using (var restarted = await Host.Start(root))
        {
            var store = restarted.App.Services.GetRequiredService<AiConfigurationStore>();
            Check.Equal("image-after", store.Read().Image!.Model); Check.Equal(2L, store.Save(saved).Version);
            store.Save(new(Guid.NewGuid().ToString(), 4, Off, Off, new(false, "", "", "", "clear")));
            Check.True(!store.Read().Image!.HasApiKey && !store.Read().Image!.Enabled);
        }
    }
    private sealed class ImageHandler : HttpMessageHandler
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<(string Model, string Key, bool Format)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Check.Equal("http://127.0.0.1:1/images/generations", request.RequestUri!.AbsoluteUri);
            using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            Calls.Add((json.RootElement.GetProperty("model").GetString()!, request.Headers.Authorization!.Parameter!, json.RootElement.TryGetProperty("response_format", out _)));
            Started.TrySetResult(); await Release.Task.WaitAsync(ct);
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { data = new[] { new { b64_json = Convert.ToBase64String(AssetTests.Png) } } }) };
        }
    }
    public static async Task HttpAuthorizationAndAtomicReceipts()
    {
        string root;
        var request = Edit(0);
        await using (var host = await Host.Start())
        {
            root = host.Root;
            await host.Create();
            // A valid DM campaign bearer is deliberately insufficient.
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync("/api/v1/operator/ai-settings")).StatusCode);
            Check.True(!File.Exists(Path.Combine(root, "operator", "access-token.txt")));
            host.Http.DefaultRequestHeaders.Add("X-DiceRealm-Local-Settings", "1");
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/operator/ai-settings")).StatusCode);
            AccountTests.SeedAdminFixture(host);
            await AccountTests.Login(host);
            Check.Equal(HttpStatusCode.OK, (await host.Http.GetAsync("/api/v1/operator/ai-settings")).StatusCode);
            host.Http.DefaultRequestHeaders.Add("Origin", "https://foreign.invalid");
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", request)).StatusCode);
            host.Http.DefaultRequestHeaders.Remove("Origin");
            var response = await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", request);
            Check.Equal(HttpStatusCode.OK, response.StatusCode);
            string body = await response.Content.ReadAsStringAsync();
            Check.True(!body.Contains(request.Main.ApiKey));
            var result = JsonSerializer.Deserialize<AiSettingsView>(body, JsonFiles.Options)!;
            Check.Equal(1L, result.Version); Check.True(result.Main.HasApiKey);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", request with { Main = request.Main with { Model = "different" } })).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", Edit(0))).StatusCode);
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", Edit(1) with { Main = request.Main with { BaseUrl = "https://example.test/v1?secret=x" } })).StatusCode);
            var next = Edit(1) with { Main = request.Main with { Model = "next", KeyAction = "keep", ApiKey = "" } };
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", next)).StatusCode);
            // Old acknowledgments remain replayable after a newer save; they do not roll state back.
            var replay = await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", request);
            Check.Equal(1L, (await replay.Content.ReadFromJsonAsync<AiSettingsView>())!.Version);
            Check.Equal(2L, host.App.Services.GetRequiredService<AiConfigurationStore>().Read().Version);
        }
        await using (var restarted = await Host.Start(root))
        {
            var store = restarted.App.Services.GetRequiredService<AiConfigurationStore>();
            Check.Equal(2L, store.Read().Version); Check.Equal("next", store.Read().Main.Model);
            Check.Equal(1L, store.Save(request).Version); Check.Equal(2L, store.Read().Version);
        }
    }
    public static async Task NewCallsChangeInflightDoesNot()
    {
        var wire = new CapturingHandler();
        await using var host = await Host.Start(configure: builder =>
        {
            builder.Services.AddHttpClient<OpenAiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => wire);
            builder.Configuration["HarnessAi:RetryCount"] = "0";
            builder.Configuration["HarnessAi:ThinkingLevel"] = "off";
        });
        var store = host.App.Services.GetRequiredService<AiConfigurationStore>();
        store.Save(Edit(0, "before", "secret-before"));
        var model = host.App.Services.GetRequiredService<IHarnessModel>();
        var request = new HarnessModelRequest("diagnostic", [new("user", "ping")], [], 0);
        var first = model.Complete(request, "", CancellationToken.None);
        await wire.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        store.Save(Edit(1, "after", "secret-after"));
        wire.Release.TrySetResult();
        await first;
        await model.Complete(request, "", CancellationToken.None);
        Check.Equal("before", wire.Calls[0].Model); Check.Equal("secret-before", wire.Calls[0].Key);
        Check.Equal("after", wire.Calls[1].Model); Check.Equal("secret-after", wire.Calls[1].Key);
        Check.Equal(2, host.App.Services.GetRequiredService<ProviderBudget>().Read("text", "", true).Total);
        var tokens = host.App.Services.GetRequiredService<ProviderBudget>().ReadTokens("");
        Check.Equal(6L, tokens.TotalInput); Check.Equal(2L, tokens.TotalOutput); Check.Equal(2L, tokens.ReportedResponses);
        store.Save(new(Guid.NewGuid().ToString(), 2, Off with { KeyAction = "clear" }, Off));
        Check.True(!model.Enabled);
        try { await model.Complete(request, "", CancellationToken.None); throw new Exception("Expected disabled provider rejection"); }
        catch (HarnessModelNotSentException) { }
        Check.Equal(2, wire.Calls.Count);
        Check.True(wire.OutputCaps.All(cap => !cap));
    }
    public static async Task ExplicitProbeAndHelper()
    {
        var probeWire = new FakeHandler("{\"choices\":[{\"message\":{\"content\":\"OK\"}}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}");
        var helperWire = new FakeHandler(FakeHandler.Chat(new { text = "辅助模型响应" }));
        await using var host = await Host.Start(configure: builder =>
        {
            builder.Services.AddHttpClient<OpenAiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => probeWire);
            builder.Services.AddHttpClient<OpenAiText>().ConfigurePrimaryHttpMessageHandler(() => helperWire);
        });
        var store = host.App.Services.GetRequiredService<AiConfigurationStore>();
        var edit = Edit(0); store.Save(edit with { Helper = edit.Main with { Model = "helper" } });
        var test = host.App.Services.GetRequiredService<AiConnectionTester>();
        var request = new AiProbeRequest(Guid.NewGuid().ToString(), 1, "main", true);
        try { await test.Test(request with { ConfirmProviderUse = false }); throw new Exception("Missing confirmation accepted"); } catch (GameException) { }
        Check.Equal(0, probeWire.Calls);
        var result = await test.Test(request); Check.Equal("success", result.Status); Check.Equal(1, probeWire.Calls);
        Check.Equal(result, await test.Test(request)); Check.Equal(result, store.ReadProbe(request.RequestId)); Check.Equal(1, probeWire.Calls);
        var text = host.App.Services.GetRequiredService<ConfiguredText>();
        var narrative = await text.Narrate(new("test", "hero", "observe", []), CancellationToken.None, prompts: TestContent.Prompts);
        Check.Equal("辅助模型响应", narrative.Text); Check.Equal(1, helperWire.Calls);
        var budget = host.App.Services.GetRequiredService<ProviderBudget>();
        Check.Equal(2, budget.Read("text", "", true).Total);
        var tokens = budget.ReadTokens(""); Check.Equal(2L, tokens.TotalInput); Check.Equal(1L, tokens.TotalOutput);
        Check.Equal(1L, tokens.ReportedResponses); Check.Equal(1L, tokens.UnreportedResponses);
        store.Save(new(Guid.NewGuid().ToString(), 1, Off, Off));
        var offline = await text.Narrate(new("test", "hero", "observe", []), CancellationToken.None, prompts: TestContent.Prompts);
        Check.Equal("offline", offline.Source); Check.Equal(1, helperWire.Calls);
    }
    public static async Task PreparationFrozenBeforeUnknownAndLegacyEndpoint()
    {
        var wire = new CapturingHandler(); wire.Release.TrySetResult();
        await using (var host = await Host.Start(configure: builder =>
        {
            builder.Configuration["HarnessAi:Endpoint"] = "http://127.0.0.1:1/custom-proxy";
            builder.Configuration["HarnessAi:Model"] = "legacy"; builder.Configuration["HarnessAi:ApiKey"] = "legacy-secret";
            builder.Services.AddHttpClient<OpenAiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => wire);
        }))
        {
            var store = host.App.Services.GetRequiredService<AiConfigurationStore>(); var before = store.Read();
            Check.True(before.Main.EndpointIsComplete); Check.Equal("http://127.0.0.1:1/custom-proxy", before.Main.BaseUrl);
            store.Save(new(Guid.NewGuid().ToString(), 0, new(true, before.Main.Provider, before.Main.BaseUrl, before.Main.Model, "keep", EndpointIsComplete: true), Off));
            await host.App.Services.GetRequiredService<IHarnessModel>().Complete(new("test", [new("user", "ping")], [], 32), "", CancellationToken.None);
            Check.Equal("http://127.0.0.1:1/custom-proxy", wire.Calls[0].Uri); Check.Equal("legacy-secret", wire.Calls[0].Key);
        }
        string requestId = Guid.NewGuid().ToString();
        var prepWire = new FakeHandler(FakeHandler.Chat(new
        {
            startSceneId = "harbor", scenes = new[] { new { id = "harbor", title = "雾港", summary = "潮雾", arrival = "抵达", evidence = new[] { new { field = "sourceText", start = 0, length = 2, quote = "潮雾" } } } },
            routes = Array.Empty<object>(), knowledge = Array.Empty<object>(), questions = Array.Empty<string>()
        }));
        await using (var host = await Host.Start(configure: builder =>
        {
            builder.Services.AddHttpClient<OpenAiPreparation>().ConfigurePrimaryHttpMessageHandler(() => prepWire);
            builder.Services.AddSingleton<IPreparationGenerator>(sp => new BeforeGenerate(ActivatorUtilities.CreateInstance<ConfiguredPreparation>(sp), campaign =>
            {
                var record = sp.GetRequiredService<PreparationCatalog>().Find(campaign, requestId)!;
                Check.Equal("unknown", record.Result.Status); Check.Equal("frozen-helper", record.Result.ProviderModel);
                sp.GetRequiredService<AiConfigurationStore>().Save(new(Guid.NewGuid().ToString(), 1, Off, Off));
            }));
        }))
        {
            var owner = await host.Create(); var store = host.App.Services.GetRequiredService<AiConfigurationStore>();
            store.Save(Edit(0) with { Helper = Edit(0, "frozen-helper").Main });
            var request = new PreparationRequest(requestId, new("潮雾笼罩旧港。", "整理港口。", "雾港", "frozen-prep", "1", true, 600), new("prep", "1", "作者原文"), true);
            var result = await host.App.Services.GetRequiredService<PreparationService>().Prepare(owner.Snapshot.Id, owner.AccessToken, request, CancellationToken.None);
            Check.Equal("ready", result.Status); Check.Equal("frozen-helper", result.ProviderModel); Check.Equal(1, prepWire.Calls);
            Check.True(!store.Read().Helper.Enabled);
        }
    }
    public static async Task NativeHelperProtocolAcrossConsumers()
    {
        var wire = new NativeHelperHandler();
        await using var host = await Host.Start(configure: builder =>
        {
            builder.Services.AddHttpClient<GeminiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => wire);
            builder.Services.AddHttpClient<OpenAiText>().ConfigurePrimaryHttpMessageHandler(() => wire);
            builder.Services.AddHttpClient<OpenAiPreparation>().ConfigurePrimaryHttpMessageHandler(() => wire);
        });
        var store = host.App.Services.GetRequiredService<AiConfigurationStore>();
        var helper = new AiProviderEdit(true, "gemini", "http://127.0.0.1:1/v1beta", "native-helper", "replace", "helper-secret");
        store.Save(new(Guid.NewGuid().ToString(), 0, Off, helper));
        Check.Equal("gemini", store.Read().Helper.Provider);
        wire.Replies.Enqueue("OK");
        var probe = await host.App.Services.GetRequiredService<AiConnectionTester>().Test(new(Guid.NewGuid().ToString(), 1, "helper", true));
        Check.Equal("success", probe.Status);
        wire.Replies.Enqueue("{\"text\":\"原生辅助叙事\"}");
        var reply = await ActivatorUtilities.CreateInstance<ConfiguredText>(host.App.Services).Narrate(new("test", "hero", "observe", []), CancellationToken.None, prompts: TestContent.Prompts);
        Check.Equal("原生辅助叙事", reply.Text);
        var frozen = ActivatorUtilities.CreateInstance<ConfiguredPreparation>(host.App.Services).Capture();
        store.Save(new(Guid.NewGuid().ToString(), 1, Off, Edit(0).Main));
        wire.Replies.Enqueue("{\"startSceneId\":\"harbor\",\"scenes\":[],\"routes\":[],\"knowledge\":[],\"questions\":[]}");
        string exactPrompt = "保持作者原文" + (char)13 + (char)10 + "不变";
        var proposal = await frozen.Generate(new("测试原文", "整理", exactPrompt), CancellationToken.None, "");
        Check.Equal("harbor", proposal.StartSceneId);
        Check.Equal(3, wire.Bodies.Count);
        Check.True(!wire.Bodies[0].TryGetProperty("generationConfig", out _));
        Check.Equal(TestContent.Prompts.Narration, wire.Bodies[1].GetProperty("systemInstruction").GetProperty("parts")[0].GetProperty("text").GetString());
        Check.Equal(exactPrompt, wire.Bodies[2].GetProperty("systemInstruction").GetProperty("parts")[0].GetProperty("text").GetString());
        foreach (var body in wire.Bodies.Skip(1))
        {
            Check.Equal("application/json", body.GetProperty("generationConfig").GetProperty("responseMimeType").GetString());
            Check.True(!body.GetProperty("generationConfig").TryGetProperty("maxOutputTokens", out _));
        }
        var usage = host.App.Services.GetRequiredService<ProviderBudget>().ReadTokens("");
        Check.Equal(3L, usage.ReportedResponses); Check.Equal(15L, usage.TotalInput); Check.Equal(15L, usage.TotalOutput);
        var restored = new AiConfigurationStore(host.App.Services.GetRequiredService<DataDirectory>(), new ConfigurationBuilder().Build());
        Check.Equal("openai-chat", restored.Read().Helper.Provider);
    }
    private sealed class NativeHelperHandler : HttpMessageHandler
    {
        public Queue<string> Replies { get; } = new();
        public List<JsonElement> Bodies { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Check.Equal("http://127.0.0.1:1/v1beta/models/native-helper:generateContent", request.RequestUri!.AbsoluteUri);
            Check.True(request.Headers.Authorization is null);
            Check.Equal("helper-secret", request.Headers.GetValues("x-goog-api-key").Single());
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            Check.True(body.RootElement.TryGetProperty("contents", out _));
            Check.True(!body.RootElement.TryGetProperty("messages", out _));
            Bodies.Add(body.RootElement.Clone());
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new
            {
                candidates = new[] { new { finishReason = "STOP", content = new { parts = new object[] { new { text = "private-thought", thought = true }, new { text = Replies.Dequeue() } } } } },
                usageMetadata = new { promptTokenCount = 5, candidatesTokenCount = 2, thoughtsTokenCount = 3 }
            }) };
        }
    }
    private sealed class BeforeGenerate(IPreparationGenerator inner, Action<string> before) : IPreparationGenerator
    {
        public bool Enabled => inner.Enabled;
        public string Model => inner.Model;
        public IPreparationGenerator Capture() => new BeforeGenerate(inner.Capture(), before);
        public Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken ct, string campaign)
        { before(campaign); return inner.Generate(request, ct, campaign); }
    }
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<bool> OutputCaps { get; } = [];
        public List<(string Model, string Key, string Uri)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            OutputCaps.Add(body.RootElement.TryGetProperty("max_tokens", out _));
            Calls.Add((body.RootElement.GetProperty("model").GetString()!, request.Headers.Authorization!.Parameter!, request.RequestUri!.AbsoluteUri));
            if (Calls.Count == 1) { Started.TrySetResult(); await Release.Task.WaitAsync(cancellationToken); }
            return new(HttpStatusCode.OK) { Content = new StringContent("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"pong\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}") };
        }
    }
}
