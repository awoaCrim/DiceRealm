using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class QuickRetellingTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private sealed class Wire : HttpMessageHandler
    {
        public int Calls;
        public string Body = "";
        public Func<CancellationToken, Task>? BeforeReply;
        public string Result = "我只知道北坡可能有人，还不能确定。";
        public HttpStatusCode Status = HttpStatusCode.OK;
        public bool Gemini, Disconnect;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls); Body = await request.Content!.ReadAsStringAsync(ct);
            if (BeforeReply is not null) await BeforeReply(ct);
            if (Disconnect) throw new HttpRequestException("fixture disconnect");
            string text = JsonSerializer.Serialize(new { text = Result });
            object response = Gemini
                ? new { candidates = new[] { new { finishReason = "STOP", content = new { parts = new[] { new { text } } } } } }
                : new { choices = new[] { new { finish_reason = "stop", message = new { content = text } } } };
            return new(Status) { Content = JsonContent.Create(response) };
        }
    }
    private static Action<WebApplicationBuilder> Configure(Wire wire) => b =>
    {
        HarnessTests.Configure(new HarnessTests.Model((_, _) => throw new Exception("No main model expected")))(b);
        b.Services.AddHttpClient(nameof(PrivateStoryRetellings)).ConfigurePrimaryHttpMessageHandler(() => wire);
    };
    private static void Enable(Host h, bool gemini = false)
    {
        var store = h.App.Services.GetRequiredService<AiConfigurationStore>();
        store.Save(new(Id(), store.Read().Version, new(false, "openai-chat", "", "", "keep"),
            new(true, gemini ? "gemini" : "openai-chat", "http://127.0.0.1:1/v1", "fixture-helper", "replace", "fixture-key")));
    }
    private static async Task<PrivateStoryPart> Record(Host h, CreatedCampaign actor, string text)
    {
        string id = actor.Snapshot.Id; var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(id, actor.AccessToken, default);
        await game.HarnessTool(id, actor.AccessToken, auth.ActorId, Id(), "原行动", auth.Version, Id(), Id(),
            new("world_record", HarnessJson.Element(new NarrativeHarnessArgs("公共回应。", [], text)), "call"), [], default, auth.Profile, 16, contextAlreadyRead: true);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", actor.AccessToken);
        var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
        return page.Entries.SelectMany(e => e.PrivateParts ?? []).Single(p => p.Text == text);
    }
    private static Task<HttpResponseMessage> Send(Host h, string campaign, SharePrivateStoryRequest request) =>
        h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/adventure/story/share", request);

    public static async Task Browser(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath)) throw new InvalidOperationException("Fresh fixture path required.");
        var wire = new Wire(); var dice = new SequenceDice();
        var model = new HarnessTests.Model((call, _) => call % 2 == 1
            ? HarnessTests.Tool("ask_player", new { question = "老板问：你想安静休息，还是找人聊聊？" })
            : HarnessTests.Tool("world_record", new NarrativeHarnessArgs("老板点头，给你指出安静的座位。", [])));
        await using var h = await Host.Start(dice: dice, configure: HarnessTests.Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
            b.Services.AddHttpClient(nameof(PrivateStoryRetellings)).ConfigurePrimaryHttpMessageHandler(() => wire);
        }));
        AccountTests.SeedAdminFixture(h);
        Enable(h); var owner = await HarnessTests.Create(h);
        await Record(h, owner, "北坡可能有人，尚未确认。这里是隔离验收消息，不含正式游戏资料。");
        var log = h.App.Services.GetRequiredService<ModelRequestLog>();
        long failed = log.Start("GeminiHarnessModel", new(owner.Snapshot.Id, "fixture-retry", "隔离重试提醒", 1), "POST", "http://127.0.0.1:1/v1", "fixture-same-body");
        log.Finish(failed, 503, "HTTP 503", 1, "fixture busy");
        string address = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority);
        JsonFiles.Write(statePath, new { baseUrl = address, campaignId = owner.Snapshot.Id, accessToken = owner.AccessToken, dataPath = h.Root, processId = Environment.ProcessId, failedRequestId = failed });
        bool recovered = false;
        while (!File.Exists(statePath + ".stop"))
        {
            if (!recovered && File.Exists(statePath + ".recover"))
            {
                long success = log.Start("GeminiHarnessModel", new(owner.Snapshot.Id, "fixture-retry", "隔离重试提醒", 2), "POST", "http://127.0.0.1:1/v1", "fixture-same-body");
                log.Finish(success, 200, "", 1, "fixture recovered"); recovered = true;
            }
            JsonFiles.Write(statePath + ".stats", new { helperCalls = wire.Calls, modelCalls = model.Calls, dice = dice.Count, paidProviderCalls = 0, recovered });
            await Task.Delay(500);
        }
        JsonFiles.Write(statePath + ".result", new { helperCalls = wire.Calls, modelCalls = model.Calls, dice = dice.Count, paidProviderCalls = 0, recovered });
    }

    public static async Task OneCallImmediatePublicationConcurrencyAndRestart()
    {
        var wire = new Wire(); var h = await Host.Start(configure: Configure(wire)); Enable(h);
        try
        {
            var owner = await HarnessTests.Create(h); var actor = await HarnessBoundaryTests.Guest(h, owner);
            string id = owner.Snapshot.Id;
            var part = await Record(h, actor, "北坡可能有人，尚未确认。SOURCE_ONLY_THIS");
            await Record(h, actor, "另一个秘密。DO_NOT_SEND");
            var request = new SharePrivateStoryRequest(Id(), part.Source, Quick: true);
            foreach (string token in new[] { owner.AccessToken, (await HarnessBoundaryTests.Guest(h, owner)).AccessToken })
            {
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
                Check.Equal(HttpStatusCode.Conflict, (await Send(h, id, request)).StatusCode);
            }
            Check.Equal(0, wire.Calls); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", actor.AccessToken);
            Check.Equal(HttpStatusCode.BadRequest, (await Send(h, id, request with { Text = "mixed" })).StatusCode);
            var before = (await h.Get(id))!;
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            wire.BeforeReply = async ct => { entered.TrySetResult(); await release.Task.WaitAsync(ct); };
            var first = Send(h, id, request); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var second = Send(h, id, request);
            Check.Equal(before.Version, (await h.Get(id))!.Version); // model wait never locks the campaign
            release.TrySetResult(); var replies = await Task.WhenAll(first, second);
            foreach (var reply in replies) Check.Equal(HttpStatusCode.OK, reply.StatusCode);
            var results = await Task.WhenAll(replies.Select(r => r.Content.ReadFromJsonAsync<ActionResponse>()));
            Check.True(results.Any(r => r!.Replayed)); Check.Equal(1, wire.Calls);
            Check.True(wire.Body.Contains("SOURCE_ONLY_THIS") && !wire.Body.Contains("DO_NOT_SEND"));
            Check.True(!wire.Body.Contains("tools") && !wire.Body.Contains("max_tokens"));
            var after = (await h.Get(id))!; var share = after.SharedStories!.Single();
            Check.Equal(wire.Result, share.Text); Check.Equal("retelling", share.Publication);
            Check.Equal(before.Version, after.Version); Check.Equal(before.ElapsedSeconds, after.ElapsedSeconds);
            Check.True(!HarnessJson.Serialize(share).Contains("SOURCE_ONLY_THIS"));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(wire));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", actor.AccessToken);
            var replay = await Send(h, id, request); Check.Equal(HttpStatusCode.OK, replay.StatusCode);
            Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed); Check.Equal(1, wire.Calls);
            Check.Equal(HttpStatusCode.Conflict, (await Send(h, id, request with { Quick = false, Text = "changed" })).StatusCode);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task FailuresAndUnknownNeverRetryAndGeminiWorks()
    {
        foreach (string mode in new[] { "http", "invalid", "oversized", "unknown", "gemini" })
        {
            var wire = new Wire { Status = mode == "http" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK,
                Result = mode == "invalid" ? "" : mode == "oversized" ? new string('x', 300000) : "我不能确定北坡是否有人。", Disconnect = mode == "unknown", Gemini = mode == "gemini" };
            var h = await Host.Start(configure: Configure(wire)); Enable(h, wire.Gemini);
            try
            {
                var owner = await HarnessTests.Create(h); var part = await Record(h, owner, "北坡也许有人。");
                var request = new SharePrivateStoryRequest(Id(), part.Source, Quick: true); string id = owner.Snapshot.Id;
                var reply = await Send(h, id, request);
                Check.Equal(mode == "gemini" ? HttpStatusCode.OK : HttpStatusCode.Conflict, reply.StatusCode);
                Check.Equal(1, wire.Calls);
                if (mode == "gemini") Check.Equal(wire.Result, (await reply.Content.ReadFromJsonAsync<ActionResponse>())!.SharedStory!.Text);
                else
                {
                    Check.Equal(0, (await h.Get(id))!.SharedStories?.Length ?? 0);
                    string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(wire));
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                    Check.Equal(HttpStatusCode.Conflict, (await Send(h, id, request)).StatusCode); Check.Equal(1, wire.Calls);
                }
            }
            finally { await h.DisposeAsync(); }
        }
    }

    public static async Task TimelineChangedDuringGenerationCannotPublishOrResend()
    {
        var wire = new Wire(); await using var h = await Host.Start(configure: Configure(wire)); Enable(h);
        var owner = await HarnessTests.Create(h); var part = await Record(h, owner, "这条来源将被撤换。");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        wire.BeforeReply = async ct => { entered.TrySetResult(); await release.Task.WaitAsync(ct); };
        var request = new SharePrivateStoryRequest(Id(), part.Source, Quick: true); string id = owner.Snapshot.Id;
        var pending = Send(h, id, request); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            c.TimelineId = Id();
            return Task.FromResult(0);
        });
        release.TrySetResult(); Check.Equal(HttpStatusCode.Conflict, (await pending).StatusCode);
        Check.Equal(0, (await h.Get(id))!.SharedStories?.Length ?? 0);
        Check.Equal(HttpStatusCode.Conflict, (await Send(h, id, request)).StatusCode); Check.Equal(1, wire.Calls);
    }
}
