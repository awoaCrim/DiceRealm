using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class ModelRequestLogTests
{
    private sealed class Upstream(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => respond(request, ct);
    }
    private static ModelRequestLog Log()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { ["DataPath"] = Path.Combine(Path.GetTempPath(), "dicerealm-tests-model-log-" + Guid.NewGuid()) }).Build();
        return new ModelRequestLog(new DataDirectory(config));
    }
    private static HttpClient Client(ModelRequestLog log, Upstream upstream) => new(new ModelRequestLogHandler(log, "GeminiHarnessModel") { InnerHandler = upstream });

    public static async Task RecordsBodiesStatusAndMasksKeys()
    {
        var log = Log();
        using var ok = Client(log, new((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"candidates\":[]}") })));
        ModelRequestScope.Current = new("c1", "run-1", "这是哪里", 2);
        var response = await ok.PostAsync("https://proxy.example/v1beta/models/m:generateContent?key=secret-key", new StringContent("{\"contents\":[]}", Encoding.UTF8, "application/json"));
        Check.Equal("{\"candidates\":[]}", await response.Content.ReadAsStringAsync()); // the caller still reads the same body
        ModelRequestScope.Current = null;
        var entry = log.List(null, null, 10, false).Requests.Single();
        Check.True(entry.Finished); Check.Equal(200, entry.Status); Check.Equal("", entry.Error);
        Check.Equal("c1", entry.CampaignId); Check.Equal("run-1", entry.RunId); Check.Equal("这是哪里", entry.Input); Check.Equal(2, entry.Attempt);
        Check.True(entry.Url.EndsWith("?key=***") && !entry.Url.Contains("secret-key"));
        var detail = log.Get(entry.Id, null)!;
        Check.Equal("{\"contents\":[]}", detail.RequestBody); Check.Equal("{\"candidates\":[]}", detail.ResponseBody);
        Check.True(log.Get(entry.Id, "other-campaign") is null);
        Check.Equal(entry.Id, log.List("c1", null, 10, false, "run-1").Requests.Single().Id);
        Check.Equal(0, log.List("c1", null, 10, false, "other-run").Requests.Length);
        Check.Equal(0, log.List("other-campaign", null, 10, false, "run-1").Requests.Length);

        using var failed = Client(log, new((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadGateway) { Content = new StringContent("upstream error: do request failed") })));
        await failed.PostAsync("https://proxy.example/v1/chat/completions", new StringContent("{}"));
        using var timeout = Client(log, new((_, _) => throw new TaskCanceledException()));
        bool cancelled = false;
        try { await timeout.PostAsync("https://proxy.example/v1/chat/completions", new StringContent("{}")); }
        catch (TaskCanceledException) { cancelled = true; }
        Check.True(cancelled);
        var failures = log.List(null, null, 10, true).Requests;
        Check.Equal(2, failures.Length);
        Check.Equal("请求被取消（单次超时或本轮结束）", failures[0].Error); Check.True(failures[0].Status is null);
        Check.Equal(502, failures[1].Status); Check.Equal("upstream error: do request failed", log.Get(failures[1].Id, null)!.ResponseBody);
    }
    public static Task RecoveredRetriesLeaveAlertsButKeepAudit()
    {
        var log = Log();
        long Add(string run, string body, int attempt, int? status, string client = "GeminiHarnessModel", string campaign = "c1")
        {
            long id = log.Start(client, new(campaign, run, "input", attempt), "POST", "https://fixture/v1", body);
            log.Finish(id, status, status == 200 ? "" : "failed", 1, "{}"); return id;
        }
        var recovered = new List<long>(); var retained = new List<long>();
        foreach (int? status in new int?[] { null, 408, 429, 500, 502, 503 })
        {
            string run = Guid.NewGuid().ToString();
            recovered.Add(Add(run, "same", 1, status)); Add(run, "same", 2, 200);
        }
        retained.Add(Add("different", "first", 1, 500)); Add("different", "second", 2, 200);
        retained.Add(Add("reset", "same", 1, 500)); Add("reset", "other-slot", 1, 200); Add("reset", "same", 2, 200);
        retained.Add(Add("client", "same", 1, 500)); Add("client", "same", 2, 200, "OtherClient");
        retained.Add(Add("campaign", "same", 1, 500)); Add("campaign", "same", 2, 200, campaign: "c2");
        retained.Add(Add("old-run", "same", 1, 500)); Add("new-run", "same", 2, 200);
        retained.Add(Add("unauthorized", "same", 1, 401)); Add("unauthorized", "same", 2, 200);
        retained.Add(Add("", "same", 1, 500)); Add("", "same", 2, 200);
        retained.Add(Add("empty", "", 1, 500)); Add("empty", "", 2, 200);
        var alerts = log.List("c1", null, 100, true, unresolvedOnly: true).Requests.Select(r => r.Id).ToArray();
        Check.True(retained.All(alerts.Contains)); Check.True(!recovered.Any(alerts.Contains));
        var audit = log.List("c1", null, 100, true).Requests.Select(r => r.Id).ToArray();
        Check.True(recovered.All(audit.Contains) && retained.All(audit.Contains));
        Check.True(recovered.All(id => log.Get(id, "c1") is not null));
        return Task.CompletedTask;
    }
    public static async Task InFlightEntryVisibleAndRetentionBounded()
    {
        var log = Log();
        var release = new TaskCompletionSource<HttpResponseMessage>();
        using var slow = Client(log, new((_, _) => release.Task));
        var pending = slow.PostAsync("https://proxy.example/v1/chat/completions", new StringContent("{\"slow\":true}"));
        for (int i = 0; i < 100 && log.List(null, null, 1, false).Requests.Length == 0; i++) await Task.Delay(10);
        var running = log.List(null, null, 1, false).Requests.Single();
        Check.True(!running.Finished && running.DurationMs is null);
        release.SetResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") });
        await pending;
        Check.True(log.List(null, null, 1, false).Requests.Single().Finished);
        for (int i = 0; i < ModelRequestLog.Retained + 5; i++) log.Start("OpenAiText", new("c2", "", ""), "POST", "https://x/v1", "{}");
        var all = new List<ModelRequestSummary>(); long? before = null;
        do { var page = log.List(null, before, 100, false); all.AddRange(page.Requests); before = page.NextBefore; } while (before is not null);
        Check.Equal(ModelRequestLog.Retained, all.Count); Check.Equal(0, all.Count(e => e.CampaignId != "c2"));
        Check.Equal(all.Count, all.Select(e => e.Id).Distinct().Count());
    }
    public static async Task AdminGlobalAndHostCampaignBoundaries()
    {
        await using var host = await Host.Start();
        AccountTests.SeedAdminFixture(host);
        await AccountTests.Login(host);
        var created = await host.Http.PostAsJsonAsync("/api/v1/accounts/campaigns", new { name = "日志" });
        string campaign = JsonDocument.Parse(await created.Content.ReadAsStringAsync()).RootElement.GetProperty("campaignId").GetString()!;
        var log = host.App.Services.GetRequiredService<ModelRequestLog>();
        long own = log.Start("GeminiHarnessModel", new(campaign, "r", "看看四周"), "POST", "https://x/v1beta", "{\"own\":1}");
        long other = log.Start("GeminiHarnessModel", new(Guid.NewGuid().ToString(), "r", "别人的"), "POST", "https://x/v1beta", "{\"other\":1}");

        using var global = JsonDocument.Parse(await host.Http.GetStringAsync("/api/v1/accounts/model-requests"));
        Check.Equal(2, global.RootElement.GetProperty("requests").GetArrayLength());
        using var scoped = JsonDocument.Parse(await host.Http.GetStringAsync($"/api/v1/campaigns/{campaign}/model-requests"));
        var only = scoped.RootElement.GetProperty("requests");
        Check.Equal(1, only.GetArrayLength()); Check.Equal(own, only[0].GetProperty("id").GetInt64());
        Check.True(!only[0].TryGetProperty("requestBody", out _)); // lists never carry bodies
        long anotherRun = log.Start("GeminiHarnessModel", new(campaign, "other-run", "看看四周"), "POST", "https://x/v1beta", "{}");
        using var byRun = JsonDocument.Parse(await host.Http.GetStringAsync($"/api/v1/campaigns/{campaign}/model-requests?runId=r"));
        Check.Equal(1, byRun.RootElement.GetProperty("requests").GetArrayLength());
        Check.Equal(own, byRun.RootElement.GetProperty("requests")[0].GetProperty("id").GetInt64());
        using var paged = JsonDocument.Parse(await host.Http.GetStringAsync($"/api/v1/campaigns/{campaign}/model-requests?runId=r&before={own}"));
        Check.Equal(0, paged.RootElement.GetProperty("requests").GetArrayLength());
        using var detail = JsonDocument.Parse(await host.Http.GetStringAsync($"/api/v1/campaigns/{campaign}/model-requests/{own}"));
        Check.Equal("{\"own\":1}", detail.RootElement.GetProperty("requestBody").GetString());
        Check.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync($"/api/v1/campaigns/{campaign}/model-requests/{other}")).StatusCode);

        log.Finish(own, 503, "HTTP 503", 1, "busy");
        long retry = log.Start("GeminiHarnessModel", new(campaign, "r", "看看四周", 2), "POST", "https://x/v1beta", "{\"own\":1}");
        log.Finish(retry, 200, "", 1, "{}");
        using var recovered = JsonDocument.Parse(await host.Http.GetStringAsync($"/api/v1/campaigns/{campaign}/model-requests?failed=true&unresolved=true"));
        Check.Equal(0, recovered.RootElement.GetProperty("requests").GetArrayLength());
        using var audit = JsonDocument.Parse(await host.Http.GetStringAsync($"/api/v1/campaigns/{campaign}/model-requests?failed=true"));
        Check.Equal(1, audit.RootElement.GetProperty("requests").GetArrayLength());

        const string privateText = "PRIVATE_REASONING_SENTINEL";
        foreach (var bodies in new[]
        {
            (Request: "{\"messages\":[{\"role\":\"assistant\",\"content\":\"public input\",\"reasoning_content\":\"PRIVATE_REASONING_SENTINEL\"}],\"model\":\"fixture\"}",
             Response: "{\"choices\":[{\"message\":{\"content\":\"public reply\",\"reasoning_content\":\"PRIVATE_REASONING_SENTINEL\"}}]}"),
            (Request: "{\"contents\":[{\"role\":\"model\",\"parts\":[{\"thought\":true,\"text\":\"PRIVATE_REASONING_SENTINEL\"},{\"text\":\"public input\",\"thoughtSignature\":\"PRIVATE_REASONING_SENTINEL\"}]}]}",
             Response: "{\"candidates\":[{\"content\":{\"parts\":[{\"thought\":true,\"text\":\"PRIVATE_REASONING_SENTINEL\"},{\"text\":\"public reply\",\"thoughtSignature\":\"PRIVATE_REASONING_SENTINEL\"},{\"functionCall\":{\"name\":\"world_record\",\"args\":{\"text\":\"saved\"}}}]}}]}")
        })
        {
            long safeId = log.Start("fixture", new(campaign, "r", "public input"), "POST", "https://fixture/v1", bodies.Request);
            log.Finish(safeId, 200, "", 1, bodies.Response);
            string projected = await host.Http.GetStringAsync($"/api/v1/campaigns/{campaign}/model-requests/{safeId}?publicOnly=true");
            Check.True(projected.Contains("public reply") && projected.Contains("public input"));
            Check.True(!projected.Contains(privateText) && !projected.Contains("thoughtSignature") && !projected.Contains("reasoning_content"));
            Check.Equal(bodies.Response, log.Get(safeId, campaign)!.ResponseBody); // the diagnostic evidence is not rewritten
        }
        var user = await host.Http.PostAsJsonAsync("/api/v1/accounts/users", new CreateAccountRequest("logviewer", "logviewer-fixture"));
        Check.Equal(HttpStatusCode.OK, user.StatusCode);
        await AccountTests.Login(host, "logviewer", "logviewer-fixture");
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync("/api/v1/accounts/model-requests")).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{campaign}/model-requests?runId=r")).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{campaign}/model-requests/{own}")).StatusCode);
        host.Http.DefaultRequestHeaders.Authorization = null;
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/model-requests")).StatusCode);
    }
}
