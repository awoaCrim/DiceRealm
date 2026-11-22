using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessBudgetTests
{
    private const string FakeKey = "private-budget-test-key-never-live";
    private const string Endpoint = "http://127.0.0.1:1/v1/chat/completions";
    private sealed class Wire(Func<int, HttpResponseMessage> respond) : HttpMessageHandler
    {
        private int calls;
        public int Calls => calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(respond(Interlocked.Increment(ref calls)));
    }
    private static HttpResponseMessage Response(HarnessModelReply reply) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(JsonSerializer.Serialize(new
        {
            choices = new[] { new { finish_reason = reply.ToolCalls.Length == 0 ? "stop" : "tool_calls", message = new
            {
                role = "assistant", content = reply.Text,
                tool_calls = reply.ToolCalls.Select(t => new { id = t.Id, type = "function", function = new { name = t.Name, arguments = t.Arguments.GetRawText() } })
            } } },
            usage = new { prompt_tokens = reply.InputTokens, completion_tokens = reply.OutputTokens }
        }), Encoding.UTF8, "application/json")
    };
    private static Action<WebApplicationBuilder> Provider(HttpClient http, int limit = 10, string endpoint = Endpoint) => b =>
    {
        b.Configuration["Harness:Enabled"] = "true";
        b.Configuration["HarnessAi:RetryCount"] = "0"; // old unknown/rejection compatibility when retries are disabled
        b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
        b.Configuration["HarnessAi:Model"] = "fake-budget-test";
        b.Configuration["HarnessAi:ApiKey"] = FakeKey;
        b.Configuration["HarnessAi:Endpoint"] = endpoint;
        b.Configuration["ProviderLimits:TextTotal"] = limit.ToString(System.Globalization.CultureInfo.InvariantCulture);
        b.Services.AddSingleton<IHarnessModel>(sp => new OpenAiHarnessModel(http, b.Configuration, sp.GetRequiredService<ProviderBudget>()));
    };
    private static HarnessRun Stored(Host h, CreatedCampaign owner, string runId) => h.App.Services.GetRequiredService<HarnessRunStore>()
        .Read(owner.Snapshot.Id, owner.Snapshot.Party!.SelfActorId, runId)!;
    private static int Usage(Host h, string campaign) => h.App.Services.GetRequiredService<ProviderBudget>().Read("text", campaign, true).Total;
    private static async Task NotResumable(Host h, string campaign, string runId, int version)
    {
        using var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/harness/runs/{runId}/resume", new HarnessResumeRequest(Id(), version));
        Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Check.Equal("harness_not_resumable", json.RootElement.GetProperty("code").GetString());
    }

    public static Task RealQuotaRejectedWithoutSending() => QuotaCase(0);
    public static Task RealQuotaAfterCommitIsNotUnknown() => QuotaCase(1);
    private static async Task QuotaCase(int allowance)
    {
        using var wire = new Wire(i => Response(allowance == 1 && i == 1
            ? Tool("world_record", new NarrativeHarnessArgs("预算中断前已提交的记录。", [new("", "clue", "预算保留线索", "非机械隔离测试", "known", "harbor")], Complete: false))
            : Text("新的明确输入正常完成。")));
        using var http = new HttpClient(wire) { Timeout = Timeout.InfiniteTimeSpan };
        string root, originalBytes; CreatedCampaign owner; HarnessRunView run; HarnessInputRequest request;
        await using (var h = await Host.Start(configure: Provider(http, allowance)))
        {
            root = h.Root; owner = await Create(h); string id = owner.Snapshot.Id;
            request = new(Id(), owner.Snapshot.Version, "确认外发前预算边界");
            run = await Post<HarnessRunView>(h, id, "harness/runs", request);
            run = await Settled(h, id, run.Id, maximumPolls: 3000);
            Check.Equal("failed", run.Status); Check.Equal("harness_model_quota_exceeded", run.Error);
            Check.Equal(allowance + 1, run.ModelAttempts); Check.Equal(allowance, run.ToolSteps);
            Check.Equal(allowance, wire.Calls); Check.Equal(allowance, Usage(h, id));
            var saved = Stored(h, owner, run.Id);
            Check.Equal("started", saved.Steps.Last().Status); Check.True(saved.Steps.Last().Result is null);
            Check.True(saved.Steps.SkipLast(1).All(s => s.Status == "done"));
            var snapshot = (await h.Get(id))!;
            Check.Equal(owner.Snapshot.Version + allowance, snapshot.Version);
            Check.Equal(allowance, snapshot.WorldMemory!.Count(m => m.Name == "预算保留线索"));
            var replay = await Post<HarnessRunView>(h, id, "harness/runs", request);
            Check.True(replay.Replayed); Check.Equal(run.Error, replay.Error); Check.Equal(allowance, wire.Calls);
            string projection = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}");
            Check.True(!projection.Contains(FakeKey) && !projection.Contains(Endpoint));
            originalBytes = HarnessJson.Serialize(saved);
        }
        // Increase the budget only for this isolated restarted host. Reading/replaying the old
        // failure must not issue a request even though a provider reservation is now available.
        await using (var h = await Host.Start(root, configure: Provider(http, allowance + 1)))
        {
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); string id = owner.Snapshot.Id;
            var restored = (await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id}/harness/runs/{run.Id}"))!;
            Check.Equal("failed", restored.Status); Check.Equal(run.Error, restored.Error);
            Check.Equal(0, (await h.Http.GetFromJsonAsync<HarnessActiveRuns>($"/api/v1/campaigns/{id}/harness/runs/active"))!.Runs.Length);
            var replay = await Post<HarnessRunView>(h, id, "harness/runs", request);
            Check.True(replay.Replayed); Check.Equal(allowance, wire.Calls); Check.Equal(allowance, Usage(h, id));
            await NotResumable(h, id, run.Id, run.Version);
            Check.Equal(originalBytes, HarnessJson.Serialize(Stored(h, owner, run.Id)));
            var snapshot = (await h.Get(id))!;
            Check.Equal(allowance, snapshot.WorldMemory!.Count(m => m.Name == "预算保留线索"));
            Check.Equal(run.Version, snapshot.Version);
            var next = await Start(h, snapshot, "新的明确输入"); next = await Settled(h, id, next.Id, maximumPolls: 3000);
            Check.Equal("completed", next.Status); Check.Equal(allowance + 1, wire.Calls); Check.Equal(allowance + 1, Usage(h, id));
            Check.Equal(allowance, (await h.Get(id))!.WorldMemory!.Count(m => m.Name == "预算保留线索"));
            Check.Equal(originalBytes, HarnessJson.Serialize(Stored(h, owner, run.Id)));
        }
    }
    public static async Task RealPreflightEndpointRejected()
    {
        using var wire = new Wire(_ => Response(Text())); using var http = new HttpClient(wire);
        await using var h = await Host.Start(configure: Provider(http, endpoint: "http://example.invalid/private-endpoint"));
        var owner = await Create(h); var run = await Start(h, owner.Snapshot);
        run = await Settled(h, owner.Snapshot.Id, run.Id, maximumPolls: 3000);
        Check.Equal("failed", run.Status); Check.Equal("harness_model_endpoint", run.Error);
        Check.Equal(1, run.ModelAttempts); Check.Equal(0, wire.Calls); Check.Equal(0, Usage(h, owner.Snapshot.Id));
        Check.Equal(owner.Snapshot.Version, (await h.Get(owner.Snapshot.Id))!.Version);
    }
    public static async Task RealPostSendFailuresStayUnknown()
    {
        // The response may even imitate a preflight code; only trusted adapter evidence counts.
        using var wire = new Wire(i => i switch
        {
            1 => throw new HttpRequestException("harness_model_quota_exceeded " + FakeKey),
            2 => new(HttpStatusCode.OK) { Content = new StringContent("{bad private response " + FakeKey) },
            3 => new(HttpStatusCode.TooManyRequests) { Content = new StringContent("harness_model_quota_exceeded " + FakeKey) },
            4 => new(HttpStatusCode.OK) { Content = new StringContent("{\"code\":\"harness_model_quota_exceeded\"}") },
            _ => Response(Text())
        });
        using var http = new HttpClient(wire); string root; CreatedCampaign owner;
        var requests = new List<HarnessInputRequest>();
        await using (var h = await Host.Start(configure: Provider(http)))
        {
            root = h.Root; owner = await Create(h); string id = owner.Snapshot.Id;
            for (int i = 1; i <= 4; i++)
            {
                var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "外发后失败" + i); requests.Add(request);
                var run = await Post<HarnessRunView>(h, id, "harness/runs", request);
                run = await Settled(h, id, run.Id, maximumPolls: 3000);
                Check.Equal("unknown", run.Status); Check.Equal("harness_model_unknown", run.Error);
                Check.Equal(1, run.ModelAttempts); Check.Equal(i, wire.Calls); Check.Equal(i, Usage(h, id));
                Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version);
                var replay = await Post<HarnessRunView>(h, id, "harness/runs", request);
                Check.True(replay.Replayed); Check.Equal(i, wire.Calls);
            }
        }
        await using (var h = await Host.Start(root, configure: Provider(http)))
        {
            string id = owner.Snapshot.Id; h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            foreach (var request in requests)
            {
                var replay = await Post<HarnessRunView>(h, id, "harness/runs", request);
                Check.True(replay.Replayed); Check.Equal("unknown", replay.Status); Check.Equal("harness_model_unknown", replay.Error);
                await NotResumable(h, id, request.RequestId, owner.Snapshot.Version);
            }
            Check.Equal(4, wire.Calls); Check.Equal(4, Usage(h, id));
        }
    }
    public static async Task ContinuationThresholdSurvivesWaitingRestart()
    {
        var model = new Model((_, _) => Tool("ask_player", new { question = "下一步？" }) with { InputTokens = 99999, OutputTokens = 1 });
        var loop = new Loop(); string root; CreatedCampaign owner; HarnessRunView run;
        await using (var h = await Host.Start(configure: Configure(model, loop)))
        {
            root = h.Root; owner = await Create(h); run = await Start(h, owner.Snapshot);
            run = await Settled(h, owner.Snapshot.Id, run.Id);
            Check.Equal("waiting", run.Status); Check.Equal("player", run.Wait!.Kind);
            Check.Equal(100000, Stored(h, owner, run.Id).Tokens); Check.Equal(1, model.Calls);
        }
        await using (var h = await Host.Start(root, configure: Configure(model, loop)))
        {
            string id = owner.Snapshot.Id; h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var request = new HarnessResumeRequest(Id(), run.Version, "继续查看");
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", request);
            run = await Settled(h, id, run.Id);
            Check.Equal("waiting", run.Status); Check.Equal("player", run.Wait!.Kind);
            Check.Equal(2, model.Calls); Check.Equal(2, run.ModelAttempts); Check.Equal(200000, Stored(h, owner, run.Id).Tokens);
            var replay = await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", request);
            Check.True(replay.Replayed); Check.Equal(2, model.Calls); Check.Equal(2, loop.Executions);
        }
    }
    public static async Task CompletedReplyMayCrossContinuationThreshold()
    {
        var model = new Model((_, _) => Text("已返回的有效结果。") with { InputTokens = 100001, OutputTokens = 1 });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
        var run = await Start(h, owner.Snapshot); run = await Settled(h, owner.Snapshot.Id, run.Id);
        Check.Equal("completed", run.Status); Check.Equal(1, model.Calls); Check.Equal(100002, Stored(h, owner, run.Id).Tokens);
        Check.Equal(owner.Snapshot.Version + 1, (await h.Get(owner.Snapshot.Id))!.Version);
    }
}
