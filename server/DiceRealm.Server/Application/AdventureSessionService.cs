using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// 无状态业务门面：授权转交、DTO 投影，以及把业务命令映射到既有公开内核服务。
// 权威、回执、事务、权限与幂等仍由 HarnessRunService / GameService / HarnessWorkspaceCatalog 拥有；
// 这里不新增状态、不复制回执逻辑、不改变命令顺序，也不改变旧端点语义。
public sealed class AdventureSessionService(GameService game, HarnessRunService runs)
{
    // 元素为 null 时保留 null 交给 HarnessProfiles.Validate 拒绝（400），绝不在门面里解引用 null。
    private static HarnessSkill[] Skills(AdventureMethod[]? methods) =>
        (methods ?? []).Select(Method).ToArray();

    private static HarnessSkill Method(AdventureMethod? method) =>
        method is null ? null! : new HarnessSkill(method.Id, method.Description, method.Content);

    // 预览/保存草稿的 methods 是必填构造参数：显式 null 与旧 skills:null 同义，必须拒绝，
    // 不能静默变成空数组让用户以为已保存。空数组仍然是合法的「没有工作方法说明」。
    private static AdventureMethod[] RequiredMethods(AdventureMethod[]? methods) => methods ??
        throw new GameException("invalid_harness_profile", "需要有界只读的工作方法说明；明确的 null 不被接受。");

    private static AdventureMethod[] Methods(HarnessSkill[] skills) =>
        skills.Select(skill => new AdventureMethod(skill.Id, skill.Description, skill.Content)).ToArray();

    private static AdventureContentSettings Content(HarnessProfile profile) => new(profile.Preset.Id, profile.Preset.Version,
        profile.Preset.SystemPrompt, Methods(profile.Skills), profile.Hash, profile.Preset.CombatSystemPrompt);

    // MatchesActive 只表示「服务器草稿与当前启用内容一致」，不代表这份草稿是否曾经发布过。
    private static AdventureSettingsView View(HarnessWorkspace workspace) => new(workspace.Version, workspace.ActiveRevision,
        workspace.LatestRevision, Content(workspace.Draft), Content(workspace.Active), workspace.Draft.Hash == workspace.Active.Hash,
        HarnessCombatPrompts.Default);

    public CreatedCampaign CreateFromContent(CreateCampaignFromContentRequest request) =>
        game.CreateHarness(new CreateHarnessCampaignRequest(request.Name, request.CharacterName, request.Adventure,
            new HarnessPreset("primary", 1, request.Prompt, request.CombatPrompt), Skills(request.Methods), request.TemplateId,
            request.Creation, request.Build));

    public async Task<AdventureBoard> Board(string campaign, string token, CancellationToken ct)
    {
        var active = await runs.ListActive(campaign, token, ct);
        return new(active.Runs.Select(AdventureSessions.View).ToArray()) { OthersActing = active.OthersActing.Length > 0 ? active.OthersActing : null };
    }

    public async Task<AdventureSessionView> Session(string campaign, string token, string sessionId, CancellationToken ct) =>
        AdventureSessions.View(await runs.Get(campaign, token, sessionId, ct));

    public async Task<AdventureSessionView> Act(string campaign, string token, AdventureActionRequest request, CancellationToken ct) =>
        AdventureSessions.View(await runs.Start(campaign, token,
            new HarnessInputRequest(request.RequestId, request.ExpectedVersion, request.Text), ct));

    public async Task<AdventureSessionView> Continue(string campaign, string token, string sessionId,
        AdventureActionRequest request, CancellationToken ct) =>
        AdventureSessions.View(await runs.Resume(campaign, token, sessionId,
            new HarnessResumeRequest(request.RequestId, request.ExpectedVersion, request.Text), ct));

    public async Task<AdventureSessionView> Stop(string campaign, string token, string sessionId, CancellationToken ct) =>
        AdventureSessions.View(await runs.Cancel(campaign, token, sessionId, ct));

