using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Explicit paid-provider experiment, never registered in the automatic test list.
// New synthetic samples; this does not reconstruct or replay the missing v2 experiment.
internal static class PromptSemanticsAcceptance
{
    public static async Task Run(string output, string settingsDatabase, string baseline, string candidate,
        string? candidateSample = null, string? rulesDirectory = null)
    {
        output = Path.GetFullPath(output);
        if (Directory.Exists(output)) throw new InvalidOperationException("Use a fresh experiment output directory.");
        var samples = new[]
        {
            new Sample("name", "我问柜台后的岑远：‘请问你叫什么名字？’"),
            new Sample("potion", "我问岑远：‘你这里有治疗药水卖吗？’"),
            new Sample("hostile", "岑远已经决定现在用拳头攻击Arden；处理这次攻击。"),
            new Sample("discovery", "我仔细搜索北侧灌木，寻找通往林中的足迹。"),
            new Sample("pending", "请把我的棋子移到地图中央。"),
            new Sample("failed", "把地图上的木箱移动到地图中央。")
        };
        if (candidateSample is not null && !samples.Any(sample => sample.Id == candidateSample))
            throw new ArgumentException("Unknown candidate sample. Use name, potion, hostile, discovery, pending or failed.", nameof(candidateSample));
        string? catalogVersion = null;
        Dictionary<string, string>? rulesFiles = null;
        if (rulesDirectory is not null)
        {
            if (string.IsNullOrWhiteSpace(rulesDirectory)) throw new ArgumentException("Rules directory must not be empty.", nameof(rulesDirectory));
            rulesDirectory = Path.GetFullPath(rulesDirectory);
            if (!Directory.Exists(rulesDirectory)) throw new DirectoryNotFoundException(rulesDirectory);
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                { ["LocalRules:Directory"] = rulesDirectory }).Build();
            catalogVersion = new LocalRulesCatalog(configuration).CaptureVersion();
            rulesFiles = Directory.GetFiles(rulesDirectory, "*", SearchOption.AllDirectories)
                .OrderBy(file => file, StringComparer.Ordinal)
                .ToDictionary(file => Path.GetRelativePath(rulesDirectory, file), file => JsonFiles.Hash(File.ReadAllBytes(file)));
        }
        string newText = File.ReadAllText(candidate);
        string? oldText = candidateSample is null ? File.ReadAllText(baseline) : null;
        var provider = ReadProvider(settingsDatabase);
        Directory.CreateDirectory(output);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(output, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Write(Path.Combine(output, "experiment.json"), new
        {
            kind = candidateSample is null ? "new-isolated-synthetic-prompt-comparison" : "new-isolated-synthetic-candidate-only",
            previousV2Replayed = false, candidateSample,
            baselineSha256 = candidateSample is null ? JsonFiles.Hash(File.ReadAllBytes(baseline)) : null,
            candidateSha256 = JsonFiles.Hash(File.ReadAllBytes(candidate)),
            rulesDirectory, catalogVersion, rulesFiles,
            rulesDirectorySha256 = rulesFiles is null ? null : JsonFiles.Hash(HarnessJson.Serialize(rulesFiles)),
            provider = provider.Public, created = DateTimeOffset.UtcNow,
            semanticVerdict = "manual review required; receipt observations are not semantic passes"
        });
        foreach (var sample in samples.Where(sample => candidateSample is null || sample.Id == candidateSample))
        {
            string sampleRoot = Path.Combine(output, sample.Id), seed = Path.Combine(sampleRoot, "seed");
            CreatedCampaign owner;
            await using (var host = await Host.Start(seed, configure: Configure(new Model((_, _) => throw new InvalidOperationException("Seed must not call a provider.")),
                extra: builder => builder.Configuration["LocalRules:Directory"] = rulesDirectory)))
            {
                using var response = await host.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest(
                    "新隔离语义样本 " + sample.Id, "Arden", Adventure(), new("prompt-recheck", 1, oldText ?? newText), [], Build: FullCreationTests.Named("Arden")));
                response.EnsureSuccessStatusCode(); owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                if (sample.Id is "pending" or "failed")
                {
                    var map = SharedBoardTests.Install(host, owner.Snapshot.Id);
                    bool player = sample.Id == "pending";
                    await SharedBoardTests.BoardPost<BoardCommandResponse>(host, owner.Snapshot.Id, "board/commands",
                        new BoardCommandRequest(Id(), (await host.Get(owner.Snapshot.Id))!.Version, map.Id, "spawn", Spawns:
                        [new("", player ? "creature" : "object", new(player ? "player" : "custom", player ? "player" : ""),
                            new(player ? "Arden" : "木箱"), .2, .3, player ? "player" : "")]));
                    if (player) await Post<ActionResponse>(host, owner.Snapshot.Id, "characters/adjust", new AdjustCharacterRequest(
                        Id(), (await host.Get(owner.Snapshot.Id))!.Version, "player", "隔离样本：角色受擒抱，移动需要权威处理。", "synthetic fixture",
                        [new("condition", "Grappled", 1)]));
                }
                Write(Path.Combine(sampleRoot, "seed-snapshot.json"), await host.Get(owner.Snapshot.Id));
            }
            var observations = new List<Observer>();
            Write(Path.Combine(sampleRoot, "seed-files.json"), Directory.GetFiles(seed, "*", SearchOption.AllDirectories)
                .ToDictionary(file => Path.GetRelativePath(seed, file), file => JsonFiles.Hash(File.ReadAllBytes(file))));
            var variants = candidateSample is null
                ? new[] { (Name: "baseline", Text: oldText!), (Name: "candidate", Text: newText) }
                : new[] { (Name: "candidate", Text: newText) };
            foreach (var variant in variants)
            {
                string root = Path.Combine(sampleRoot, variant.Name);
                Copy(seed, root);
                var observer = new Observer(root, sample.Id == "failed");
                observations.Add(observer);
                await using var host = await Host.Start(root, configure: builder =>
                {
                    builder.Configuration["LocalRules:Directory"] = rulesDirectory;
                    foreach (var setting in provider.Values) builder.Configuration[setting.Key] = setting.Value;
                    builder.Configuration["Harness:Enabled"] = "true";
                    builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
                    // Single samples, no transport resampling. Same explicit policy for both variants.
                    builder.Configuration["HarnessAi:RetryCount"] = "0";
                    builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
                    builder.Services.AddSingleton<IHarnessModel>(services => observer.Bind(new ConfiguredHarnessModel(
                        services.GetRequiredService<AiConfigurationStore>(), services.GetRequiredService<IHttpClientFactory>(),
                        services.GetRequiredService<ProviderBudget>(), services.GetRequiredService<Microsoft.Extensions.Logging.ILoggerFactory>())));
                });
                observer.Host = host;
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                // Only the fresh isolated clone is changed, before any run freezes a profile.
                await host.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, campaign =>
                {
                    var preset = new HarnessPreset("prompt-recheck", 1, variant.Text);
                    campaign.Harness = new(preset, HarnessJson.ProfileHash(preset, []), []);
                    return Task.FromResult(true);
                }, default);
                var before = (await host.Get(owner.Snapshot.Id))!;
                Write(Path.Combine(root, "before.json"), before);
                var run = await Start(host, before, sample.Input);
                run = await Settled(host, before.Id, run.Id, 24000);
                var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(before.Id, PartyEngine.HostId, run.Id)!;
                Write(Path.Combine(root, "run.json"), saved);
                Write(Path.Combine(root, "after.json"), await host.Get(before.Id));
                var pending = saved.Steps.Where(s => s.ToolName == "token_move" && s.Outcome?.Reply.Stop == true).ToArray();
                var failed = saved.Steps.Where(s => s.ToolName == "token_move" && s.Outcome?.Reply.IsError == true).ToArray();
                var refresh = saved.Steps.Where(s => s.ToolName == "token_move" && s.Outcome is { } outcome && IsRefresh(outcome.Reply.Content)).ToArray();
                Write(Path.Combine(root, "observation.json"), new
                {
                    sample.Id, sample.Input, run.Status, run.Text, run.Error, run.ModelAttempts, run.ToolSteps,
                    observer.Calls, observer.RaceInjected, observer.ErrorReplySeenByModel, observer.RefreshReplySeenByModel,
                    pendingReceiptObserved = pending.Length > 0, failedReceiptObserved = failed.Length > 0,
                    refreshReceiptObserved = refresh.Length > 0,
                    pendingSteps = pending.Select(s => s.Id), failedSteps = failed.Select(s => s.Id), refreshSteps = refresh.Select(s => s.Id),
                    semanticVerdict = "unreviewed", coverage = sample.Id switch
                    {
                        "pending" => pending.Length > 0 && run.Status == "waiting" && run.Wait?.Kind == "intent" ? "real_stop_observed" : "not_observed",
                        "failed" => failed.Length > 0 && observer.ErrorReplySeenByModel ? "real_error_continuation_observed" : "not_observed",
                        _ => "inspect final narrative, tool receipts and persisted state"
                    }
                });
            }
            Write(Path.Combine(sampleRoot, "comparison.json"), candidateSample is not null ? null : new {
                sample.Id, sameSeedFiles = true,
                sameInitialTools = observations[0].InitialToolsHash is not null && observations[0].InitialToolsHash == observations[1].InitialToolsHash,
                sameInitialMessages = observations[0].InitialMessagesHash is not null && observations[0].InitialMessagesHash == observations[1].InitialMessagesHash,
                baselineToolsHash = observations[0].InitialToolsHash, candidateToolsHash = observations[1].InitialToolsHash,
                baselineMessagesHash = observations[0].InitialMessagesHash, candidateMessagesHash = observations[1].InitialMessagesHash,
                note = "If initial messages differ, inspect recorded requests before treating this as a controlled comparison. No blanket ID normalization is performed."
            });
        }
    }

    private sealed record Sample(string Id, string Input);

    private static AdventureDocument Adventure() => new()
    {
        Id = "prompt-recheck-synthetic", Version = "2026-10-29", Name = "新隔离主持语义样本", StartSceneId = "harbor",
        SourceText = "人工合成验收资料，不是旧v2状态或原冒险回放。", StyleProfile = "简洁中文",
        Scenes = [new() { Id = "harbor", Title = "林边小店", Summary = "岑远是这里的店主，站在柜台后。北侧灌木可供搜索。",
            Arrival = "Arden在店门旁。店主岑远在柜台后。北侧有一丛灌木。", ImagePrompt = "synthetic test scene",
            Exits = [new("watch-road", new() { All = ["trail-known"] })], Actions = [new() {
                Id = "find-trail", Kind = "script.action", Label = "仔细搜索北侧灌木寻找足迹", Target = "harbor",
                Success = new("灌木后有一条通往林中的足迹。", [new("fact", "trail-known")]) }] },
            new() { Id = "watch-road", Title = "林中小路", Summary = "小路伸向林中。", Arrival = "小路伸向林中。", ImagePrompt = "synthetic path" }],
        Npcs = [new("shopkeeper", "岑远", "harbor", "", "店主，姓名岑远；没有设定家庭、随身物件、出售物资或服务。", new(), new(), [])]
    };

    private sealed class Observer(string root, bool injectRace) : IHarnessModel
    {
        private IHarnessModel inner = null!;
        public Host Host { get; set; } = null!;
        public int Calls { get; private set; }
        public bool RaceInjected { get; private set; }
        public bool ErrorReplySeenByModel { get; private set; }
        public bool RefreshReplySeenByModel { get; private set; }
        public string? InitialToolsHash { get; private set; }
        public string? InitialMessagesHash { get; private set; }
        public bool Enabled => inner.Enabled;
        public IHarnessModel Bind(IHarnessModel model) { inner = model.Capture(); return this; }
        public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
        {
            int call = ++Calls;
            ErrorReplySeenByModel |= request.Messages.Any(m => m.Role == "tool" && m.Name == "token_move" && m.IsError == true);
            RefreshReplySeenByModel |= request.Messages.Any(m => m.Role == "tool" && m.Name == "token_move" && IsRefresh(m.Content));
            Write(Path.Combine(root, $"model-{call:D3}-request.json"), request);
            if (call == 1)
            {
                InitialToolsHash = JsonFiles.Hash(HarnessJson.Serialize(request.Tools));
                InitialMessagesHash = JsonFiles.Hash(HarnessJson.Serialize(request.Messages));
                Write(Path.Combine(root, "first-request-hashes.json"), new {
                    tools = InitialToolsHash, messages = InitialMessagesHash,
                    system = JsonFiles.Hash(request.System), request.MaxTokens, request.ContextPolicy });
            }
            var reply = await inner.Complete(request, campaignId, ct);
            // Do not replace arguments/replies/native signatures. Produce a real version race
            // only after the supplier has chosen an actual movement tool call.
            if (injectRace && !RaceInjected && reply.ToolCalls.FirstOrDefault(t => t.Name == "token_move") is { } move)
            {
                string mapId = move.Arguments.GetProperty("mapId").GetString()!;
                var maps = Host.App.Services.GetRequiredService<MapCatalog>();
                var map = maps.Get(campaignId, mapId, true);
                map = maps.ConfigureGrid(campaignId, mapId, new(Id(), map.Version, new() { Type = "square", CellPixels = 32, Distance = 5, Units = "feet" }));
                maps.Publish(campaignId, mapId, new(Id(), map.Version, true, true));
                RaceInjected = true;
            }
            Write(Path.Combine(root, $"model-{call:D3}-reply.json"), reply);
            return reply;
        }
    }

    private static (Dictionary<string, string?> Values, object Public) ReadProvider(string path)
    {
        // Read-only SQLite connection; never construct a store on the operator's live directory.
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.GetFullPath(path), Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        db.Open(); using var command = db.CreateCommand(); command.CommandText = "SELECT json FROM settings WHERE id=1";
        using var json = JsonDocument.Parse((string?)command.ExecuteScalar() ?? throw new InvalidDataException("No saved operator settings."));
        var main = json.RootElement.GetProperty("main");
        bool enabled = main.GetProperty("enabled").GetBoolean();
        string model = main.GetProperty("model").GetString()!, kind = main.GetProperty("provider").GetString()!;
        if (!enabled || kind != "gemini") throw new InvalidOperationException("This experiment requires the enabled current Gemini main profile.");
        string url = main.GetProperty("baseUrl").GetString()!;
        bool complete = main.TryGetProperty("endpointIsComplete", out var endpoint) && endpoint.GetBoolean();
        return (new() {
            ["HarnessAi:Endpoint"] = complete ? url : kind, ["HarnessAi:BaseUrl"] = complete ? "" : url,
            ["HarnessAi:Model"] = model, ["HarnessAi:ApiKey"] = main.GetProperty("apiKey").GetString(),
            ["HarnessAi:ThinkingLevel"] = "high", ["HarnessAi:IncludeThoughts"] = "true",
            ["TextAi:Model"] = "", ["TextAi:ApiKey"] = "", ["ImageAi:Model"] = "", ["ImageAi:ApiKey"] = ""
        }, new { enabled, provider = kind, model, baseUrl = url, thinking = "high", retryCount = 0, helper = "disabled for this main-only experiment" });
    }

    private static void Write(string path, object? value) => File.WriteAllText(path, JsonSerializer.Serialize(value, JsonFiles.Options));
    private static bool IsRefresh(string content)
    {
        using var json = JsonDocument.Parse(content);
        return json.RootElement.TryGetProperty("protocol", out var protocol) &&
            protocol.TryGetProperty("phase", out var phase) && phase.GetString() == "refresh_required" &&
            protocol.TryGetProperty("applied", out var applied) && applied.ValueKind == JsonValueKind.False;
    }
    private static void Copy(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (string file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        foreach (string directory in Directory.GetDirectories(source)) Copy(directory, Path.Combine(target, Path.GetFileName(directory)));
    }
}
