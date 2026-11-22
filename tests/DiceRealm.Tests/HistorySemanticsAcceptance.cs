using System.Net.Http.Json;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Explicit opt-in paid experiment. Never add to the automatic regression list.
internal static class HistorySemanticsAcceptance
{
    private const string Question = "回顾前情，私密内容仅给我。";
    private const string Sentinel = "ACTOR_ONLY_青鹭七弦";

    public static async Task Run(string output, string settingsDatabase, string promptPath)
    {
        output = Path.GetFullPath(output);
        if (Directory.Exists(output)) throw new InvalidOperationException("Use a fresh output directory; unknown calls must not be replayed.");
        string prompt = File.ReadAllText(promptPath);
        var settings = ReadProviders(settingsDatabase);
        Directory.CreateDirectory(output);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(output, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Write(output, "experiment.json", new { kind = "new-synthetic-Gemini-history-semantics", oldStepReplay = false,
            fixtureGroups = 65, preparation = "explicit QA call to existing HistoryManager.Prepare; no automatic token-threshold claim",
            settings.Public, promptSha256 = JsonFiles.Hash(prompt), question = Question, created = DateTimeOffset.UtcNow,
            verdict = "unreviewed; absence is not contradiction; review helper preservation and main omissions separately" });
        var observer = new Observer(output);
        await using var host = await Host.Start(Path.Combine(output, "data"), configure: builder =>
        {
            foreach (var setting in settings.Values) builder.Configuration[setting.Key] = setting.Value;
            builder.Configuration["Harness:Enabled"] = "true";
            GameSaveTests.ConfigurePi(builder);
            builder.Services.AddSingleton<IHarnessModel>(services => observer.Bind(new ConfiguredHarnessModel(
                services.GetRequiredService<AiConfigurationStore>(), services.GetRequiredService<IHttpClientFactory>(),
                services.GetRequiredService<ProviderBudget>(), services.GetRequiredService<Microsoft.Extensions.Logging.ILoggerFactory>())));
        });
        using var response = await host.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest(
            "新合成历史语义验收（非正式历史）", "Arden", TestContent.Document,
            new("history-recheck-synthetic", 1, prompt), [], Build: FullCreationTests.Named("Arden")));
        response.EnsureSuccessStatusCode();
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Write(output, "private-connection.json", new { campaignId = owner.Snapshot.Id, accessToken = owner.AccessToken,
            dataPath = host.Root, baseUrlDuringExperiment = host.Http.BaseAddress?.ToString(),
            note = "Host stops on completion. Restart this isolated data with an explicit port for later read-only QA Player inspection." });
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(Path.Combine(output, "private-connection.json"), UnixFileMode.UserRead | UnixFileMode.UserWrite);
        await Seed(host, owner);
        var before = (await host.Get(owner.Snapshot.Id))!;
        Write(output, "before.json", before);
        var game = host.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(before.Id, owner.AccessToken, default);
        var context = await game.ValidateHarnessStart(before.Id, owner.AccessToken, before.Version, default, Question);
        // A QA preparation identity only: never stored as a real model run or assigned fake usage.
        var preparation = new HarnessRun { Id = Id(), IntentId = Id(), CampaignId = before.Id, ActorId = auth.ActorId,
            Fingerprint = "synthetic-QA-history-preparation", Input = Question, Profile = context.Profile,
            Limits = new(), Version = before.Version, TimelineId = before.TimelineId,
            ToolContractVersion = HarnessTools.CurrentVersion, RulesCatalogVersion = context.RulesCatalogVersion };
        var capture = await InvokeInternal<Task<HarnessHistoryCapture>>(game, "ReadHarnessHistory", preparation, owner.AccessToken, CancellationToken.None, null);
        Write(output, "authoritative-capture-before.json", capture);
        var selection = HarnessHistoryContexts.Build(before.Version, auth.ActorId, capture, Question, [],
            toolContractVersion: preparation.ToolContractVersion);
        var manager = host.App.Services.GetRequiredService<HarnessHistoryManager>();
        foreach (var audience in selection.Audiences)
        {
            var published = await InvokeInternal<Task<HarnessHistorySummary?>>(manager, "Prepare", preparation, owner.AccessToken, capture, selection, audience.Audience, null);
            if (published is null) throw new InvalidOperationException("Real helper did not publish: inspect isolated history_work and usage before any new attempt.");
            Write(output, "publication-" + (audience.Audience == "public" ? "public" : "actor") + ".json", published);
        }
        var available = await InvokeInternal<Task<HarnessHistoryCapture>>(game, "ReadHarnessHistory", preparation, owner.AccessToken, CancellationToken.None, null);
        Write(output, "authoritative-capture-published.json", available);
        Check.True(available.Published.Any(s => s.Audience == "public"));
        Check.True(available.Published.Any(s => s.Audience == auth.ActorId));
        Check.True(!HarnessJson.Serialize(available.Published.Where(s => s.Audience == "public")).Contains(Sentinel), "Actor-only sentinel reached public summary.");
        Check.True(!HarnessJson.Serialize(available.Sources.Where(s => s.Audience == "public")).Contains(Sentinel));
        foreach (var summary in available.Published)
            Check.True(summary.Sources.All(source => available.Sources.Any(f => f.Source == source)), "Published sources must remain exactly resolvable.");
        var started = await Start(host, before, Question);
        var settled = await Settled(host, before.Id, started.Id, 48000);
        var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(before.Id, auth.ActorId, started.Id)!;
        Write(output, "run.json", saved);
        Write(output, "after.json", await host.Get(before.Id));
        Write(output, "owner-authorized-events-page.json", await host.Http.GetFromJsonAsync<JsonElement>($"/api/v1/campaigns/{before.Id}/events"));
        var slots = saved.Steps.Where(s => s.Kind == "model").Select(s => new { s.Id, s.Status, s.ContextPlan,
            history = s.ExecutionFrame?.History }).ToArray();
        Write(output, "consumption.json", new { settled.Status, settled.Text, settled.Error, slots,
            selectedPublished = slots.SelectMany(s => s.history?.Audiences ?? []).SelectMany(a => a.Summaries)
                .Select(s => new { s.Id, s.Version, s.Publication, s.Tier, s.Sources }).ToArray(),
            semanticVerdict = "manual review required; generic question preserved without targeted fact hints" });
        Check.True(slots.FirstOrDefault()?.history?.Audiences.SelectMany(a => a.Summaries).Any() == true,
            "Main model's real first slot must consume published history.");
        Check.True(settled.Status == "completed", "Real main run did not complete; inspect retained evidence.");
    }