    // 本人已公开的近期行动只读投影；不含工具/回执细节，也不是当前角色数值。
    public async Task<AdventureMemory> Memory(string campaign, string token, CancellationToken ct)
    {
        var memory = await game.GetHarnessMemory(campaign, token, ct);
        return new(memory.Entries.Select(entry =>
            new AdventureMemoryEntry(entry.Input, entry.Narrative, entry.OriginSequence, entry.Corrected)).ToArray());
    }

    public async Task<AdventureSettingsView> Settings(string campaign, string token, CancellationToken ct) =>
        View(await game.GetHarnessWorkspace(campaign, token, ct));

    // 服务器校验原文与工作方法说明，不保存、不发布、不调用模型；身份也来自请求本身。
    public async Task<AdventureSettingsPreview> PreviewSettings(string campaign, string token,
        AdventureSettingsPreviewRequest request, CancellationToken ct)
    {
        await game.PreviewHarnessProfile(campaign, token,
            new HarnessProfileRequest(new HarnessPreset(request.ContentId, request.ContentVersion, request.Prompt, request.CombatPrompt),
                Skills(RequiredMethods(request.Methods))), ct);
        return new(request.ContentId, request.ContentVersion, request.Prompt, RequiredMethods(request.Methods), request.CombatPrompt);
    }

    // 保存草稿、发布版本、明确启用是三个独立业务命令，各自沿用内核原有回执与版本检查。
    // 内容标识/版本随草稿一起冻结并原样透传，所以丢响应后的原样重试命中原回执。
    public async Task<AdventureSettingsResult> SaveDraft(string campaign, string token,
        SaveAdventureSettingsDraftRequest request, CancellationToken ct)
    {
        var result = await game.SaveHarnessDraft(campaign, token,
            new SaveHarnessDraftRequest(request.RequestId, request.ExpectedSettingsVersion,
                new HarnessPreset(request.ContentId, request.ContentVersion, request.Prompt, request.CombatPrompt), Skills(RequiredMethods(request.Methods))), ct);
        return new(View(result.Workspace), result.Replayed);
    }

    public async Task<AdventureSettingsResult> Publish(string campaign, string token,
        PublishAdventureSettingsRequest request, CancellationToken ct)
    {
        var result = await game.PublishHarness(campaign, token,
            new PublishHarnessRequest(request.RequestId, request.ExpectedSettingsVersion), ct);
        return new(View(result.Workspace), result.Replayed);
    }

    public async Task<AdventureSettingsResult> Activate(string campaign, string token, int revision,
        ActivateAdventureSettingsRequest request, CancellationToken ct)
    {
        var result = await game.ActivateHarness(campaign, token,
            new ActivateHarnessRequest(request.RequestId, request.ExpectedSettingsVersion, revision), ct);
        return new(View(result.Workspace), result.Replayed);
    }

    public async Task<AdventureSettingsHistory> SettingsHistory(string campaign, string token, int? before, int limit, CancellationToken ct)
    {
        var page = await game.HarnessRevisions(campaign, token, before, Math.Clamp(limit, 1, 50), ct);
        return new(page.Items.Select(item => new AdventureSettingsHistoryItem(item.Revision, item.CreatedAt)).ToArray(), page.NextBefore);
    }

    public async Task<AdventureSettingsRevision> SettingsRevision(string campaign, string token, int revision, CancellationToken ct)
    {
        var content = await game.HarnessRevision(campaign, token, revision, ct);
        return new(content.Revision.Revision, content.Revision.CreatedAt, content.Profile.Preset.SystemPrompt,
            Methods(content.Profile.Skills), content.Profile.Preset.CombatSystemPrompt);
    }

    public Task<byte[]> ExportSettings(string campaign, string token, int? revision, bool includeDraft, CancellationToken ct) =>
        game.ExportHarnessWorkspace(campaign, token, revision, includeDraft, ct);
}
