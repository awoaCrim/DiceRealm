using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService(
    CampaignStore store, RulesEngine rules, CombatEngine combat, CharacterEngine characters, CharacterPlayEngine characterPlay, GrowthEngine growth, RulingEngine rulings, AssetCatalog assets, SceneReferences references,
    IIntentInterpreter interpreter, INarrator narrator, ILogger<GameService> logger, IConfiguration configuration, ProviderBudget budget, IMapImageGenerator imageGenerator, MapCatalog mapCatalog, HarnessWorkspaceCatalog workspaces, LocalRulesCatalog localRules, AdventureLibrary adventureLibrary, PortraitCatalog portraitCatalog, HarnessRunStore historyRuns, PrivateStoryRetellings retellings)
{
    private readonly TimeSpan textDeadline = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("TextAi:TimeoutSeconds", 8), 1, 45));

    public CreatedCampaign Create(CreateCampaignRequest request) => CreateCore(request);

    private CreatedCampaign CreateCore(CreateCampaignRequest request, HarnessProfile? harness = null, bool initialSetup = false, string? ownerUserId = null)
    {
        var name = Text(request.Name, 80, "name");
        bool hostOnly = request.Build is null && request.Creation is null && request.CharacterName == ""
            && request.TemplateId == CharacterEngine.Fighter;
        var character = hostOnly ? null : CharacterEngine.CreateComplete(Text(request.CharacterName, 40, "characterName"), request.TemplateId, request.Creation, request.Build);
        if (request.Adventure is not null) ContentValidator.Validate(request.Adventure);
        if (request.Prompts is not null) ValidatePrompts(request.Prompts);
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var campaign = new Campaign
        {
            Id = Guid.NewGuid().ToString(), Name = name, OwnerUserId = ownerUserId,
            TokenHash = JsonFiles.Hash(token), Character = character, HostOnlySeat = hostOnly,
            Adventure = request.Adventure, Harness = harness, InitialAdventureSetup = initialSetup,
            HostReview = hostOnly ? null : new(1, "approved", Reason: "主持创建并采用此角色。", ReviewedBy: PartyEngine.HostId, ReviewedAt: DateTimeOffset.UtcNow, Source: "host_creation")
        };
        if (request.Prompts is not null) SavePrompts(campaign, request.Prompts);
        if (request.StartImmediately) Activate(campaign);
        var scene = Adventure.Current(campaign);
        campaign.Events.Add(new(Guid.NewGuid().ToString(), 1, campaign.ContentActivated ? "arrival" : "content.draft", campaign.ContentActivated ? scene.Arrival : ContentView(campaign).Message,
            "", "authored", DateTimeOffset.UtcNow, null));
        var snapshot = Snapshot(campaign);
        store.Create(campaign);
        return new(token, snapshot);
    }

    public Task<CampaignSnapshot> Get(string id, string token, CancellationToken cancellationToken = default) =>
        store.Access(id, token, false, c => Task.FromResult(Snapshot(c)), cancellationToken);

    public Task<SceneAsset> GetAsset(string id, string token, string assetId, CancellationToken cancellationToken = default) =>
        store.Access(id, token, false, c =>
        {
            var current = assets.Ensure(c.Id, Adventure.Current(c));
            return Task.FromResult(current.Id == assetId ? current : assets.Get(c.Id, assetId));
        }, cancellationToken);

    public Task<SceneAsset> ReviseAsset(string id, string token, ReviseSceneAssetRequest request, CancellationToken ct) =>
        store.Access<SceneAsset>(id, token, false, c => { PartyEngine.RequireHost(c); throw AssetCatalog.Removed(); }, ct);

    public Task<SceneAsset> RetryAsset(string id, string token, string assetId, RetrySceneAssetRequest request, CancellationToken ct) =>
        store.Access<SceneAsset>(id, token, false, c => { PartyEngine.RequireHost(c); throw AssetCatalog.Removed(); }, ct);

    public Task<ReferenceImage> AssetReference(string id, string token, string assetId, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); RequireActive(c); return Task.FromResult(assets.UseAsReference(c.Id, assetId)); }, ct);

    public Task<ReferenceImage[]> References(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(references.List(c.Id)); }, ct);

    public async Task<ReferenceImage> UploadReference(string id, string token, string name, Stream input, CancellationToken ct)
    {
        var campaignId = await store.Access(id, token, false, c => { PartyEngine.RequireHost(c); RequireActive(c); return Task.FromResult(c.Id); }, ct);
        // A slow upload does not keep the gameplay transaction locked.
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await input.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > PngGuard.MaximumBytes)
                throw new GameException("reference_too_large", "参考图最大 10 MiB。", 413);
            buffer.Write(chunk, 0, read);
        }
        return await store.Access(campaignId, token, false, c =>
        {
            PartyEngine.RequireHost(c); RequireActive(c);
            return Task.FromResult(references.Register(c.Id, name, buffer.ToArray()));
        }, ct);
    }

    public Task<GameEvent[]> Events(string id, string token, int after, int limit, CancellationToken cancellationToken)
    {
        if (after < 0 || limit is < 1 or > 200) throw new GameException("invalid_pagination", "after >= 0，limit 在 1..200 之间。");
        return store.Access(id, token, false, c =>
        {
            // Legacy array endpoint has no explicit nextAfter; scan past private events so an
            // empty visible slice cannot strand old readers before later public records.
            var visible = new List<GameEvent>();
            while (after < c.Version && visible.Count < limit)
            {
                var page = store.ReadEvents(c, after, limit - visible.Count);
                if (page.Length == 0) break;
                visible.AddRange(page.Where(e => ActionUnderstanding.VisibleTo(c, e)).Select(e => ActionUnderstanding.ForViewer(c, e)));
                after = page[^1].Sequence;
            }
            return Task.FromResult(visible.ToArray());
        }, cancellationToken);
    }

    public Task<ActionResponse> Act(string id, string token, ActionRequest request, CancellationToken cancellationToken = default)
        => ActCore(id, token, request, false, cancellationToken);

    public Task<ActionResponse> ProposeAction(string id, string token, ActionRequest request, CancellationToken cancellationToken = default)
        => ActCore(id, token, request, true, cancellationToken);

    private Task<ActionResponse> ActCore(string id, string token, ActionRequest request, bool deferRoll, CancellationToken cancellationToken)
    {
        Validate(request);
        return store.Access(id, token, true, async campaign =>
        {
            var fingerprint = JsonFiles.Hash((deferRoll ? "actions.propose:" : "") + JsonSerializer.Serialize(request, JsonFiles.Options));
            var receipt = store.FindReceipt(campaign, request.RequestId);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint)
                    throw new GameException("idempotency_conflict", "行动 ID 已被另一份请求使用。", 409);
                return new ActionResponse(Snapshot(campaign), ActionUnderstanding.ForViewer(campaign, receipt.Resolution), true);
            }
            if (campaign.Version != request.ExpectedVersion)
                throw new GameException("stale_version", "状态已更新，请刷新后重新选择行动。", 409);
            RequireActive(campaign);
            CharacterReviews.RequireApproved(campaign);
            GameLifecycle.RequireAction(campaign);
            if (!ContentRuntime.Ready(campaign)) throw new GameException("content_required", "请先导入并启用剧本与提示词包。", 409);

            if (request.Kind == "travel" && campaign.Opening is { PublicSequence: 0 })
                throw new GameException("opening_required", "请先完成入场开场，再离开初始地点。", 409);
            PartyRest.RequirePlayerAction(request.Kind);
            if (request.Kind == "natural") RequireLegacyInput(campaign);
            ContextualRolls.RequireNoPending(campaign);
            // After acquiring the transaction, disconnects must not interrupt a rolled action.
            // All provider calls have server-owned deadlines; the result and receipt commit together.
            Intent? intent;
            var promptCalls = new List<PromptCallTrace>();
            var systemAction = CombatEngine.Kinds.Contains(request.Kind) || (CharacterEngine.Kinds.Contains(request.Kind) || GrowthEngine.Kinds.Contains(request.Kind)) || CombatEngine.Restricted(campaign);
            if (request.Kind == "natural" && (systemAction || campaign.OfflineTrial)) intent = null;
            else if (request.Kind == "natural")
            {
                using var timeout = new CancellationTokenSource(textDeadline);
                try
                {
                    intent = await interpreter.Interpret(request.Text, Adventure.Choices(campaign), timeout.Token, campaign.Id, campaign.Prompts).WaitAsync(timeout.Token);
                    if (intent is not null && !Adventure.Choices(campaign).Any(a => a.Kind == intent.Kind && a.Target == intent.Target))
                        intent = null;
                    promptCalls.Add(new("intent", Binding(campaign.Prompts)!, intent is null ? "no_match" : "matched"));
                }
                catch (Exception ex)
                {
                    promptCalls.Add(new("intent", Binding(campaign.Prompts)!, "unavailable"));
                    logger.LogWarning("Intent interpretation unavailable ({ErrorType})", ex.GetType().Name);
                    intent = null;
                }
            }
            else
            {
                if (!Adventure.Choices(campaign).Any(a => a.Kind == request.Kind && a.Target == request.Target))
                    throw new GameException("action_unavailable", "当前场景不能执行此行动。", 409);
                intent = new(request.Kind, request.Target);
            }

            // New standard-mode rolls always use the consent lifecycle, including callers of
            // the historical direct action endpoint. Existing nonlethal receipts stay unchanged.
            bool standardConsent = intent is not null && StandardCombatEngine.RollDescription(campaign, intent) is not null;
            var resolution = await PrepareAction(campaign, request, intent, deferRoll || standardConsent, systemAction, promptCalls);
            campaign.Receipts.Add(new(request.RequestId, fingerprint, resolution, campaign.ActingActorId));
            return new ActionResponse(Snapshot(campaign), ActionUnderstanding.ForViewer(campaign, resolution), false);
        }, cancellationToken);
    }

    private async Task<Resolution> PrepareAction(Campaign campaign, ActionRequest request, Intent? intent, bool deferRoll, bool systemAction,
        List<PromptCallTrace> promptCalls, string intentId = "", int namingVersion = NpcNames.Version, bool useCurrentBoardMap = true)
    {
        if (intent is not null) PartyRest.RequirePlayerAction(intent.Kind);
        systemAction |= intent is not null && (CombatEngine.Kinds.Contains(intent.Kind) || CharacterEngine.Kinds.Contains(intent.Kind) || GrowthEngine.Kinds.Contains(intent.Kind));
        PrepareBoardCombat(campaign, intent, useCurrentBoardMap);
        if (deferRoll && intent is not null && ContextualRolls.Describe(campaign, intent) is { } description)
        {
            var choices = Adventure.Choices(campaign);
            var choice = ActionInformation.Build(campaign, choices).First(a => a.Kind == intent.Kind && a.Target == intent.Target);
            description += " 目标：" + choice.Details!.TargetLabel + "。消耗：" + choice.Details.Cost + "。";
            var roll = new PendingRoll { Id = Guid.NewGuid().ToString(), ActorId = campaign.ActingActorId,
                Label = choice.Label, Description = description, Version = campaign.Version + 1,
                Action = request, Intent = intent, PromptCalls = promptCalls.ToArray(), IntentId = intentId,
                NpcNamingVersion = intent.Kind == "combat.start" && namingVersion >= NpcNames.Version ? NpcNames.Version : 0,
                UseCurrentBoardMap = intent.Kind == "combat.start" && useCurrentBoardMap };
            if (intent.Kind == "combat.start")
            {
                foreach (var (actor, _) in PartyEngine.Characters(campaign).Where(p => !GameLifecycle.Dead(campaign, p.Id))) ContextualRolls.RequireNoPending(campaign, actor);
                roll = new PendingRoll { Id = roll.Id, ActorId = roll.ActorId, Label = roll.Label, Description = roll.Description,
                    Version = roll.Version, Action = roll.Action, Intent = roll.Intent, PromptCalls = roll.PromptCalls, GroupId = roll.Id, IntentId = intentId,
                    NpcNamingVersion = roll.NpcNamingVersion, UseCurrentBoardMap = roll.UseCurrentBoardMap };
                foreach (var (actor, _) in PartyEngine.Characters(campaign).Where(x => x.Id != campaign.ActingActorId && !GameLifecycle.Dead(campaign, x.Id)))
                    campaign.PendingRolls.Add(new PendingRoll { Id = Guid.NewGuid().ToString(), ActorId = actor, Label = choice.Label,
                        Description = description, Version = roll.Version, GroupId = roll.Id });
            }
            campaign.PendingRolls.Add(roll);
            var waiting = new Resolution("awaiting_roll", "roll.request", "等待投掷：" + choice.Label + "。尚未掷骰或结算消耗。", null, [], RollId: roll.Id, IntentId: intentId);
            campaign.Version++;
            var scene = Adventure.Current(campaign);
            var origin = new ActionOrigin(request.Text, choice.Label, request.Kind, intent.Target, campaign.ActingCharacter.Name,
                scene.Id, scene.Title, [], campaign.ElapsedSeconds, campaign.ElapsedSeconds,
                campaign.PendingIntents.FirstOrDefault(i => i.Id == intentId)?.Clarifications.ToArray());
            campaign.Events.Add(new(Guid.NewGuid().ToString(), campaign.Version, waiting.Kind, waiting.Summary, "", "system", DateTimeOffset.UtcNow,
                waiting, campaign.ActingActorId, promptCalls.ToArray(), origin));
            ActionUnderstanding.Complete(campaign, waiting, origin);
            return waiting;
        }
        return await ExecuteAction(campaign, request, intent, systemAction, promptCalls, intentId: intentId,
            namingVersion: namingVersion, useCurrentBoardMap: useCurrentBoardMap);
    }

    private async Task<Resolution> ExecuteAction(Campaign campaign, ActionRequest request, Intent? intent, bool systemAction,
        List<PromptCallTrace> promptCalls, string rollId = "", string intentId = "", int namingVersion = NpcNames.Version, bool useCurrentBoardMap = true)
    {
        if (intent is not null) PartyRest.RequirePlayerAction(intent.Kind);
        var beforeCharacters = ActivityRecords.Capture(campaign);
        long originTime = campaign.ElapsedSeconds;
        var originScene = Adventure.Current(campaign);
        string originName = campaign.ActingCharacter.Name;
        string originLabel = request.Kind == "natural" || intent is null ? "自由行动" : Adventure.Choices(campaign).FirstOrDefault(a => a.Kind == intent.Kind && a.Target == intent.Target)?.Label ?? intent.Kind;
        PrepareBoardCombat(campaign, intent, useCurrentBoardMap);
        var resolution = intent is null ? Adjudicate(campaign, request.Text) : GrowthEngine.Kinds.Contains(intent.Kind)
            ? growth.Resolve(campaign, intent.Kind, intent.Target) : CharacterEngine.Kinds.Contains(intent.Kind)
            ? characters.Resolve(campaign, intent.Kind, intent.Target) : CombatEngine.Kinds.Contains(intent.Kind)
            ? combat.Resolve(campaign, intent.Kind, intent.Target, namingVersion) : ContentRuntime.IsContentKind(intent.Kind)
            ? ContentRuntime.Resolve(campaign, intent.Kind, intent.Target, rules) : Resolve(campaign, intent);
        if (rollId != "") resolution = resolution with { RollId = rollId };
        if (intentId != "") resolution = resolution with { IntentId = intentId };
        GrowthEngine.AfterAction(campaign, resolution);
        if (resolution.Status == "resolved")
            foreach (var (actor, ch) in PartyEngine.Characters(campaign).ToArray())
                if (resolution.Kind is "travel" or "combat.start" || actor == campaign.ActingActorId && resolution.Kind is not ("rest.hit_die" or "rest.arcane" or "rest.recover"))
                    PartyEngine.SetCharacter(campaign, actor, ch with { ShortRestDiceAvailable = false,
                        PlayState = ch.PlayState is null ? null : ch.PlayState with {PreparationOpen=actor==campaign.ActingActorId&&resolution.Kind=="rest.long"} });
        var linkedIntent = campaign.PendingIntents.FirstOrDefault(i => i.Id == intentId);
        var playerContext = IntentContexts.Player(campaign, request.Text + " " + string.Join(" ", linkedIntent?.Clarifications.Select(x => x.Answer) ?? []));
        var context = new NarrativeContext(playerContext.Situation, campaign.ActingCharacter.Name,
            resolution.Summary, playerContext.RecentActions.Select(e => e.Result).ToArray(), PlayerContext: playerContext);
        Narrative narrative;
        if (campaign.Harness is not null) narrative = new("", "harness");
        else if (campaign.OfflineTrial) narrative = new("", "offline-trial");
        else if (systemAction || !GameLifecycle.CanAct(campaign)) narrative = new("", "system");
        else using (var timeout = new CancellationTokenSource(textDeadline))
        {
            try { narrative = await narrator.Narrate(context, timeout.Token, campaign.Id, campaign.Prompts).WaitAsync(timeout.Token); }
            catch (ProviderQuotaException)
            {
                narrative = new("文本调用额度已用尽；服务端规则结果已保存。额度恢复前可继续使用按钮行动。", "quota");
            }
            catch (Exception ex)
            {
                logger.LogWarning("Narration unavailable ({ErrorType})", ex.GetType().Name);
                narrative = new("叙事服务暂时不可用；请以规则结果为准，冒险进度已保留。", "fallback");
            }
        }
        if (!systemAction && !campaign.OfflineTrial && campaign.Harness is null) promptCalls.Add(new("narration", Binding(campaign.Prompts)!, narrative.Source));
        campaign.Version++;
        if (intentId.Length == 0 && rollId.Length == 0 && request.Text.Length == 0 &&
            request.Kind is "equipment.equip" or "equipment.armor" && resolution.Status == "resolved")
        {
            campaign.StateOnlyVersions.Add(campaign.Version);
            return resolution;
        }
        ActivityRecords.Link(campaign, resolution);
        var origin = new ActionOrigin(request.Text, originLabel, request.Kind, intent?.Target ?? request.Target, originName,
            originScene.Id, originScene.Title, ActivityRecords.Changes(beforeCharacters, campaign), originTime, campaign.ElapsedSeconds, linkedIntent?.Clarifications.ToArray());
        campaign.Events.Add(new(Guid.NewGuid().ToString(), campaign.Version, resolution.Kind,
            resolution.Summary, narrative.Text, narrative.Source, DateTimeOffset.UtcNow, resolution, campaign.ActingActorId, promptCalls.ToArray(), origin));
        if (rollId != "")
        {
            var roll = campaign.PendingRolls.Single(r => r.Id == rollId);
            roll.Result = resolution; roll.ResultOrigin = origin; roll.Narrative = narrative.Text; roll.NarrativeSource = narrative.Source;
        }
        ActionUnderstanding.Complete(campaign, resolution, origin, narrative.Text, narrative.Source);
        if (campaign.Harness is null) await PrepareAutomaticDeathSave(campaign, rollId);
        return resolution;
    }

    private CampaignSnapshot Snapshot(Campaign campaign)
    {
        // Deterministic additive projection; read-only snapshots never persist a refill.
        foreach(var (actor,ch) in PartyEngine.Characters(campaign,includeRevoked:true).ToArray())
            PartyEngine.SetCharacter(campaign,actor,PlayResources.Ensure(ch));
        var scene = Adventure.Current(campaign);
        var asset = assets.Ensure(campaign.Id, scene);
        var choices = campaign.Archived ? [] : Adventure.Choices(campaign);
        var options = ActionInformation.Build(campaign, choices);
        choices = choices.Select(a => options.First(o => o.Kind == a.Kind && o.Target == a.Target)).ToArray();
        return new(campaign.Id, campaign.Name, campaign.Ruleset, campaign.Version, campaign.Chapter,
            PartyEngine.HasCharacter(campaign) ? ProjectPortrait(campaign, campaign.ActingActorId, WearableEquipment.Project(campaign, campaign.ActingCharacter)) : null, new(scene.Id, scene.Title, scene.Summary, asset.Id, true),
            choices, campaign.Events.TakeLast(100).Where(e => ActionUnderstanding.VisibleTo(campaign, e)).Select(e => ActionUnderstanding.ForViewer(campaign, e)).ToArray(), campaign.Facts.ToArray(),
            campaign.VisitedScenes.ToArray(), campaign.PendingRulings.Select(r => ActionUnderstanding.ForViewer(campaign, r)).ToArray(), asset, Adventure.Map(campaign, choices), CombatVisibility.Project(campaign), campaign.ElapsedMinutes, StoryEngine.Snapshot(campaign), campaign.ElapsedSeconds, ProjectPortraits(campaign, PartyEngine.Snapshot(campaign)), campaign.Archived, ContentView(campaign), options, ContextualRolls.View(campaign), ActionUnderstanding.View(campaign), WorldMemories.View(campaign), campaign.AdventureCorrections.ToArray(), WorldMemories.Paging(campaign), campaign.SharedStories?.TakeLast(100).ToArray(), OpeningView(campaign), campaign.TimelineId, GameLifecycle.View(campaign));
    }

    private static Resolution Adjudicate(Campaign campaign, string text)
    {
        var id = Guid.NewGuid().ToString();
        const string reason = "行动存在歧义，或超出当前自动规则范围，需要 DM/系统裁定。未掷骰、未消耗资源、未改动角色。";
        campaign.PendingRulings.Add(new(id, text, "pending", reason, campaign.ActingActorId, campaign.SceneId, CombatEngine.InCombat(campaign) ? campaign.Combat!.Id : ""));
        return new("needs_adjudication", "adjudicate", reason, null, [], id);
    }

    private static Resolution Resolve(Campaign campaign, Intent intent)
    {
        if (intent.Kind == "observe") return new("resolved", "observe", Adventure.Current(campaign).Summary, null, []);
        if (intent.Kind != "travel") throw new GameException("action_unavailable", "此行动尚未支持。", 409);
        var exit = Adventure.Exits(campaign).SingleOrDefault(e => e.Target == intent.Target)
            ?? throw new GameException("action_unavailable", "当前路线已不可用。", 409);
        CharacterEngine.Advance(campaign, exit.Seconds);
        campaign.SceneId = exit.Target;
        campaign.HarnessSceneNarration = null;
        if (!campaign.VisitedScenes.Contains(exit.Target)) campaign.VisitedScenes.Add(exit.Target);
        var scene = Adventure.Current(campaign);
        return new("resolved", "travel", scene.Arrival.Length > 0 ? scene.Arrival : scene.Summary, null, ["scene:" + exit.Target]);
    }

    public static string Text(string? value, int max, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > max || value.Any(char.IsControl))
            throw new GameException("invalid_input", $"{field} 不能为空，长度上限为 {max}，且不能含控制字符。");
        return value.Trim();
    }
    private static void Validate(ActionRequest request)
    {
        if (!Guid.TryParseExact(request.RequestId, "D", out _) || request.ExpectedVersion < 1)
            throw new GameException("invalid_input", "需要合法的 requestId 与 expectedVersion。");
        if (request.Kind is not ("observe" or "investigate" or "talk" or "travel" or "natural") && !CombatEngine.Kinds.Contains(request.Kind) && !ContentRuntime.IsContentKind(request.Kind) && !(CharacterEngine.Kinds.Contains(request.Kind) || GrowthEngine.Kinds.Contains(request.Kind)))
            throw new GameException("invalid_action", "未知的行动类型；复杂行动请使用 natural。");
        if (request.Target is null || request.Text is null || request.Target.Length > 80 || request.Text.Length > 1000 ||
            request.Target.Any(char.IsControl) || request.Text.Any(char.IsControl))
            throw new GameException("invalid_input", "行动内容无效或过长。");
        if (request.Kind == "natural")
        {
            Text(request.Text, 1000, "text");
            if (request.Target.Length != 0) throw new GameException("invalid_input", "自然语言行动不能指定 target。");
        }
        else if (request.Text.Length != 0) throw new GameException("invalid_input", "按钮行动不能携带额外自然语言指令。");
        if (request.Kind is not ("travel" or "combat.move" or "combat.attack" or "combat.cast" or "combat.react" or "combat.stabilize" or "combat.pick_up" or "combat.missile_allocate" or "rest.short") && !ContentRuntime.IsContentKind(request.Kind) && !(CharacterEngine.Kinds.Contains(request.Kind) || GrowthEngine.Kinds.Contains(request.Kind)) && request.Target.Length != 0)
            throw new GameException("invalid_input", "此行动不能指定 target。");
    }
}
