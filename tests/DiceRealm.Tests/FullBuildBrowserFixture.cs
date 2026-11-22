using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

// Opt-in browser/player acceptance against real endpoints, an empty temporary database,
// deterministic dice and a counted in-process model that refuses every invocation.
internal static class FullBuildBrowserFixture
{
    private sealed class FixtureImages : IMapImageGenerator
    {
        public bool Enabled => true;
        public string CacheIdentity => "room-browser-fixture-pixel";
        public int Calls;
        public Task<byte[]> Generate(DiceRealm.Server.Domain.MapGenerationJob job, CancellationToken ct)
        { Interlocked.Increment(ref Calls); return Task.FromResult(AssetTests.Png); }
    }
    private sealed class ConfigurationProbeHandler : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            { Content = new StringContent("{\"choices\":[{\"message\":{\"content\":\"OK\"}}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":1}}") });
        }
    }
    public static async Task Run(string statePath, string? address = null, string? resumeRoot = null, bool automaticMaps = false, bool configurationProbe = false)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture state path.");
        if (address is not null && (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || !uri.IsLoopback || uri.Scheme != "http"))
            throw new InvalidOperationException("Fixture address must be loopback HTTP.");
        if (resumeRoot is not null)
        {
            resumeRoot = Path.GetFullPath(resumeRoot);
            if (!Path.GetDirectoryName(resumeRoot)!.Equals(Path.TrimEndingDirectorySeparator(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)
                || !Path.GetFileName(resumeRoot).StartsWith("dicerealm-tests-", StringComparison.Ordinal) || !Directory.Exists(resumeRoot))
                throw new InvalidOperationException("Only an existing isolated temporary test database may resume.");
        }
        var model = new HarnessTests.Model((_, request) =>
        {
            if (!automaticMaps) throw new InvalidOperationException("No generation authorized in full-build acceptance");
            var tools = request.Messages.Where(m => m.Role == "tool").ToArray();
            if (!tools.Any(m => m.Name == "context_read")) return HarnessTests.Tool("context_read");
            if (!tools.Any(m => m.Name == "map_request")) return HarnessTests.Tool("map_request", new { kind = "settlement" });
            return HarnessTests.Text("当前地点示意图已经申请，可在地图页查看。示意图未标定距离；这是一条隔离验收回应。");
        });
        var images = automaticMaps ? new FixtureImages() : null;
        var probe = configurationProbe ? new ConfigurationProbeHandler() : null;
        var dice = new SequenceDice();
        await using var host = await Host.Start(root: resumeRoot, dice: dice, images: images, configure: HarnessTests.Configure(model, extra: builder =>
        {
            if (address is not null) builder.WebHost.UseUrls(address);
            if (automaticMaps)
            {
                builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
                builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
            }
            if (probe is not null)
            {
                builder.Services.AddHttpClient<OpenAiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => probe);
                builder.Services.AddHttpClient<GeminiHarnessModel>().ConfigurePrimaryHttpMessageHandler(() => probe);
                builder.Services.AddHttpClient<OpenAiText>().ConfigurePrimaryHttpMessageHandler(() => probe);
                builder.Services.AddHttpClient<OpenAiPreparation>().ConfigurePrimaryHttpMessageHandler(() => probe);
            }
            foreach (string prefix in new[] { "TextAi", "ImageAi", "HarnessAi", "PreparationAi" })
            {
                builder.Configuration[prefix + ":ApiKey"] = "";
                builder.Configuration[prefix + ":Model"] = "";
            }
        }));
        if (resumeRoot is null) AccountTests.SeedAdminFixture(host);
        JsonFiles.Write(statePath, new { baseUrl = host.Http.BaseAddress!.GetLeftPart(UriPartial.Authority),
            dataPath = host.Root, processId = Environment.ProcessId, fixture = configurationProbe ? "experience-fake-configuration" : automaticMaps ? "room-onboarding-fake-map" : "full-build-only" });
        Console.WriteLine("Isolated full-build acceptance ready. Providers disabled; no campaign seeded.");
        while (!File.Exists(statePath + ".stop"))
        {
            JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, imageCalls = images?.Calls ?? 0, providers = configurationProbe ? "fake-HTTP-only" : "disabled", configurationCalls = probe?.Calls ?? 0, runtime = automaticMaps ? "real-pi-fake-providers" : "disabled" });
            await Task.Delay(250);
        }
        if (!automaticMaps) Check.Equal(0, model.Calls);
    }
}
