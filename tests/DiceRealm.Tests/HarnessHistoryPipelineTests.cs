using System.Net;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessHistoryPipelineTests
{
    private sealed class Wire(bool fail = false, bool pause = false, int mainSteps = 1, bool missingUsage = false) : HttpMessageHandler
    {
        public int MainCalls, HelperCalls;
        public readonly List<JsonElement> MainBodies = [], HelperBodies = [];
        public readonly TaskCompletionSource HelperStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource ReleaseHelper = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly object gate = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Check.Equal(HttpMethod.Post, request.Method);
            Check.True(request.RequestUri!.AbsolutePath.EndsWith(":generateContent", StringComparison.Ordinal));
            bool helper = request.RequestUri.AbsolutePath.Contains("history-helper", StringComparison.Ordinal);
            using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            var body = document.RootElement;
            if (helper)
            {
                Interlocked.Increment(ref HelperCalls);
                lock (gate) HelperBodies.Add(body.Clone());
                Check.True(!body.TryGetProperty("tools", out _));
                Check.True(!body.GetProperty("generationConfig").TryGetProperty("maxOutputTokens", out _));
                var sources = Sources(body);
                Check.Equal(1, sources.Select(s => s.Audience).Distinct().Count());
                Check.True(sources.All(s => s.ClosedForSummary));
                string raw = HarnessJson.Serialize(sources);
                Check.True(!raw.Contains("PEER_SECRET") && !raw.Contains("HOST_ONLY") && !raw.Contains("execution_state") && !raw.Contains("ADMIN_SETUP"));
                Check.True(body.GetProperty("systemInstruction").GetProperty("parts")[0].GetProperty("text").GetString()!.Contains("截至该段历史"));
                if (sources[0].Audience == "public") Check.True(!raw.Contains("OWN_SECRET"));
                HelperStarted.TrySetResult();
                if (pause) await ReleaseHelper.Task.WaitAsync(ct);
                if (fail) return new(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("unavailable") };
                string summary = sources[0].Audience == "public" ? "某人声称愿意考虑，但仅在修桥后，尚未接受委托。" : "本人知道自己的暗号；未向别人公开。";
                string text = HarnessJson.Serialize(new HarnessHistoryText(summary, summary));
                if (sources[0].Audience != "public") text = "```json\r\n" + text + "\r\n```";
                return Json(new { candidates = new[] { new { content = new { role = "model", parts = new object[] {
                    new { text = "DO_NOT_RETAIN_THOUGHT", thought = true }, new { text } } }, finishReason = "STOP" } },
                    usageMetadata = new { promptTokenCount = 300, candidatesTokenCount = 40, thoughtsTokenCount = 10 } });
            }
            int n = Interlocked.Increment(ref MainCalls);
            lock (gate) MainBodies.Add(body.Clone());
            Check.True(!HarnessJson.Serialize(History(body)).Contains("ADMIN_SETUP"));
            return Json(new { candidates = new[] { new { content = new { role = "model", parts = new[] { new {
                functionCall = new { name = "world_record", id = "history-final-" + n, args = new NarrativeHarnessArgs("船索已按原意检查，先前仍未接受委托。", [], Complete: n >= mainSteps) },
                thoughtSignature = Convert.ToBase64String(Encoding.UTF8.GetBytes("NATIVE-HISTORY-TEST")) } } }, finishReason = "STOP" } },
                usageMetadata = missingUsage ? null : new { promptTokenCount = 1000000 + n * 100, candidatesTokenCount = 40 } });
        }
        private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK)
        { Content = new StringContent(HarnessJson.Serialize(body), Encoding.UTF8, "application/json") };
    }
    private static HarnessHistoryFragment[] Sources(JsonElement body)
    {
        using var data = JsonDocument.Parse(body.GetProperty("contents")[0].GetProperty("parts")[0].GetProperty("text").GetString()!);
        return HarnessJson.Read<HarnessHistoryFragment[]>(data.RootElement.GetProperty("sources"));
    }
    private static HarnessHistoryContext History(JsonElement body)
    {
        foreach (var content in body.GetProperty("contents").EnumerateArray())
            foreach (var part in content.GetProperty("parts").EnumerateArray())
                if (part.TryGetProperty("text", out var text) && text.GetString() is { } value && value.StartsWith('{'))
                {
                    using var data = JsonDocument.Parse(value);
                    if (data.RootElement.TryGetProperty("memory", out var history)) return HarnessJson.Read<HarnessHistoryContext>(history);
                }
        throw new Exception("Missing real wire history");
    }
    private static Action<Microsoft.AspNetCore.Builder.WebApplicationBuilder> ConfigureWire(Wire wire, bool helper = true) => Configure(
        new Model((_, _) => throw new Exception("Must use real Gemini adapter")), extra: b =>
        {
            GameSaveTests.ConfigurePi(b);
            b.Configuration["HarnessAi:Endpoint"] = "gemini"; b.Configuration["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/v1beta";
            b.Configuration["HarnessAi:ApiKey"] = "fake-history-key"; b.Configuration["HarnessAi:Model"] = "history-main";
            b.Configuration["HarnessAi:RetryCount"] = "0";
            b.Configuration["TextAi:Endpoint"] = "gemini"; b.Configuration["TextAi:BaseUrl"] = "http://127.0.0.1:1/v1beta";
            b.Configuration["TextAi:ApiKey"] = helper ? "fake-helper-key" : ""; b.Configuration["TextAi:Model"] = helper ? "history-helper" : "";
            b.Services.AddSingleton<IHarnessModel>(sp => new GeminiHarnessModel(new HttpClient(wire, disposeHandler: false), b.Configuration,
                sp.GetRequiredService<ProviderBudget>()));
            b.Services.AddHttpClient(nameof(ConfiguredHarnessHistorian)).ConfigurePrimaryHttpMessageHandler(() => wire);
        });
    private static Task Seed(Host h, CreatedCampaign owner, bool boundary, bool privatePart = false) =>
        h.App.Services.GetRequiredService<CampaignStore>().Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
        {
            void Add(string input, string text, string scene, string secret = "")
            {
                int root = c.Version + 1;
                var intent = new PendingIntent { Id = Id(), ActorId = c.ActingActorId, Text = input, RootSequence = root,
                    Version = root, Source = "harness", Published = true, Status = "completed",
                    Result = new("narrated", "adventure.narrate", text, null, []), Narrative = text, NarrativeSource = "harness" };
                c.PendingIntents.Add(intent);
                c.Events.Add(new(Id(), ++c.Version, "adventure.narrate", text, text, "harness", DateTimeOffset.UtcNow,
                    intent.Result with { IntentId = intent.Id }, c.ActingActorId,
                    Origin: new(input, "交谈", "natural", "", "同行者", scene, scene, []),
                    PrivateMessages: secret.Length == 0 ? null : [new(Id(), [c.ActingActorId], secret)]));
            }
            c.Events.Add(new(Id(), ++c.Version, "party.join", "ADMIN_SETUP 当时提交角色等待审核", "", "system", DateTimeOffset.UtcNow,
                new("resolved", "party.join", "ADMIN_SETUP 当时提交角色等待审核", null, []), c.ActingActorId));
            Add("ARCHIVE_ELIGIBLE 昔日来访", "ARCHIVE_ELIGIBLE 某人说只有修桥才考虑带路，并未接受委托。", boundary ? "old-scene" : c.SceneId,
                privatePart ? "ARCHIVE_ELIGIBLE OWN_SECRET 本人暗号未公开。" : "");
            Add("处理船索", "RECENT_QUOTE 船夫没有答应，必须先修好船。", c.SceneId);
            return Task.FromResult(true);
        });
    private static async Task<HarnessRunView> Run(Host h, CreatedCampaign owner)
    {
        var input = new HarnessInputRequest(Id(), (await h.Get(owner.Snapshot.Id))!.Version, "继续系紧船索");
        var run = await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", input);
        return await Settled(h, owner.Snapshot.Id, run.Id, 3000);
    }
    private static async Task AwaitWork(Host h, CreatedCampaign owner, string status, int count = 1)
    {
        string dbPath = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite");
        for (int i = 0; i < 200; i++)
        {
            using var db = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + dbPath + ";Pooling=False"); db.Open();
            using var cmd = db.CreateCommand(); cmd.CommandText = "PRAGMA user_version";
            if (Convert.ToInt32(cmd.ExecuteScalar()) == 3)
            {
                cmd.CommandText = "SELECT count(*) FROM history_work WHERE json_extract(json,'$.status')=$status";
                cmd.Parameters.AddWithValue("$status", status);
                if ((long)cmd.ExecuteScalar()! >= count) return;
            }
            await Task.Delay(50);
        }
        throw new Exception("History work did not reach " + status);
    }

    public static async Task PublicationAndFailureKeepOriginals()
    {
        foreach (string mode in new[] { "success", "failed", "missing-helper" })
        {
            using var wire = new Wire(fail: mode == "failed");
            await using var h = await Host.Start(configure: ConfigureWire(wire, helper: mode != "missing-helper"));
            var owner = await Create(h);
            await Seed(h, owner, boundary: true, privatePart: mode == "success");
            JsonElement? beforeWork = mode == "failed" ? await GameSaveTests.Save(h, owner.Snapshot.Id, "摘要外发之前") : null;
            var run = await Run(h, owner);
            Check.True(run.Status == "completed", mode + ":" + run.Status + "/" + run.Error);
            var history = History(wire.MainBodies[0]);
            Check.True(history.Audiences.All(a => a.Summaries.Length == 0));
            Check.True(history.Audiences.SelectMany(a => a.Raw).Any(f => f.Text.Contains("ARCHIVE_ELIGIBLE")));
            Check.True(history.Audiences.SelectMany(a => a.Raw).Any(f => f.Text.Contains("RECENT_QUOTE")));
            if (mode == "success")
            {
                await AwaitWork(h, owner, "published", 2); Check.Equal(2, wire.HelperCalls);
                Check.True(wire.HelperBodies.SelectMany(Sources).All(s => !history.ProtectedOriginals.Contains(s.Source)));
                var second = await Run(h, owner); Check.Equal("completed", second.Status);
                var summarized = History(wire.MainBodies[^1]);
                Check.True(summarized.Audiences.All(a => a.Summaries.Length > 0));
                Check.True(!summarized.Audiences.SelectMany(a => a.Raw).Any(f => f.Text.Contains("ARCHIVE_ELIGIBLE")));
                Check.Equal(2, wire.HelperCalls);
                var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
                Check.True(!HarnessJson.Serialize(saved).Contains("DO_NOT_RETAIN_THOUGHT"));
            }
            else if (mode == "failed")
            {
                await AwaitWork(h, owner, "failed"); Check.Equal(4, wire.HelperCalls);
                Check.Equal(1, wire.HelperBodies.Select(body => body.GetRawText()).Distinct().Count());
                Check.Equal("completed", (await Run(h, owner)).Status); Check.Equal(4, wire.HelperCalls);
                string saveId = beforeWork!.Value.GetProperty("saveId").GetString()!;
                await GameSaveTests.Load(h, owner.Snapshot.Id, await GameSaveTests.Entry(h, owner.Snapshot.Id, saveId));
                Check.Equal("completed", (await Run(h, owner)).Status);
                Check.Equal(4, wire.HelperCalls); // restoring schema2 cannot resend an issued helper range
                Check.True(History(wire.MainBodies[^1]).Audiences.SelectMany(a => a.Raw).Any(f => f.Text.Contains("ARCHIVE_ELIGIBLE")));
            }
            else Check.Equal(0, wire.HelperCalls);
        }
    }

    public static async Task ActualUsageGrowthAndMissingUsage()
    {
        foreach (bool missing in new[] { false, true })
        foreach (bool separateRuns in new[] { false, true })
        {
            using var wire = new Wire(mainSteps: separateRuns ? 1 : 3, missingUsage: missing);
            await using var h = await Host.Start(configure: ConfigureWire(wire));
            var owner = await Create(h); await Seed(h, owner, boundary: false);
            var savedRuns = new List<HarnessRun>();
            for (int i = 0; i < (separateRuns ? 3 : 1); i++)
            {
                var completed = await Run(h, owner); Check.Equal("completed", completed.Status);
                savedRuns.Add(h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, completed.Id)!);
            }
            var plans = savedRuns.SelectMany(r => r.Steps).Where(s => s.Kind == "model").Select(s => s.ContextPlan!).ToArray();
            int tokens = savedRuns.Sum(r => r.Tokens);
            Check.Equal(3, plans.Length); Check.True(plans.All(p => p.InputBudget is null && p.OmittedExchanges == 0));
            if (missing)
            {
                Check.True(plans.All(p => p.ReportedInputTokens is null)); Check.Equal(0, tokens); Check.Equal(0, wire.HelperCalls);
            }
            else
            {
                Check.Equal(1000100, plans[0].ReportedInputTokens!.Value); Check.Equal(1000300, plans[2].ReportedInputTokens!.Value);
                Check.True(tokens > 3000000); await AwaitWork(h, owner, "published"); Check.Equal(1, wire.HelperCalls);
            }
        }
    }

    public static async Task BackgroundPublicationOnlyChangesLaterSlots()
    {
        using var wire = new Wire(pause: true);
        await using var h = await Host.Start(configure: ConfigureWire(wire));
        var owner = await Create(h); await Seed(h, owner, boundary: true);
        var first = await Run(h, owner); Check.True(first.Status == "completed", first.Error);
        await wire.HelperStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Check.True(!wire.ReleaseHelper.Task.IsCompleted);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, first.Id)!;
        string frozen = HarnessJson.Serialize(saved.Steps.First(s => s.Kind == "model").ExecutionFrame!.History);
        Check.True(saved.Steps.First(s => s.Kind == "model").ExecutionFrame!.History!.Audiences.All(a => a.Summaries.Length == 0));
        wire.ReleaseHelper.TrySetResult(); await AwaitWork(h, owner, "published");
        var second = await Run(h, owner); Check.True(second.Status == "completed", second.Error);
        var baseline = History(wire.MainBodies[1]).Audiences.SelectMany(a => a.Summaries).Single();
        var reread = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, first.Id)!;
        Check.Equal(frozen, HarnessJson.Serialize(reread.Steps.First(s => s.Kind == "model").ExecutionFrame!.History));
        Check.Equal(1, wire.HelperCalls);
        await Seed(h, owner, boundary: true);
        Check.Equal("completed", (await Run(h, owner)).Status); await AwaitWork(h, owner, "published", 2);
        Check.Equal(2, wire.HelperCalls);
        Check.True(!Sources(wire.HelperBodies[1]).Any(s => baseline.Sources.Contains(s.Source)));
        Check.Equal("completed", (await Run(h, owner)).Status);
        var summaries = History(wire.MainBodies[^1]).Audiences.SelectMany(a => a.Summaries).ToArray();
        Check.Equal(2, summaries.Length);
        Check.Equal(baseline.Text, summaries.Single(s => s.Id == baseline.Id).Text);
        // Further completed groups may become eligible as the history grows; each
        // incremental request must be disjoint, never a rewrite of the baseline.
        await AwaitWork(h, owner, "published", wire.HelperCalls);
        var issued = wire.HelperBodies.SelectMany(Sources).Select(s => s.Source).ToArray();
        Check.Equal(issued.Length, issued.Distinct().Count());
    }
}
