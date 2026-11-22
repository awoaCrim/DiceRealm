using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Manual T1-AB experiment only. Never included in the automatic test list.
internal static class ReadPreloadAcceptance
{
    private static readonly string[] Inputs =
    [
        "我停在原地，看看码头上肉眼可见的环境。",
        "我问守港人：这里发生了什么？",
        "我看看地图上我们现在的位置，不移动。",
        "先查一下普通木门的物件AC和HP规则，再核对这个场景里我已有的检定记录。先别掷骰或破门。"
    ];

    public static async Task Prepare(string output, string sourceData, string rules)
    {
        output = Path.GetFullPath(output);
        if (Directory.Exists(output)) throw new InvalidOperationException("Use a fresh experiment directory.");
        Directory.CreateDirectory(output);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(output, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        const string campaignId = "cdada72a-47d3-4b35-bb5f-ad08b81bb14c";
        string sourceFile = Path.Combine(sourceData, "campaigns", campaignId + ".sqlite");
        // Consistent read-only backup. No operator DB, credentials or other campaign is copied.
        using (var source = OpenRead(sourceFile))
        using (var copy = new SqliteConnection($"Data Source={Path.Combine(output, "source-campaign.sqlite")};Pooling=False"))
        {
            copy.Open(); source.BackupDatabase(copy);
        }
        using var db = OpenRead(Path.Combine(output, "source-campaign.sqlite"));
        using var command = db.CreateCommand(); command.CommandText = "SELECT json FROM state WHERE id=1";
        var campaign = JsonSerializer.Deserialize<Campaign>((string)command.ExecuteScalar()!, JsonFiles.Options)!;
        var preset = campaign.Harness!.Preset;
        Copy(rules, Path.Combine(output, "rules"));
        var adventure = JsonSerializer.Deserialize<AdventureDocument>(JsonSerializer.Serialize(TestContent.Document, JsonFiles.Options), JsonFiles.Options)!;
        adventure = adventure with { Npcs = [.. adventure.Npcs, new("harbor-keeper", "守港人", "harbor", "",
            "在残破的栈桥旁守候，知道退潮时的安全路线与手动点灯方法；旧灯塔熄灭，返航船只可能驶入暗礁。", new(), new(), [])] };
        CreatedCampaign owner;
        string seed = Path.Combine(output, "seed");
        await using (var host = await Host.Start(seed, configure: Configure(new Model((_, _) => throw new Exception("Seed must stay offline.")),
            extra: b => { b.Configuration["LocalRules:Directory"] = Path.Combine(output, "rules"); b.Configuration["TextAi:Model"] = ""; b.Configuration["TextAi:ApiKey"] = ""; })))
        {
            using var response = await host.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest(
                "T1-AB 雾港码头隔离样本", "Arden", adventure, preset, [], Build: FullCreationTests.Named("Arden")));
            response.EnsureSuccessStatusCode(); owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var map = SharedBoardTests.Install(host, owner.Snapshot.Id);
            await SharedBoardTests.BoardPost<BoardCommandResponse>(host, owner.Snapshot.Id, "board/commands",
                new BoardCommandRequest(Id(), (await host.Get(owner.Snapshot.Id))!.Version, map.Id, "spawn", Spawns:
                    [new("", "creature", new("player", "player"), new("Arden"), .2, .3, "player")]));
            Write(Path.Combine(output, "seed-snapshot.json"), await host.Get(owner.Snapshot.Id));
        }
        // This is an isolated fixture seat token, never an operator/provider credential.
        Write(Path.Combine(output, "fixture-owner.json"), new { owner.AccessToken, campaignId = owner.Snapshot.Id });
        Write(Path.Combine(output, "manifest.json"), new
        {
            inputs = Inputs, contracts = new[] { 55, 56 }, maximumHttpAttempts = 60, sourceCampaign = campaignId,
            sourceVersion = campaign.Version, sourceScene = campaign.SceneId,
            fallbackReason = "三猪小径没有可交谈NPC及绑定的公开地图，且主持席位没有角色；无法完整覆盖四项，采用派单允许的雾港码头夹具。",
            sourceCampaignSha256 = JsonFiles.Hash(File.ReadAllBytes(Path.Combine(output, "source-campaign.sqlite"))),
            promptSha256 = JsonFiles.Hash(preset.SystemPrompt), promptId = preset.Id,
            seedFiles = Hashes(seed), rulesFiles = Hashes(Path.Combine(output, "rules")),
            map = "Existing offline test map: two colored rectangles, not an authored harbor illustration.",
            created = DateTimeOffset.UtcNow
        });
        foreach (int contract in new[] { 55, 56 })
        {
            string probeRoot = Path.Combine(output, $"offline-v{contract}");
            Copy(seed, probeRoot);
            var observer = new Observer(probeRoot);
            await using var host = await Host.Start(probeRoot, configure: Configure(observer.Bind(new Model((_, _) => Text("离线预检完成。"))),
                extra: b => { b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Configuration["LocalRules:Directory"] = Path.Combine(output, "rules");
                    b.Configuration["TextAi:Model"] = ""; b.Configuration["TextAi:ApiKey"] = ""; }));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var run = await StartVariant(host, owner.Snapshot.Id, new(Id(), (await host.Get(owner.Snapshot.Id))!.Version, Inputs[0]), contract);
            run = await Settled(host, owner.Snapshot.Id, run.Id, 3000);
            Check.Equal("completed", run.Status);
            Console.WriteLine($"Offline contract {contract} preflight passed: {observer.FirstRequestBytes} bytes.");
        }
        Console.WriteLine("Prepared isolated seed; no supplier calls.");
    }