    private static Task Seed(Host host, CreatedCampaign owner) => host.App.Services.GetRequiredService<CampaignStore>()
        .Access(owner.Snapshot.Id, owner.AccessToken, true, campaign =>
        {
            for (int i = 1; i <= 65; i++)
            {
                string text = i switch
                {
                    4 => "岑野与伊岚相互仍有戒心；他们尚未互相信任。",
                    13 => "黎桑只愿继续商量，不是无条件盟友，也没有接受委托。",
                    22 => "方榆不信仓库传闻；传闻仍未获证实。",
                    31 => "莫砚没有承诺给钥匙；不能把他沉默记成答应。",
                    40 => "顾舟说：只有先修好桥、再送回药箱，我才愿意考虑带路；现在尚未接受。",
                    49 => "原先约定五月十二日在南码头见面。随后更正为五月十四日；地点仍为南码头，没有改变。",
                    58 => "阿荷答应借灯，但须返程当晚归还；她没有允许转借他人。",
                    _ => $"第{i}组已结束合成交流：众人在旧驿站核对第{i}张空白登记纸，未提出新的承诺或改变关系。"
                };
                text = $"[SYNTHETIC TEST FIXTURE {i:D2}/65，非正式游戏历史] " + text;
                string input = $"[SYNTHETIC TEST FIXTURE {i:D2}/65] 记录本次已结束交谈。";
                int version = campaign.Version + 1;
                var intent = new PendingIntent { Id = Id(), ActorId = campaign.ActingActorId, Text = input,
                    RootSequence = version, Version = version, Source = "harness", Published = true, Status = "completed",
                    Result = new("narrated", "adventure.narrate", text, null, []), Narrative = text, NarrativeSource = "harness" };
                campaign.PendingIntents.Add(intent);
                campaign.Events.Add(new(Id(), ++campaign.Version, "adventure.narrate", text, text, "harness", DateTimeOffset.UtcNow,
                    intent.Result with { IntentId = intent.Id }, campaign.ActingActorId,
                    Origin: new(input, "交谈", "natural", "", "同行者", "synthetic-closed-old-scene", "synthetic-closed-old-scene", []),
                    PrivateMessages: i == 10 ? [new(Id(), [campaign.ActingActorId],
                        "[SYNTHETIC ACTOR-ONLY FIXTURE] 私人识别词是" + Sentinel + "；仅Arden知晓，不得公开，也不得当作NPC已知。")] : null));
            }
            return Task.FromResult(true);
        });

