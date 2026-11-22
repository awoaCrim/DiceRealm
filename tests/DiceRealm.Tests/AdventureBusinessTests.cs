using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// 业务边界回归：工作台产品边界只表达战役、内容准备、行动、回答与结果。
// 旧的 /harness/* 兼容端点保持可用，两条边界共享同一内核回执。
internal static class AdventureBusinessTests
{
    private static readonly string[] BusinessSessionFields = ["sessionId", "phase", "question", "confirmation", "outcome", "notice", "actionText", "replayed", "actionId", "role"];
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    public static Task Run() => RunAll();

    private static async Task RunAll()
    {
        await CreationAndSettingsBoundary();
        await SettingsReplayAndIdentity();
        await ActionBoundaryAndSharedReceipt();
        await WaitingContinueAndUnknown();
        await ConfirmationProjection();
        await TeammateActionInProgressOnBoard();
    }

    // While the host works on one seat's action, every other seat's board names that seat, so the
    // page can say so before the player sends into a busy host. The acting seat and a settled run do not.
    private static async Task TeammateActionInProgressOnBoard()
    {
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (call, _, ct) => { reached.TrySetResult(); await release.Task.WaitAsync(ct); return Text("守卫点了点头。"); });
        await using var h = await Host.Start(configure: Configure(model, new Loop()));
        var owner = await CreateFromContent(h, "直接回应。\n");
        var guest = await HarnessBoundaryTests.Guest(h, owner);
        string id = owner.Snapshot.Id, guestActor = guest.Snapshot.Party!.SelfActorId;
        async Task<string> Board(CreatedCampaign seat)
        {
            h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", seat.AccessToken);
            return await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/adventure");
        }
        Check.True(!(await Board(owner)).Contains("othersActing"), "no one is acting yet");
        h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", guest.AccessToken);
        var started = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/adventure/actions",
            new AdventureActionRequest(Id(), (await h.Get(id))!.Version, "向守卫打听"))).Content.ReadFromJsonAsync<AdventureSessionView>())!;
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(30));
        var seen = JsonSerializer.Deserialize<AdventureBoard>(await Board(owner), Web)!;
        Check.Equal(guestActor, seen.OthersActing!.Single());
        Check.True(!(await Board(guest)).Contains("othersActing"), "the acting seat sees its own session, not itself as a teammate");
        release.TrySetResult();
        h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", guest.AccessToken);
        await Settled(h, id, started.SessionId, "done");
        for (int i = 0; i < 100 && (await Board(owner)).Contains("othersActing"); i++) await Task.Delay(20);
        Check.True(!(await Board(owner)).Contains("othersActing"), "a settled run is no longer in progress");
    }

    private static async Task<CreatedCampaign> CreateFromContent(Host h, string prompt, AdventureMethod[]? methods = null)
    {
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns/from-content",
            new CreateCampaignFromContentRequest("业务战役", "Arden", TestContent.Document, prompt,
                methods ?? [new("m1", "阅读线索", "逐条核对公开线索，不执行任何文件。")], Build: FullCreationTests.Named("Arden")));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var result = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", result.AccessToken);
        return result;
    }

    private static async Task<AdventureSettingsView> Settings(Host h, string campaign)
    {
        var response = await h.Http.GetAsync($"/api/v1/campaigns/{campaign}/adventure/settings");
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonSerializer.Deserialize<AdventureSettingsView>(await response.Content.ReadAsStringAsync(), Web)!;
    }

    private static async Task<AdventureSettingsResult> PostSettings<T>(Host h, string campaign, string route, T body)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/adventure/settings/{route}", body);
        if (!response.IsSuccessStatusCode) throw new Exception(response.StatusCode + " " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<AdventureSettingsResult>())!;
    }

    private static void AssertBusinessSession(string json)
    {
        using var document = JsonDocument.Parse(json);
        var names = document.RootElement.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
        Check.True(names.SetEquals(BusinessSessionFields), "业务行动视图只能暴露业务字段，实际为：" + string.Join(",", names));
    }

    private static async Task<AdventureSessionView> Settled(Host h, string campaign, string id, params string[] phases)
    {
        for (int i = 0; i < 400; i++)
        {
            var value = await h.Http.GetFromJsonAsync<AdventureSessionView>($"/api/v1/campaigns/{campaign}/adventure/sessions/{id}");
            if (value is not null && phases.Contains(value.Phase)) return value;
            await Task.Delay(15);
        }
        throw new Exception("业务行动视图未在预期时间内到达阶段：" + string.Join("/", phases));
    }

    private static async Task CreationAndSettingsBoundary()
    {
        var model = new Model((_, _) => Text("未使用此模型。"));
        var loop = new Loop();
        await using var h = await Host.Start(broken: new BrokenText(), configure: Configure(model, loop));
        // 旧战役不会被静默转换，也不会假装有可用的系统推进行动。
        var legacy = await h.Create();
        h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", legacy.AccessToken);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.GetAsync($"/api/v1/campaigns/{legacy.Snapshot.Id}/adventure")).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.GetAsync($"/api/v1/campaigns/{legacy.Snapshot.Id}/adventure/settings")).StatusCode);
        // 无权凭证不泄露任何设定内容。
        h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", new string('0', 64));
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync($"/api/v1/campaigns/{legacy.Snapshot.Id}/adventure/settings")).StatusCode);

        var owner = await CreateFromContent(h, "  用户原文\n不填默认提示词。\n");
        var snapshot = owner.Snapshot;
        Check.Equal("active", snapshot.Content!.Status);
        Check.True(snapshot.Content.Prompts is null, "自带内容创建不追加默认提示词");

        var settingsResponse = await h.Http.GetAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/settings");
        var settingsJson = await settingsResponse.Content.ReadAsStringAsync();
        using (var document = JsonDocument.Parse(settingsJson))
        {
            var names = document.RootElement.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
            Check.True(names.SetEquals(["settingsVersion", "activeRevision", "latestRevision", "draft", "active", "matchesActive", "defaultCombatPrompt"]),
                "业务设定视图只能暴露业务字段，实际为：" + string.Join(",", names));
            Check.Equal(HarnessCombatPrompts.Default, document.RootElement.GetProperty("defaultCombatPrompt").GetString());
            var draft = document.RootElement.GetProperty("draft");
            Check.True(draft.EnumerateObject().Select(p => p.Name).ToHashSet(StringComparer.Ordinal)
                .SetEquals(["contentId", "contentVersion", "prompt", "methods", "fingerprint"]), "草稿只暴露内容准备字段");
            Check.Equal("  用户原文\n不填默认提示词。\n", draft.GetProperty("prompt").GetString());
            Check.Equal("m1", draft.GetProperty("methods")[0].GetProperty("id").GetString());
        }
        var initial = JsonSerializer.Deserialize<AdventureSettingsView>(settingsJson, Web)!;
        Check.Equal(1, initial.SettingsVersion);
        Check.Equal(1, initial.ActiveRevision);
        Check.Equal(1, initial.Draft.ContentVersion);
        Check.Equal(initial.Active.Fingerprint, initial.Draft.Fingerprint);
        Check.True(initial.MatchesActive);

        // 校验是服务器职责，空原文被拒绝，且不写入。
        var invalid = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/preview",
            new AdventureSettingsPreviewRequest(initial.Draft.ContentId, 2, "   ", []));
        Check.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);

        // 明确的 null 工作方法说明与 null 条目不能被悄悄当成空数组，也不能 500 或写半份状态。
        var draftCalls = model.Calls;
        var nullEntryCreate = await h.Http.PostAsJsonAsync("/api/v1/campaigns/from-content",
            new { name = "坏方法", characterName = "Arden", adventure = TestContent.Document, prompt = "原文\n", methods = new AdventureMethod?[] { null } });
        Check.Equal(HttpStatusCode.BadRequest, nullEntryCreate.StatusCode);
        foreach (var route in new[] { "preview", "draft" })
        {
            var nullMethods = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/{route}",
                new { requestId = Id(), expectedSettingsVersion = initial.SettingsVersion, contentId = initial.Draft.ContentId,
                    contentVersion = 2, prompt = "原文\n", methods = (AdventureMethod[]?)null });
            Check.Equal(HttpStatusCode.BadRequest, nullMethods.StatusCode);
            var nullEntry = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/{route}",
                new { requestId = Id(), expectedSettingsVersion = initial.SettingsVersion, contentId = initial.Draft.ContentId,
                    contentVersion = 2, prompt = "原文\n", methods = new AdventureMethod?[] { null } });
            Check.Equal(HttpStatusCode.BadRequest, nullEntry.StatusCode);
        }
        Check.True((await Settings(h, snapshot.Id)).SettingsVersion == initial.SettingsVersion, "非法 methods 不得写入设定");
        Check.True(model.Calls == draftCalls, "非法 methods 不得调用模型");

        // 保存草稿不会自动启用：active 仍是创建时的内容。
        var saved = await PostSettings(h, snapshot.Id, "draft",
            new SaveAdventureSettingsDraftRequest(Id(), initial.SettingsVersion, initial.Draft.ContentId, 2, "第二版原文\n",
                [new("m2", "收紧范围", "只使用公开叙事。")]));
        Check.Equal("第二版原文\n", saved.Settings.Draft.Prompt);
        Check.Equal("  用户原文\n不填默认提示词。\n", saved.Settings.Active.Prompt);
        Check.True(!saved.Settings.MatchesActive, "保存草稿不等于启用");
        Check.True(!saved.Replayed);
        Check.True(saved.Settings.SettingsVersion > initial.SettingsVersion);
        Check.True(!saved.Settings.MatchesActive, "草稿与启用内容不同：MatchesActive 只表示两者一致");

        var current = await Settings(h, snapshot.Id);
        var published = await PostSettings(h, snapshot.Id, "publish",
            new PublishAdventureSettingsRequest(Id(), current.SettingsVersion));
        Check.True(published.Settings.LatestRevision > current.LatestRevision);
        Check.Equal("  用户原文\n不填默认提示词。\n", published.Settings.Active.Prompt); // 发布不等于启用
        Check.True(!published.Settings.MatchesActive, "已发布但未启用时不得声称与启用内容一致");

        var beforeActivate = await Settings(h, snapshot.Id);
        var activated = await PostSettings(h, snapshot.Id, "activate",
            new ActivateAdventureSettingsRequest(Id(), beforeActivate.SettingsVersion, published.Settings.LatestRevision));
        Check.Equal("第二版原文\n", activated.Settings.Active.Prompt);
        Check.Equal(published.Settings.LatestRevision, activated.Settings.ActiveRevision);
        Check.True(activated.Settings.MatchesActive);

        // 历史与按版本读取：内容版本是业务概念，可读可用。
        var history = (await h.Http.GetFromJsonAsync<AdventureSettingsHistory>($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/history"))!;
        Check.True(history.Items.Length >= 2, "历史设定包含创建与后续保存");
        var original = (await h.Http.GetFromJsonAsync<AdventureSettingsRevision>($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/history/1"))!;
        Check.Equal(1, original.Revision);
        Check.Equal("  用户原文\n不填默认提示词。\n", original.Prompt);
        var back = await PostSettings(h, snapshot.Id, "activate",
            new ActivateAdventureSettingsRequest(Id(), (await Settings(h, snapshot.Id)).SettingsVersion, 1));
        Check.Equal(1, back.Settings.ActiveRevision);
        Check.Equal("  用户原文\n不填默认提示词。\n", back.Settings.Active.Prompt);

        // 过期依据被拒绝，不静默重基。
        var stale = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/draft",
            new SaveAdventureSettingsDraftRequest(Id(), initial.SettingsVersion, initial.Draft.ContentId, 3, "过期依据\n", []));
        Check.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Check.Equal("workspace_stale_version", (await stale.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // 旧工作区端点仍在，旧客户端与旧 pending 仍然可原样重放。
        Check.Equal(HttpStatusCode.OK, (await h.Http.GetAsync($"/api/v1/campaigns/{snapshot.Id}/harness/workspace")).StatusCode);

        // 身份与主持权限先于请求体解析：错误凭证配合错误 Content-Type 仍先返回 401，不解析正文。
        var previous = h.Http.DefaultRequestHeaders.Authorization;
        h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", new string('0', 64));
        foreach (var route in new[] { "preview", "draft", "publish", "activate" })
        {
            var unauthorized = await h.Http.PostAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/{route}",
                new StringContent("not json", System.Text.Encoding.UTF8, "text/plain"));
            Check.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
        }
        h.Http.DefaultRequestHeaders.Authorization = previous;
    }

    // 丢响应后的原样重试必须命中原回执：身份随请求冻结，不从当前可变状态重建。
    private static async Task SettingsReplayAndIdentity()
    {
        var model = new Model((_, _) => Text("未使用此模型。"));
        await using var h = await Host.Start(broken: new BrokenText(), configure: Configure(model, new Loop()));
        var owner = await CreateFromContent(h, "第一版原文\n");
        var snapshot = owner.Snapshot;
        var initial = await Settings(h, snapshot.Id);

        var lostId = Id();
        var lost = new SaveAdventureSettingsDraftRequest(lostId, initial.SettingsVersion, initial.Draft.ContentId, 2, "第二版原文\n",
            [new("m2", "收紧范围", "只使用公开叙事。")]);
        var first = await PostSettings(h, snapshot.Id, "draft", lost);
        Check.True(!first.Replayed);

        // 期间别人改稿、发布并启用：原请求的 expectedSettingsVersion 已过期。
        var intervening = await Settings(h, snapshot.Id);
        await PostSettings(h, snapshot.Id, "draft",
            new SaveAdventureSettingsDraftRequest(Id(), intervening.SettingsVersion, intervening.Draft.ContentId, 3, "别人改的第三版\n", []));
        var afterEdit = await Settings(h, snapshot.Id);
        var publishId = Id();
        var published = await PostSettings(h, snapshot.Id, "publish",
            new PublishAdventureSettingsRequest(publishId, afterEdit.SettingsVersion));
        var afterPublish = await Settings(h, snapshot.Id);
        await PostSettings(h, snapshot.Id, "activate",
            new ActivateAdventureSettingsRequest(Id(), afterPublish.SettingsVersion, published.Settings.LatestRevision));
        var afterOthers = await Settings(h, snapshot.Id);
        Check.Equal("别人改的第三版\n", afterOthers.Draft.Prompt);
        Check.Equal("别人改的第三版\n", afterOthers.Active.Prompt);

        // 原样重放：确认原命令，不重新执行、不覆盖别人的稿、不因过期版本失败。
        var replay = await PostSettings(h, snapshot.Id, "draft", lost);
        Check.True(replay.Replayed, "原样重放必须命中原回执");
        Check.Equal("别人改的第三版\n", replay.Settings.Draft.Prompt);
        Check.Equal(afterOthers.Draft.Fingerprint, replay.Settings.Draft.Fingerprint);

        // 同 ID 改正文必须拒绝，绝不静默替换。
        var conflict = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/settings/draft",
            lost with { Prompt = "改成完全不同的正文\n" });
        Check.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Check.Equal("idempotency_conflict", (await conflict.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        // 发布/启用的原样重放同样不重复执行。
        var publishReplay = await PostSettings(h, snapshot.Id, "publish",
            new PublishAdventureSettingsRequest(publishId, afterEdit.SettingsVersion));
        Check.True(publishReplay.Replayed, "发布重放命中原回执");
        Check.Equal(published.Settings.LatestRevision, publishReplay.Settings.LatestRevision);
    }

    private static async Task ActionBoundaryAndSharedReceipt()
    {
        // 单步保存结果的模型：本测试验证业务投影与共享回执，不重复覆盖确认链（已由 Harness 测试覆盖）。
        var model = new Model((_, _) => Text("公开结果已保存。"));
        var loop = new Loop();
        await using var h = await Host.Start(dice: new SequenceDice(18), broken: new BrokenText(), configure: Configure(model, loop));
        var owner = await CreateFromContent(h, "按用户原文推进；不追加系统提示。\n");
        var snapshot = owner.Snapshot;
        var requestId = Id();
        var request = new AdventureActionRequest(requestId, snapshot.Version, "调查现场");

        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/actions", request);
        Check.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var sessionJson = await response.Content.ReadAsStringAsync();
        AssertBusinessSession(sessionJson);
        var started = JsonSerializer.Deserialize<AdventureSessionView>(sessionJson, Web)!;
        Check.True(string.Equals(started.SessionId, requestId, StringComparison.OrdinalIgnoreCase), "业务响应编号必须匹配请求");
        Check.Equal("调查现场", started.ActionText);
        Check.True(new[] { "working", "needsAnswer", "needsConfirmation", "done" }.Contains(started.Phase), "启动阶段合法：" + started.Phase);

        var settled = await Settled(h, snapshot.Id, requestId, "done");
        Check.True(settled.Outcome.Length > 0, "完成阶段保留已保存的结果正文");
        var calls = model.Calls;

        // 同 requestId 同正文原样重试：原回执、无新模型调用、编号不变。
        var replay = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/actions", request);
        Check.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        var replayed = (await replay.Content.ReadFromJsonAsync<AdventureSessionView>())!;
        Check.True(replayed.Replayed, "业务重放标记回执");
        Check.True(string.Equals(replayed.SessionId, requestId, StringComparison.OrdinalIgnoreCase));
        Check.Equal(calls, model.Calls);

        // 业务端点与旧端点共享内核回执，旧客户端仍能读到同一条记录。
        var legacy = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/harness/runs",
            new HarnessInputRequest(requestId, snapshot.Version, "调查现场"));
        Check.Equal(HttpStatusCode.Accepted, legacy.StatusCode);
        var legacyRun = (await legacy.Content.ReadFromJsonAsync<HarnessRunView>())!;
        Check.True(legacyRun.Replayed);
        Check.True(string.Equals(legacyRun.Id, requestId, StringComparison.OrdinalIgnoreCase));
        Check.Equal(calls, model.Calls);

        // 空行动按内核严格规则被拒绝，不产生半份状态。
        var empty = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/actions",
            new AdventureActionRequest(Id(), snapshot.Version, "   "));
        Check.Equal(HttpStatusCode.BadRequest, empty.StatusCode);

        // 本人近期行动是只读业务投影，可直接读取。
        var memory = (await h.Http.GetFromJsonAsync<AdventureMemory>($"/api/v1/campaigns/{snapshot.Id}/adventure/memory"))!;
        Check.True(memory.Entries.Length >= 1, "本人近期行动可读取");
        Check.Equal("调查现场", memory.Entries[0].ActionText);
    }

    private static async Task WaitingContinueAndUnknown()
    {
        var model = new Model((call, _) => call == 1 ? Tool("ask_player", new { question = "你想先问谁？" }) : Text("已记录你的回答。"));
        var loop = new Loop();
        await using var h = await Host.Start(broken: new BrokenText(), configure: Configure(model, loop));
        var owner = await CreateFromContent(h, "等待用户澄清后再继续。\n");
        var snapshot = owner.Snapshot;

        var started = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/actions",
            new AdventureActionRequest(Id(), snapshot.Version, "向守卫打听"))).Content.ReadFromJsonAsync<AdventureSessionView>())!;
        var waiting = await Settled(h, snapshot.Id, started.SessionId, "needsAnswer");
        Check.Equal("你想先问谁？", waiting.Question);
        Check.Equal(1, model.Calls);

        var board = await h.Http.GetFromJsonAsync<AdventureBoard>($"/api/v1/campaigns/{snapshot.Id}/adventure");
        Check.Equal(1, board!.Sessions.Length);
        Check.Equal("needsAnswer", board.Sessions[0].Phase);
        Check.True(string.Equals(board.Sessions[0].SessionId, started.SessionId, StringComparison.OrdinalIgnoreCase));

        // 停止披露只给业务后果与本人入口，不暴露内核协议字段说明。
        var stopNotice = (await Settled(h, snapshot.Id, started.SessionId, "needsAnswer")).Notice;
        Check.True(stopNotice.Length == 0 || !new[] { "rolls/respond", "intents/respond", "decision", "intentId", "rollId" }
            .Any(token => stopNotice.Contains(token, StringComparison.Ordinal)), "业务停止披露不得包含内核协议字段");

        var resumeId = Id();
        var resumed = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/sessions/{started.SessionId}/continue",
            new AdventureActionRequest(resumeId, snapshot.Version, "先问港口管理员"));
        Check.Equal(HttpStatusCode.Accepted, resumed.StatusCode);
        AssertBusinessSession(await resumed.Content.ReadAsStringAsync());
        var done = await Settled(h, snapshot.Id, started.SessionId, "done");
        Check.Equal("已记录你的回答。", done.Outcome);
        Check.Equal(2, model.Calls);

        // 续接回执也按 requestId 重放，不重新外发。
        var resumedReplay = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/sessions/{started.SessionId}/continue",
            new AdventureActionRequest(resumeId, snapshot.Version, "先问港口管理员"));
        var replayView = (await resumedReplay.Content.ReadFromJsonAsync<AdventureSessionView>())!;
        Check.True(replayView.Replayed);
        Check.Equal(2, model.Calls);

        // 停止必须无正文，且不撤回已提交效果。
        var bodyless = await h.Http.PostAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/sessions/{started.SessionId}/stop", null);
        Check.Equal(HttpStatusCode.OK, bodyless.StatusCode);
        var withBody = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/sessions/{started.SessionId}/stop", new { });
        Check.Equal(HttpStatusCode.BadRequest, withBody.StatusCode);

        // 未确认的模型步骤禁止补发：不提供续接，也不返回内部错误码。
        var unknownModel = new Model((_, _) => throw new HttpRequestException("fixture provider response lost"));
        await using var other = await Host.Start(broken: new BrokenText(), configure: Configure(unknownModel, new Loop()));
        var second = await CreateFromContent(other, "故障注入时的原文。\n");
        var lost = (await (await other.Http.PostAsJsonAsync($"/api/v1/campaigns/{second.Snapshot.Id}/adventure/actions",
            new AdventureActionRequest(Id(), second.Snapshot.Version, "未知结果"))).Content.ReadFromJsonAsync<AdventureSessionView>())!;
        var unconfirmed = await Settled(other, second.Snapshot.Id, lost.SessionId, "unconfirmed");
        Check.Equal("unconfirmed", unconfirmed.Phase);
        Check.True(unconfirmed.Confirmation is null);
        var refusedResponse = await other.Http.PostAsJsonAsync($"/api/v1/campaigns/{second.Snapshot.Id}/adventure/sessions/{lost.SessionId}/continue",
            new AdventureActionRequest(Id(), second.Snapshot.Version, ""));
        Check.True(!refusedResponse.IsSuccessStatusCode, "未确认步骤不能被业务续接补发");
    }

    // 业务确认事项只披露“需要你确认”和精确编号；目标/消耗/来源细节仍来自本人当前精确快照。
    private static async Task ConfirmationProjection()
    {
        var model = new Model((call, request) => call switch
        {
            1 => Tool("context_read"),
            2 => Tool("actions_propose", new
            {
                candidateId = Candidate(request, TestContent.Document.Scenes.Single(scene => scene.Id == "harbor")
                    .Actions.Single(action => action.Kind == "investigate").Label)
            }),
            _ => Text("不应在本测试中继续。")
        });
        var dice = new SequenceDice(18);
        await using var h = await Host.Start(dice: dice, broken: new BrokenText(), configure: Configure(model, new Loop()));
        var owner = await CreateFromContent(h, "确认前零骰；原文不替换。\n");
        var snapshot = owner.Snapshot;
        var started = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/actions",
            new AdventureActionRequest(Id(), snapshot.Version, "调查现场"))).Content.ReadFromJsonAsync<AdventureSessionView>())!;
        var waiting = await Settled(h, snapshot.Id, started.SessionId, "needsConfirmation");
        Check.True(waiting.Confirmation is not null, "来源确认等待必须给出精确确认事项");
        Check.True(new[] { "intent", "roll", "ruling" }.Contains(waiting.Confirmation!.Kind), "确认种类合法：" + waiting.Confirmation.Kind);
        var current = (await h.Get(snapshot.Id))!;
        string? expected = waiting.Confirmation.Kind switch
        {
            "intent" => current.PendingIntent?.Id,
            "roll" => current.PendingRoll?.Id,
            _ => null
        };
        Check.True(expected is not null && expected == waiting.Confirmation.WaitId, "确认事项必须匹配本人精确等待编号");
        Check.Equal(0, dice.Count); // 确认前零骰

        // 停止一个带待确认事项的行动：业务披露保留后果与本人放弃路径，但不出现内核协议字段。
        var stopped = (await (await h.Http.PostAsync($"/api/v1/campaigns/{snapshot.Id}/adventure/sessions/{started.SessionId}/stop", null))
            .Content.ReadFromJsonAsync<AdventureSessionView>())!;
        Check.True(stopped.Notice.Length > 0, "停止必须披露后果");
        foreach (var token in new[] { "rolls/respond", "intents/respond", "decision=", "intentId", "rollId", "快照" })
            Check.True(!stopped.Notice.Contains(token, StringComparison.Ordinal), "停止披露不得包含 " + token);
        Check.True(stopped.Notice.Contains("不会撤回", StringComparison.Ordinal), "停止披露必须说明已提交效果不会撤回");
        // 停止不撤销本人确认：内核 DTO 保留原等待，业务视图必须带出同一编号供单独放弃，而不是自动同意。
        Check.True(stopped.Confirmation is not null, "停止后的业务视图仍保留本文确认事项");
        Check.Equal(waiting.Confirmation!.WaitId, stopped.Confirmation!.WaitId);
    }
}