    public static async Task Run(string output, string settingsDatabase)
    {
        output = Path.GetFullPath(output);
        using (File.Open(Path.Combine(output, "started"), FileMode.CreateNew)) { }
        var provider = ReadProvider(settingsDatabase);
        Write(Path.Combine(output, "provider.json"), provider.Public);
        using var owner = JsonDocument.Parse(File.ReadAllText(Path.Combine(output, "fixture-owner.json")));
        string id = owner.RootElement.GetProperty("campaignId").GetString()!;
        string token = owner.RootElement.GetProperty("accessToken").GetString()!;
        var budget = new CallBudget();
        for (int sample = 0; sample < Inputs.Length; sample++)
        foreach (int contract in sample % 2 == 0 ? new[] { 55, 56 } : new[] { 56, 55 })
        {
            if (budget.Calls >= 60) { Console.WriteLine("Authorization budget exhausted; remaining runs skipped."); return; }
            string root = Path.Combine(output, $"sample-{sample + 1}-v{contract}");
            Copy(Path.Combine(output, "seed"), root);
            var observer = new Observer(root);
            await using var host = await Host.Start(root, configure: b =>
            {
                b.Configuration["LocalRules:Directory"] = Path.Combine(output, "rules");
                foreach (var setting in provider.Values) b.Configuration[setting.Key] = setting.Value;
                b.Configuration["Harness:Enabled"] = "true";
                b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
                b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
                b.Services.AddHttpClient(nameof(GeminiHarnessModel)).AddHttpMessageHandler(() => new BudgetHandler(budget));
                b.Services.AddSingleton<IHarnessModel>(s => observer.Bind(new ConfiguredHarnessModel(s.GetRequiredService<AiConfigurationStore>(),
                    s.GetRequiredService<IHttpClientFactory>(), s.GetRequiredService<ProviderBudget>(), s.GetRequiredService<ILoggerFactory>())));
            });
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var before = (await host.Get(id))!;
            Console.WriteLine($"Starting sample {sample + 1}, contract {contract}; HTTP calls so far {budget.Calls}.");
            int callsBefore = budget.Calls;
            var timer = Stopwatch.StartNew();
            var run = await StartVariant(host, id, new(Id(), before.Version, Inputs[sample]), contract);
            run = await Settled(host, id, run.Id, 24000);
            timer.Stop();
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Write(Path.Combine(root, "run.json"), saved);
            Write(Path.Combine(root, "after.json"), await host.Get(id));
            var log = host.App.Services.GetRequiredService<ModelRequestLog>();
            var requests = log.List(id, null, 100, false).Requests.OrderBy(r => r.Id).Select(r => log.Get(r.Id, id)!).ToArray();
            Write(Path.Combine(root, "http.json"), requests.Select(r => new { r.Summary, usage = Usage(r.ResponseBody) }));
            Write(Path.Combine(root, "observation.json"), new
            {
                sample = sample + 1, contract, input = Inputs[sample], run.Status, run.Error, run.Text, run.Wait,
                wallMilliseconds = timer.ElapsedMilliseconds, httpAttempts = budget.Calls - callsBefore,
                cumulativeHttpAttempts = budget.Calls, modelSlots = observer.Calls, observer.FirstRequestBytes,
                firstHttpRequestBytes = requests.FirstOrDefault()?.Summary.RequestBytes,
                tools = saved.Steps.Where(s => s.Kind == "tool").Select(s => new { s.ToolName, s.Outcome?.Reply.IsError, s.Outcome?.Reply.Stop }),
                semanticVerdict = "Awaiting Claude Code review; no automatic narrative quality verdict."
            });
            Console.WriteLine($"Finished sample {sample + 1}, contract {contract}: {run.Status}/{run.Error}, {timer.ElapsedMilliseconds} ms, {budget.Calls - callsBefore} HTTP calls.");
        }
        Console.WriteLine($"Experiment finished: {budget.Calls}/60 HTTP calls; eight runs, no resampling.");
    }