    private sealed class Observer(string output) : IHarnessModel
    {
        private IHarnessModel inner = null!;
        private int calls;
        public bool Enabled => inner.Enabled;
        public IHarnessModel Bind(IHarnessModel model) { inner = model.Capture(); return this; }
        public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
        {
            int call = Interlocked.Increment(ref calls);
            Write(output, $"main-{call:D3}-request.json", request);
            var reply = await inner.Complete(request, campaignId, ct);
            Write(output, $"main-{call:D3}-reply.json", reply);
            return reply;
        }
    }

    private static (Dictionary<string, string?> Values, object Public) ReadProviders(string path)
    {
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.GetFullPath(path),
            Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        db.Open(); using var command = db.CreateCommand(); command.CommandText = "SELECT json FROM settings WHERE id=1";
        using var json = JsonDocument.Parse((string?)command.ExecuteScalar() ?? throw new InvalidDataException("No saved settings."));
        var values = new Dictionary<string, string?>();
        var profiles = new List<object>();
        foreach (var pair in new[] { (Name: "main", Prefix: "HarnessAi"), (Name: "helper", Prefix: "TextAi") })
        {
            var profile = json.RootElement.GetProperty(pair.Name);
            string model = profile.GetProperty("model").GetString()!, provider = profile.GetProperty("provider").GetString()!;
            if (!profile.GetProperty("enabled").GetBoolean() || provider != "gemini" || model != "gemini-3.8-flash-high")
                throw new InvalidOperationException("Expected current enabled Gemini gemini-3.8-flash-high main and helper; do not silently change provider.");
            string url = profile.GetProperty("baseUrl").GetString()!;
            bool complete = profile.TryGetProperty("endpointIsComplete", out var endpoint) && endpoint.GetBoolean();
            string key = profile.GetProperty("apiKey").GetString()!;
            if (string.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("Configured profile has no key.");
            values[pair.Prefix + ":Endpoint"] = complete ? url : provider;
            values[pair.Prefix + ":BaseUrl"] = complete ? "" : url;
            values[pair.Prefix + ":Model"] = model; values[pair.Prefix + ":ApiKey"] = key;
            values[pair.Prefix + ":RetryCount"] = "3";
            profiles.Add(new { role = pair.Name, provider, model, baseUrl = url, endpointIsComplete = complete });
        }
        values["ImageAi:Model"] = ""; values["ImageAi:ApiKey"] = "";
        return (values, profiles);
    }
    // Same test-only reflection boundary as HarnessHistorySummaryTests. Invoke the actual
    // owner so authorization, issued markers, provider calls and publication stay unchanged.
    private static T InvokeInternal<T>(object owner, string name, params object?[] arguments)
    {
        try
        {
            return (T)owner.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(owner, arguments)!;
        }
        catch (TargetInvocationException error) when (error.InnerException is { } inner)
        {
            ExceptionDispatchInfo.Capture(inner).Throw();
            throw;
        }
    }

    private static void Write(string root, string name, object? value) =>
        File.WriteAllText(Path.Combine(root, name), JsonSerializer.Serialize(value, JsonFiles.Options));
}