    private static async Task<HarnessRunView> StartVariant(Host host, string id, HarnessInputRequest input, int contract)
    {
        string token = host.Http.DefaultRequestHeaders.Authorization!.Parameter!;
        var game = host.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(id, token, default);
        var context = await game.ValidateHarnessStart(id, token, input.ExpectedVersion, default, input.Text);
        var run = new HarnessRun
        {
            Id = input.RequestId, IntentId = Id(), CampaignId = id, ActorId = auth.ActorId,
            Fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(input)), Input = input.Text,
            Profile = context.Profile, MemorySnapshot = context.Memory, Version = input.ExpectedVersion,
            ToolContractVersion = contract, RulesCatalogVersion = context.RulesCatalogVersion,
            Limits = new(ProviderDefaultOutput: true),
            Turns = [HarnessJson.Serialize(new { input = input.Text, ruleset = "dnd2024", memory = context.Memory })]
        };
        host.App.Services.GetRequiredService<HarnessRunStore>().Create(run);
        return await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version));
    }

    private sealed class Observer(string root) : IHarnessModel
    {
        private IHarnessModel inner = null!;
        public int Calls { get; private set; }
        public int? FirstRequestBytes { get; private set; }
        public bool Enabled => inner.Enabled;
        public IHarnessModel Bind(IHarnessModel model) { inner = model.Capture(); return this; }
        public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
        {
            int call = ++Calls;
            if (call == 1) FirstRequestBytes = HarnessContextCompactor.PreserveCurrent(request).Plan!.EffectiveBytes;
            Write(Path.Combine(root, $"model-{call:D3}-request.json"), request);
            var response = await inner.Complete(request, campaignId, ct);
            Write(Path.Combine(root, $"model-{call:D3}-reply.json"), response);
            return response;
        }
    }

    private sealed class CallBudget { public int Calls; }
    private sealed class ExperimentLimitException : Exception;
    private sealed class BudgetHandler(CallBudget budget) : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            // Count every actual HTTP attempt, including the existing adapter's retries.
            if (budget.Calls >= 60) throw new ExperimentLimitException();
            Interlocked.Increment(ref budget.Calls);
            return base.SendAsync(request, ct);
        }
    }

    private static (Dictionary<string, string?> Values, object Public) ReadProvider(string path)
    {
        using var db = OpenRead(path); using var command = db.CreateCommand(); command.CommandText = "SELECT json FROM settings WHERE id=1";
        using var json = JsonDocument.Parse((string)command.ExecuteScalar()!);
        var main = json.RootElement.GetProperty("main");
        if (!main.GetProperty("enabled").GetBoolean() || main.GetProperty("provider").GetString() != "gemini" ||
            main.GetProperty("endpointIsComplete").GetBoolean()) throw new InvalidOperationException("Expected current enabled Gemini main profile.");
        string model = main.GetProperty("model").GetString()!, url = main.GetProperty("baseUrl").GetString()!;
        return (new()
        {
            ["HarnessAi:Endpoint"] = "gemini", ["HarnessAi:BaseUrl"] = url, ["HarnessAi:Model"] = model,
            ["HarnessAi:ApiKey"] = main.GetProperty("apiKey").GetString(),
            // Verified running daily package uses these existing defaults; no level/retry change.
            ["HarnessAi:ThinkingLevel"] = "high", ["HarnessAi:IncludeThoughts"] = "true", ["HarnessAi:RetryCount"] = "3",
            ["HarnessAi:RetryInitialDelayMilliseconds"] = "1000", ["HarnessAi:AttemptTimeoutSeconds"] = "180",
            ["TextAi:Model"] = "", ["TextAi:ApiKey"] = "", ["ImageAi:Model"] = "", ["ImageAi:ApiKey"] = ""
        }, new { provider = "gemini", model, baseUrl = url, thinkingLevel = "high", includeThoughts = true, retryCount = 3,
            retryInitialDelayMilliseconds = 1000, attemptTimeoutSeconds = 180, helper = "disabled", images = "disabled" });
    }

    private static JsonElement? Usage(string response)
    {
        if (string.IsNullOrEmpty(response)) return null;
        try { using var json = JsonDocument.Parse(response); return json.RootElement.TryGetProperty("usageMetadata", out var usage) ? usage.Clone() : null; }
        catch (JsonException) { return null; }
    }
    private static SqliteConnection OpenRead(string path)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.GetFullPath(path), Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        db.Open(); return db;
    }
    private static Dictionary<string, string> Hashes(string root) => Directory.GetFiles(root, "*", SearchOption.AllDirectories)
        .ToDictionary(file => Path.GetRelativePath(root, file), file => JsonFiles.Hash(File.ReadAllBytes(file)));
    private static void Write(string path, object? value) => File.WriteAllText(path, JsonSerializer.Serialize(value, JsonFiles.Options));
    private static void Copy(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (string file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        foreach (string child in Directory.GetDirectories(source)) Copy(child, Path.Combine(target, Path.GetFileName(child)));
    }
}
