using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// Authoritative, short campaign transactions. No Pi/model await is allowed in these gates.
public sealed partial class GameService
{
    public CreatedCampaign CreateHarness(CreateHarnessCampaignRequest request)
    {
        if (!configuration.GetValue("Harness:Enabled", false)) throw HarnessJson.Conflict("harness_disabled");
        HarnessProfiles.Validate(request.Preset, request.Skills ?? []);
        if (request.Adventure is null) throw new GameException("content_required", "需要明确导入的冒险。");
        var profile = new HarnessProfile(request.Preset, HarnessJson.ProfileHash(request.Preset, request.Skills ?? []), request.Skills ?? []);
        return CreateCore(new(request.Name, request.CharacterName, request.TemplateId, request.Adventure,
            StartImmediately: true, Creation: request.Creation, Build: request.Build), profile);
    }
    private static void RequireLegacyInput(Campaign c)
    {
        if (c.Harness is not null) throw new GameException("harness_input_required", "此战役使用 Harness 输入；旧自然语言入口不会调用另一套模型。确认候选和投掷仍使用原专用入口。", 409);
    }
    public Task<HarnessAuthorization> AuthorizeHarness(string id, string token, CancellationToken ct, CombatRunAuthority? authority = null) =>
        AccessHarness(id, token, false, c => Task.FromResult(new HarnessAuthorization(c.ActingActorId, c.Version,
            c.Harness ?? throw HarnessJson.Conflict("harness_campaign_required"), c.OfflineTrial, AdventureOpenings.Needed(c), c.TimelineId)), ct, authority);

    public Task<AdventureProgressActor[]> AuthorizeHarnessProgress(string id, string token, CancellationToken ct, bool includeRevoked = false) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            if (c.Harness is null) throw HarnessJson.Conflict("harness_campaign_required");
            return Task.FromResult(PartyEngine.Characters(c, includeRevoked).Select(member => new AdventureProgressActor(member.Id, member.Character.Name)).ToArray());
        }, ct);

    public Task<HarnessStartContext> ValidateHarnessStart(string id, string token, int version, CancellationToken ct, string? input = null, bool opening = false) =>
        store.Access(id, token, false, c =>
        {
            RequireIntentContext(c, version);
            if (opening) HarnessOpenings.Require(c);
            else if (AdventureOpenings.Needed(c)) throw HarnessJson.Conflict("opening_required");
            if (ActionUnderstanding.Current(c) is not null) throw HarnessJson.Conflict("intent_pending");
            EnsureBlankGrid(c);
            return Task.FromResult(new HarnessStartContext(workspaces.Get(c).Active, input is null ? HarnessMemories.Build(c) : HarnessLongMemory.ForRun(c, input), localRules.CaptureVersion()));
        }, ct);

    private static void HarnessContext(Campaign c, string actor, int version)
    {
        if (c.ActingActorId != actor || c.Harness is null) throw new GameException("unauthorized", "运行席位无效。", 401);
        if (c.Version != version) throw HarnessJson.Conflict("stale_version");
        RequireActive(c); CharacterReviews.RequireApproved(c);
        // A terminal character may still receive the already-resolved battle ending.
        // This grants no character action: only the combat host's pending narration/queue remains.
        if (!HasCombatNarrationWork(c)) GameLifecycle.RequireAction(c);
        if (!ContentRuntime.Ready(c) || c.OfflineTrial) throw HarnessJson.Conflict("harness_unavailable");
    }
    internal Task ValidateHarnessEmission(HarnessRun run, string token, CancellationToken ct, CombatRunAuthority? authority = null) =>
        AccessHarness(run.CampaignId, token, false, c =>
        {
            CampaignTimeline.Require(c, run.TimelineId);
            HarnessContext(c, run.ActorId, run.Version);
            return Task.FromResult(true);
        }, ct, authority);

    public Task<HarnessToolOutcome> HarnessTool(string id, string token, string actor, string runId, string input,
        int version, string commandId, string fingerprint, HarnessToolRequest request, string[] offeredIds, CancellationToken ct, HarnessProfile frozenProfile,
        int toolContractVersion = 0, bool contextAlreadyRead = false, string[]? offeredMemoryIds = null, string? rulesCatalogVersion = null, BoardMapView? suppliedBoardMap = null,
        string? executionRunId = null, string? combatSessionId = null, CombatRunAuthority? authority = null, bool opening = false, string[]? playerAnswers = null)
    {
        bool write = request.Name is "combat_continue" or "opening_commit" or "combat_delegate" or "encounter_prepare" or "encounter_engage" or "check_request" or "actions_propose" or "world_record" or "narrative_commit" or "ruling_request" or "world_route_propose" or "token_spawn" or "token_move" or "token_update" or "token_remove" or "map_select";
        bool refreshOnly = toolContractVersion >= HarnessExecutionProtocol.Version && !contextAlreadyRead && HarnessExecutionProtocol.RequiresFrame(request.Name);
        return AccessHarness(id, token, write && !refreshOnly, async c =>
        {
            if (c.ActingActorId != actor || c.Harness is null) throw new GameException("unauthorized", "运行席位无效。", 401);
            // The complete original tool output is committed in the SAME transaction as its effects.
            // Recovering the gap before run-journal save must never substitute a newer snapshot.
            if (write && store.FindReceipt(c, commandId) is { } receipt)
            {
                if (receipt.Fingerprint != fingerprint || receipt.HarnessOutput is null) throw HarnessJson.Conflict("idempotency_conflict");
                return HarnessJson.Read<HarnessToolOutcome>(receipt.HarnessOutput.Value);
            }
            if (request.Name == "map_request" && toolContractVersion >= 13 && mapCatalog.AutomaticReceipt(c.Id, actor, commandId, fingerprint) is { } mapReceipt)
            {
                var replay = new HarnessToolOutcome(mapReceipt.Version, new(HarnessJson.Serialize(mapReceipt),
                    IsError: toolContractVersion >= 47 && mapReceipt.Map.Status is "failed" or "withheld" or "unavailable"));
                return toolContractVersion >= HarnessExecutionProtocol.Version ? HarnessExecutionProtocol.Describe(replay, mapReceipt.Version) : replay;
            }
            HarnessContext(c, actor, version);
            if (toolContractVersion >= 36) RequireCombatOwner(c, executionRunId, combatSessionId);
            if (request.Name != "narrative_commit" && !HarnessTools.ForVersion(toolContractVersion).Any(t => t.Name == request.Name))
                throw HarnessJson.Conflict("harness_tool_unavailable");
            if (opening ? !HarnessOpenings.Allows(request.Name, toolContractVersion) : request.Name == "opening_commit")
                throw HarnessJson.Conflict("harness_tool_unavailable");
            HarnessToolOutcome result;
            Resolution? resolution = null;
            if (refreshOnly) return HarnessExecutionProtocol.RefreshRequired(c.Version);
            if (request.Name is "encounter_prepare" or "token_spawn" or "token_move" or "token_update" or "token_remove")
            {
                if (suppliedBoardMap is null) return HarnessExecutionProtocol.RefreshRequired(c.Version);
                var currentMap = toolContractVersion >= 42
                    ? mapCatalog.SelectedPlayerMap(c.Id, c.SceneId, SharedBoard.SelectedMapId(c),
                        allowFallback: !CombatEngine.InCombat(c) || c.Combat?.BoardLayout is null)
                    : BoardMap(c, suppliedBoardMap.Id, publicOnly: true);
                if (currentMap is null || currentMap.Id != suppliedBoardMap.Id || currentMap.Version != suppliedBoardMap.Version ||
                    toolContractVersion >= 42 && currentMap.ContentHash != suppliedBoardMap.ContentHash)
                    return HarnessExecutionProtocol.RefreshRequired(c.Version);
            }
            bool combatAgent = toolContractVersion >= 36 && combatSessionId is not null;
            bool commandNarration = combatAgent && CombatAgentSessions.Require(c, combatSessionId!).Inputs
                .Any(i => i.RunId == executionRunId && i.ActorId == actor && i.Command is not null);
            if (commandNarration && !HarnessCombatCommands.Allows(request.Name))
                return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "harness_tool_unavailable",
                    "此运行只交付已提交命令并续接原战斗队列；实际玩家行动、反应和投掷仍由本人原入口处理。", toolContractVersion);
            if (toolContractVersion >= 36 && !HarnessAgentContexts.Allows(request.Name, combatAgent))
                return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "harness_tool_unavailable", "当前主持角色没有此能力；不要旁路委派或重做已完成步骤。", toolContractVersion);
            if (toolContractVersion >= 49 && combatAgent && HasCombatNarrationWork(c) && request.Name is "actions_propose" or "ask_player" or "ruling_request")
                return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "combat_narration_required",
                    "先用world_record交付当前动作，再按canContinue推进原队列；不能跳过剧情或替玩家行动。", toolContractVersion);
            var context = BuildHarnessContext(c, input, runId, toolContractVersion, combatAgent);
            var candidates = context.Intent.Commands;
            if (request.Name == "opening_commit")
                (result, resolution) = CommitOpening(c, HarnessJson.Read<OpeningNarrativeArgs>(request.Arguments), toolContractVersion);
            else if (request.Name == "context_read" && toolContractVersion >= 23 &&
                HarnessJson.Read<HarnessContextReadArgs>(request.Arguments) is { Scope: not "context" } read)
            {
                if (combatAgent && read.Scope != "character")
                    return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "harness_tool_unavailable", "战斗上下文只支持context/character，不读取探索资料。", toolContractVersion);
                HarnessContextReads.Validate(read, toolContractVersion);
                result = ToolOutcome(c, read.Scope switch
                {
                    "character" => new { version = c.Version, self = HarnessCharacterContext.Capture(c, toolContractVersion) },
                    "scene" => new { version = c.Version, scenePresentation = ScenePresentation(c, context, includeArrival: true) },
                    "supplies" => HarnessSupplyContext.Read(c, read.Offset, read.Limit),
                    _ => HarnessContextReads.Items(c.Version, read, rulesCatalogVersion is null ? null : localRules.Read(rulesCatalogVersion), toolContractVersion)
                });
            }
            else if (request.Name is "context_read" or "actions_list")
            {
                if (toolContractVersion >= 23 && request.Name == "context_read")
                    HarnessContextReads.Validate(HarnessJson.Read<HarnessContextReadArgs>(request.Arguments));
                else HarnessJson.Read<EmptyHarnessArgs>(request.Arguments);
                var ids = candidates.Select(x => x.Id).ToArray();
                // v15 already supplies a frame at model boundaries. An explicit optional read
                // returns full data, rather than referring to a parent-only prior message.
                bool unchanged = toolContractVersion is > 0 and < HarnessExecutionProtocol.Version && ids.Length > 0 && offeredIds.SequenceEqual(ids);
                object output;
                if (request.Name == "actions_list")
                    output = unchanged ? new { version = c.Version, candidatesUnchanged = true }
                        : new { version = c.Version, candidates = context.Intent.Candidates };
                else if (toolContractVersion != 0 && contextAlreadyRead && unchanged)
                    output = new { version = c.Version, contextUnchanged = true, candidatesUnchanged = true };
                else if (unchanged)
                {
                    // Full situation is still needed after a list-only read. Omit only the
                    // already supplied candidates; an omitted list never means no actions.
                    var withoutCandidates = new
                    {
                        intent = new { context.Intent.Text, context.Intent.Clarifications, context.Intent.Context },
                        context.KnownMemory, context.KnownScenes, context.CanNarrate
                    };
                    output = toolContractVersion >= 9 && StandardCombatEngine.IsStandard(c) && (toolContractVersion < 36 || combatAgent)
                        ? new { version = c.Version, candidatesUnchanged = true, context = withoutCandidates, combat = HarnessCombatContext.Read(c, toolContractVersion) }
                        : new { version = c.Version, candidatesUnchanged = true, context = withoutCandidates };
                }
                else output = toolContractVersion >= 9 && StandardCombatEngine.IsStandard(c) && (toolContractVersion < 36 || combatAgent)
                    ? new { version = c.Version, context, combat = HarnessCombatContext.Read(c, toolContractVersion) }
                    : new { version = c.Version, context };
                result = ToolOutcome(c, output, offered: ids);
                if (toolContractVersion >= 3 && request.Name == "context_read")
                    result = result with { OfferedMemoryIds = context.KnownMemory.Select(m => m.Id).ToArray() };
            }
            else if (request.Name == "story_shared_read")
            {
                var args = HarnessJson.Read<HarnessSharedStoryQuery>(request.Arguments);
                if (args.After < 0 || args.Limit is < 1 or > 8) throw new GameException("harness_invalid_payload", "公开消息分页范围无效。");
                result = ToolOutcome(c, SharedStoryPage(c, args.After, args.Limit));
            }
            else if (request.Name is "map_state_read" or "token_read" or "token_spawn" or "token_move" or "token_update" or "token_remove")
                (result, resolution) = ExecuteHarnessBoard(c, runId, input, commandId, request, suppliedBoardMap, toolContractVersion, opening);
            else if (request.Name == "map_select")
            {
                var args = HarnessJson.Read<HarnessMapSelectArgs>(request.Arguments);
                var map = SelectSharedMap(c, args.MapId, args.MapVersion);
                resolution = new("resolved", "map.select", "已切换当前场景共享地图；单位位置未改变。", null, []);
                result = ToolOutcome(c, new { version = c.Version, selectedMapId = map.Id,
                    notice = "Selection only; no units moved and no scale changed. The next model slot provides this map's exact image and metadata before any positional command." });
            }
            else if (request.Name == "check_request")
            {
                if (toolContractVersion >= 44)
                {
                    var args = HarnessJson.Read<HarnessCheckV44Args>(request.Arguments);
                    (result, resolution) = RequestHarnessCheck(c, runId, input, args.Check(), context, toolContractVersion, args.CheckType, args.Reason);
                }
                else
                    (result, resolution) = RequestHarnessCheck(c, runId, input, HarnessJson.Read<HarnessCheckArgs>(request.Arguments), context, toolContractVersion);
            }
            else if (request.Name == "checks_result")
            {
                if (toolContractVersion >= 47)
                {
                    var args = HarnessJson.Read<HarnessCheckReadArgs>(request.Arguments);
                    if (args.Scope is not ("current" or "scene") || args.Offset < 0 || args.Limit is < 1 or > 8 ||
                        args.Scope == "current" && (args.Offset != 0 || args.Limit != 8))
                        throw new GameException("harness_invalid_payload", "检定读取需使用current或scene；只有scene支持分页。");
                    if (args.Scope == "scene") return HarnessExecutionProtocol.Describe(ToolOutcome(c, ReadSceneChecks(c, args)), c.Version);
                }
                else HarnessJson.Read<EmptyHarnessArgs>(request.Arguments);
                var rolls = c.PendingRolls.Where(r => r.IntentId == runId && r.ActorId == actor).TakeLast(8)
                    .Select(r => new { r.Id, r.Status, Result = r.Result is null ? null : CombatVisibility.ForViewer(c, r.Result, publicOnly: true) }).ToArray();
                result = ToolOutcome(c, new { version = c.Version, rolls });
            }
            else if (request.Name == "map_request")
            {
                if (!contextAlreadyRead && toolContractVersion < 14) throw HarnessJson.Conflict("harness_context_required");
                var mapArgs = toolContractVersion >= 42 ? HarnessJson.Read<HarnessMapRequestArgs>(request.Arguments) : null;
                var specification = mapArgs is not null ? HarnessMaps.PublicSpecification(c, mapArgs)
                    : HarnessMaps.PublicSpecification(c, HarnessJson.Read<HarnessMapArgs>(request.Arguments));
                if (!contextAlreadyRead)
                {
                    // Ordering feedback is a completed, side-effect-free tool result, not a
                    // terminal run error. It grants no references and never queues/bills a map.
                    result = new(c.Version, new(HarnessJson.Serialize(new
                    {
                        version = c.Version, status = "context_required", code = "harness_context_required", nextTool = "context_read",
                        message = "Read the current public context, then make a new map_request tool call. No map was requested. Do not repeat completed actions."
                    })));
                }
                else
                {
                    // The provider may return an unoffered tool or the map may have completed
                    // since the model frame. v22 must recheck at the side-effect boundary;
                    // original map receipts above still replay before this capability check.
                    if (toolContractVersion >= HarnessExecutionProtocol.MinimumMapToolVersion)
                    {
                        var status = ReadSceneMapStatus(c, context.KnownScenes.Any(scene => scene.Id == c.SceneId) ? c.SceneId : "");
                        if (toolContractVersion >= 42 ? !status.GenerationEnabled || status.SceneId.Length == 0
                            : status is not { Status: "missing", GenerationEnabled: true })
                            return HarnessExecutionProtocol.RefreshRequired(c.Version);
                    }
                    // Selecting is an existing separately receipted campaign write. Do not
                    // mix it with the image queue commit across two stores: require the DM
                    // to anchor an otherwise implicit current map before requesting another.
                    if (toolContractVersion >= 47 && SharedBoard.SelectedMapId(c) is null &&
                        mapCatalog.SelectedPlayerMap(c.Id, c.SceneId, null) is { } currentMap)
                        return HarnessExecutionProtocol.Describe(new(c.Version, new(HarnessJson.Serialize(new
                        {
                            version = c.Version, code = "map_selection_required", nextTool = "map_select",
                            mapId = currentMap.Id, mapVersion = currentMap.Version,
                            message = "No map was queued. First select this existing current map to keep it displayed while a supplementary map generates; then request the needed map. No player confirmation is needed."
                        }), IsError: true)), c.Version);
                    var map = mapCatalog.RequestAutomatic(c.Id, c.SceneId, c.Version, actor, commandId, fingerprint, specification, adventureLibrary,
                        toolContractVersion, mapArgs is null ? null : HarnessMaps.TacticalExtentFeet(mapArgs));
                    result = ToolOutcome(c, map);
                    if (toolContractVersion >= 47 && map.Map.Status is "failed" or "withheld" or "unavailable")
                        result = result with { Reply = result.Reply with { IsError = true } };
                }
            }
            else if (request.Name == "world_routes")
            {
                var args = HarnessJson.Read<HarnessWorldRouteQuery>(request.Arguments);
                if (args.Offset is < 0 or > WorldRoutes.MaximumRoutes || args.Limit is < 1 or > 16)
                    throw new GameException("harness_invalid_payload", "路线分页参数无效。");
                if (toolContractVersion >= 28)
                {
                    var routes = WorldRoutes.KnownRoutes(c).Skip(args.Offset).Take(args.Limit + 1).ToArray();
                    result = ToolOutcome(c, new { version = c.Version, scope = "current_scene_authored_and_dynamic",
                        routes = routes.Take(args.Limit).ToArray(), nextOffset = routes.Length > args.Limit ? (int?)(args.Offset + args.Limit) : null });
                }
                else
                {
                    var routes = WorldRoutes.View(c).Skip(args.Offset).Take(args.Limit + 1).ToArray();
                    result = ToolOutcome(c, new { version = c.Version, routes = routes.Take(args.Limit).ToArray(),
                        nextOffset = routes.Length > args.Limit ? (int?)(args.Offset + args.Limit) : null });
                }
            }
            else if (request.Name == "world_route_propose")
            {
                if (!contextAlreadyRead) throw HarnessJson.Conflict("harness_context_required");
                if (ActionUnderstanding.Current(c) is not null) throw HarnessJson.Conflict("intent_pending");
                var args = HarnessJson.Read<WorldRouteProposal>(request.Arguments);
                var plan = WorldRoutes.Plan(c, args, (offeredMemoryIds ?? []).ToHashSet(StringComparer.Ordinal),
                    context.KnownScenes.Select(s => s.Id).ToHashSet(StringComparer.Ordinal),
                    c.PendingIntents.FirstOrDefault(i => i.Id == runId)?.RootSequence ?? c.Version + 1);
                var (intent, root) = HarnessRoot(c, runId, input);
                intent.Status = "pending";
                intent.Question = "请核对路线方向、旅行时间与依据。确认只维护路线，不会立即出发。";
                intent.Options = [new("world-route", "确认世界路线", "world", new(WorldRoutes.Description(c, plan),
                    "本次不消耗资源或经过时间", "当前位置关联路线", "后续旅行才按所列时间推进；不生成图片，也不赋予休息或奖励。"), WorldRoute: plan)];
                resolution = new("awaiting_confirmation", "intent.request", intent.Question, null, [], IntentId: intent.Id);
                RecordIntent(c, intent, resolution, root ? "intent.request" : "intent.clarify");
                result = ToolOutcome(c, new { version = c.Version, resolution, pendingIntent = ActionUnderstanding.View(c) }, WaitFor(resolution));
            }
            else if (request.Name == "world_search")
            {
                var found = HarnessWorldSearch.Search(c, HarnessJson.Read<HarnessWorldSearchArgs>(request.Arguments), toolContractVersion);
                result = ToolOutcome(c, found) with { OfferedMemoryIds = found.Entries.Select(m => m.Id).ToArray() };
            }
            else if (request.Name == "ctx_search")
                result = ToolOutcome(c, HarnessHistorySources.Search(c.Version, combatSessionId, CaptureHistorySources(c, runId, combatSessionId, toolContractVersion),
                    HarnessJson.Read<HarnessHistorySearchArgs>(request.Arguments), toolContractVersion));
            else if (request.Name == "ctx_expand")
                result = ToolOutcome(c, HarnessHistorySources.Expand(c.Version, CaptureHistorySources(c, runId, combatSessionId, toolContractVersion),
                    HarnessJson.Read<HarnessHistoryExpandArgs>(request.Arguments), toolContractVersion));
            else if (request.Name == "memory_search")
                result = ToolOutcome(c, HarnessRecall.Search(c, HarnessJson.Read<HarnessMemorySearchArgs>(request.Arguments)));
            else if (request.Name == "memory_semantic_search")
                result = ToolOutcome(c, HarnessLongMemory.Search(c, HarnessJson.Read<HarnessSemanticArgs>(request.Arguments)));
            else if (request.Name == "memory_digest")
                result = ToolOutcome(c, HarnessLongMemory.Digest(c, HarnessJson.Read<HarnessDigestArgs>(request.Arguments)));
            else if (request.Name == "memory_read")
                result = ToolOutcome(c, HarnessRecall.Read(c, HarnessJson.Read<HarnessMemoryReadArgs>(request.Arguments), toolContractVersion));
            else if (request.Name == "rules_search")
                result = ToolOutcome(c, HarnessRules.Search(localRules, rulesCatalogVersion, c.Version, HarnessJson.Read<HarnessRulesSearchArgs>(request.Arguments)));
            else if (request.Name == "rules_read")
                result = ToolOutcome(c, HarnessRules.Read(localRules, rulesCatalogVersion, c.Version, HarnessJson.Read<HarnessRulesReadArgs>(request.Arguments)));
            else if (request.Name == "dm_reference")
                result = ToolOutcome(c, HarnessDmTools.Reference(c.Version, HarnessJson.Read<DmReferenceArgs>(request.Arguments)));
            else if (request.Name == "encounter_plan")
                result = ToolOutcome(c, HarnessDmTools.Encounter(c, localRules.Read(rulesCatalogVersion), HarnessJson.Read<EncounterPlanArgs>(request.Arguments)));
            else if (request.Name == "treasure_generate")
                result = ToolOutcome(c, HarnessDmTools.TreasurePlan(c, runId, localRules.Read(rulesCatalogVersion), HarnessJson.Read<TreasureGenerateArgs>(request.Arguments)));
            else if (request.Name == "encounter_read")
            {
                HarnessJson.Read<EmptyHarnessArgs>(request.Arguments);
                result = ToolOutcome(c, EncounterRead(c, toolContractVersion));
            }
            else if (request.Name == "encounter_prepare")
            {
                if (toolContractVersion >= 46)
                {
                    var args = HarnessJson.Read<HarnessEncounterPrepareV46>(request.Arguments);
                    (result, resolution) = PrepareHarnessEncounter(c, runId, input, args.Preparation(), context, suppliedBoardMap, toolContractVersion, args.EncounterId);
                }
                else
                    (result, resolution) = PrepareHarnessEncounter(c, runId, input, toolContractVersion >= 42
                        ? HarnessJson.Read<HarnessEncounterPrepareV42>(request.Arguments).Preparation()
                        : HarnessJson.Read<HarnessEncounterPrepare>(request.Arguments), context, suppliedBoardMap, toolContractVersion);
            }
            else if (request.Name == "combat_delegate")
                (result, resolution) = DelegateCombat(c, token, executionRunId ?? "", runId, input, HarnessJson.Read<CombatDelegateArgs>(request.Arguments), rulesCatalogVersion, authority, toolContractVersion);
            else if (request.Name == "encounter_engage")
            {
                if (toolContractVersion >= 36 && combatSessionId is null) throw HarnessJson.Conflict("combat_delegation_required");
                (result, resolution) = await EngageHarnessEncounter(c, runId, input, commandId, HarnessJson.Read<HarnessEncounterEngage>(request.Arguments), toolContractVersion);
            }
            else if (request.Name == "combat_continue")
            {
                HarnessJson.Read<EmptyHarnessArgs>(request.Arguments);
                if (!combatAgent || !StandardCombatEngine.CanContinueNarrated(c))
                    return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "combat_narration_required",
                        "原队列当前不能推进；先交付当前动作，或等待实际玩家回应。", toolContractVersion);
                resolution = ContinueCombatNarration(c, runId, input, toolContractVersion);
                result = ToolOutcome(c, new { version = c.Version, resolution = CombatVisibility.ForViewer(c, resolution, publicOnly: true), narration = CombatNarration(c) });
            }
            else if (request.Name == "actions_propose")
            {
                ContextualRolls.RequireNoPending(c);
                var args = HarnessJson.Read<ProposeHarnessArgs>(request.Arguments);
                var selected = offeredIds.Contains(args.CandidateId) ? candidates.FirstOrDefault(x => x.Id == args.CandidateId) : null;
                if (selected is null) throw HarnessJson.Conflict("intent_option_unavailable");
                if (toolContractVersion >= 36 && combatSessionId is null && selected.Action?.Kind == "combat.start")
                    throw HarnessJson.Conflict("combat_delegation_required");
                var (intent, root) = HarnessRoot(c, runId, input);
                intent.Options = [selected]; intent.Status = "pending";
                intent.NpcNamingVersion = toolContractVersion >= NpcNames.Version ? NpcNames.Version : 0;
                intent.UseCurrentBoardMap = toolContractVersion >= 42;
                intent.Question = "请核对目标、来源和成本，再确认此行动。";
                resolution = new("awaiting_confirmation", "intent.request", intent.Question, null, [], IntentId: intent.Id);
                RecordIntent(c, intent, resolution, root ? "intent.request" : "intent.clarify");
                if (InputContinuation.CanExecuteDirectly(c, selected))
                    resolution = await ExecuteIntentOption(c, intent, selected.Id, commandId);
                result = ToolOutcome(c, new { version = c.Version, resolution, pendingRoll = ContextualRolls.View(c), pendingIntent = ActionUnderstanding.View(c) }, WaitFor(resolution));
            }
            else if (request.Name is "world_record" or "narrative_commit")
            {
                ContextualRolls.RequireNoPending(c);
                if (request.Name == "world_record" && CombatEngine.Restricted(c) && toolContractVersion < 35 || ActionUnderstanding.Current(c) is not null) throw HarnessJson.Conflict("harness_mechanical_wait");
                var args = HarnessJson.Read<NarrativeHarnessArgs>(request.Arguments);
                if (commandNarration && args.Complete == false)
                    return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "harness_invalid_payload",
                        "自动命令叙事使用默认complete；原队列未完时服务器会继续，到玩家边界即结束。", toolContractVersion);
                if (toolContractVersion >= 35 && CombatEngine.InCombat(c) && (args.Items is { Length: > 0 } || args.Supplies is { Length: > 0 }))
                    throw new GameException("harness_invalid_payload", "战斗叙述不能同时授予物品或物资；先处理实际战斗。");
                if (args.PrivateMessages is not null && (toolContractVersion < 43 || request.Name != "world_record"))
                    throw new GameException("harness_invalid_payload", "privateMessages 仅供新 world_record 使用。");
                if (args.Private is not null && (toolContractVersion < 16 || request.Name != "world_record")) throw new GameException("harness_invalid_payload", "运行器或工具参数不符合合同。");
                if (args.Items is not null && (toolContractVersion < 18 || request.Name != "world_record")) throw new GameException("harness_invalid_payload", "运行器或工具参数不符合合同。");
                if (args.Complete is not null && (toolContractVersion < 23 || request.Name != "world_record"))
                    throw new GameException("harness_invalid_payload", "运行器或工具参数不符合合同。");
                if (args.Continuity is not null && (toolContractVersion < 23 || request.Name != "world_record"))
                    throw new GameException("harness_invalid_payload", "运行器或工具参数不符合合同。");
                if (args.Supplies is not null && (toolContractVersion < 25 || request.Name != "world_record"))
                    throw new GameException("harness_invalid_payload", "运行器或工具参数不符合合同。");
                NarrativeContinuities.Validate(args.Continuity);
                string privateText = ActionUnderstanding.NormalizePrivate(args.Private, 1024, "harness_invalid_payload");
                var privateMessages = toolContractVersion >= 43 && request.Name == "world_record"
                    ? PrivateStories.Plan(c, args.PrivateMessages, privateText) : null;
                if (combatAgent && (args.Memory.Length != 0 || args.Items is { Length: > 0 } || args.Supplies is { Length: > 0 }))
                    return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "harness_tool_unavailable", "战斗叙事不写探索记忆、物品或补给；实际机械结果由原规则入口保存。", toolContractVersion);
                string narrative = args.PublicText(toolContractVersion, request.Name == "world_record");
                if (toolContractVersion >= 49 && privateMessages?.Any(message => narrative.Length > 0 && message.Text.Trim() == narrative.Trim()) == true)
                    return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "harness_invalid_payload",
                        "私人消息重复了公共正文；仅交付收件人独有的新增信息，无新增请省略。", toolContractVersion);
                if (toolContractVersion >= 49 && combatAgent && CombatNarration(c) is { Pending: true } beat &&
                    beat.Records.Any(record => record.Audience == "public" && record.Kind is not ("initiative" or "scenario" or "turn")) && narrative.Length == 0)
                    return HarnessExecutionProtocol.ArgumentsRejected(c.Version, request.Name, "combat_narration_required",
                        "当前已结算的公开动作尚未交付剧情，不能用空正文推进下一单位。", toolContractVersion);
                var (intent, root) = HarnessRoot(c, runId, input);
                // A narration-only frame cannot decide whether a newly available post-move action completes the original input.
                bool continueInput = toolContractVersion >= 49 && combatAgent && !commandNarration && StandardCombatEngine.NarrationPending(c) &&
                    (root || toolContractVersion >= 53 && c.Combat!.ActiveActorId == actor && c.Combat.Standard!.Wait is null &&
                        c.Combat.Log.Any(e => e.Sequence > c.StandardCombatFlow!.NarratedThrough && e.ActorId == actor && e.Kind == "combat.move"));
                var memoryIds = toolContractVersion >= 3 ? (offeredMemoryIds ?? []).ToHashSet(StringComparer.Ordinal)
                    : context.KnownMemory.Select(m => m.Id).ToHashSet(StringComparer.Ordinal);
                var plan = WorldMemories.Plan(c, args.Memory, memoryIds,
                    context.KnownScenes.Select(s => s.Id).ToHashSet(), intent.RootSequence, "harness", namingVersion: toolContractVersion);
                List<StorySupply>? supplies = null;
                var grants = args.Items;
                if (toolContractVersion >= 25)
                {
                    HarnessContextReads.RejectCatalogProps((args.Items ?? []).Where(i => i is not null).Select(i => (i.ItemId, i.Name))
                        .Concat((args.Supplies ?? []).Where(s => s is not null).Select(s => (s.ItemId, s.Name))),
                        rulesCatalogVersion is null ? null : localRules.Read(rulesCatalogVersion));
                    (supplies, grants) = StorySupplies.Plan(c, intent, args.Supplies, grants, memoryIds);
                }
                if (toolContractVersion >= 26) HarnessItemEvidence.Validate(c, args.Supplies, grants, supplies, memoryIds, plan);
                var inventory = StoryInventory.Plan(c, intent, grants, includeWearables: toolContractVersion >= 21,
                    requireSources: toolContractVersion >= 23, offeredMemoryIds: memoryIds, supplies: supplies);
                resolution = CommitNarrative(c, intent, new("narrate", [], Narrative: narrative, Source: "harness"), plan, root, privateText, inventory,
                    presentDiscoveries: toolContractVersion is >= 40 and < 43 && request.Name == "world_record" && privateText.Length > 0,
                    privateMessages: privateMessages);
                if (toolContractVersion >= 25)
                {
                    if (supplies is { Count: > 0 }) c.StorySupplies = supplies;
                    c.HarnessSceneNarration = new(c.SceneId, c.Version);
                }
                if (args.Continuity is not null) intent.Continuity = NarrativeContinuities.Merge(intent.Continuity, args.Continuity);
                if (toolContractVersion >= 23 && grants is { Length: > 0 })
                    intent.StoryAcquisitions = (intent.StoryAcquisitions ?? []).Concat(grants)
                        .DistinctBy(item => (item.ItemId, item.Name)).ToArray();
                if (toolContractVersion >= 49 && combatAgent) StandardCombatEngine.AcknowledgeNarration(c);
                var deathRoll = toolContractVersion >= 52 && combatAgent
                    ? await PrepareAutomaticDeathSave(c, intentId: commandNarration ? "" : runId) : null;
                result = toolContractVersion >= 53 && combatAgent
                    ? ToolOutcome(c, new { version = c.Version, resolution, narration = CombatNarration(c), inputContinues = continueInput })
                    : toolContractVersion >= 49 && combatAgent
                    ? ToolOutcome(c, new { version = c.Version, resolution, narration = CombatNarration(c) })
                    : toolContractVersion >= 25 && !combatAgent
                    ? ToolOutcome(c, new { version = c.Version, resolution, memory = plan, supplies = HarnessSupplyContext.Read(c) })
                    : ToolOutcome(c, new { version = c.Version, resolution, memory = plan });
                if (toolContractVersion >= 49 && combatAgent && request.Name == "narrative_commit" &&
                    (continueInput || StandardCombatEngine.CanContinueNarrated(c)))
                    result = result with { ContinueCombat = true };
                if (toolContractVersion >= 23 && request.Name == "world_record" && args.Complete != false && !continueInput &&
                    !(toolContractVersion >= 49 && combatAgent && StandardCombatEngine.CanContinueNarrated(c)))
                    result = result with
                    {
                        Reply = result.Reply with { Stop = true },
                        CompletedNarrative = narrative
                    };
                if (deathRoll?.ActorId == actor && !commandNarration)
                    result = result with { Reply = result.Reply with { Stop = true }, Wait = new("roll", deathRoll.Id),
                        CompletedNarrative = null, ContinueCombat = false };
            }
            else if (request.Name == "ruling_request")
            {
                ContextualRolls.RequireNoPending(c);
                var args = HarnessJson.Read<QuestionHarnessArgs>(request.Arguments);
                string reason = Text(args.Question, 240, "question");
                var (intent, root) = HarnessRoot(c, runId, input);
                resolution = ReferIntent(c, intent, reason, root);
                if (toolContractVersion >= 28)
                {
                    int index = c.PendingRulings.FindIndex(r => r.Id == resolution.RulingId);
                    c.PendingRulings[index] = c.PendingRulings[index] with { Reason = reason };
                }
                result = ToolOutcome(c, new { version = c.Version, resolution }, WaitFor(resolution));
            }
            else if (request.Name == "ask_player")
            {
                var args = HarnessJson.Read<QuestionHarnessArgs>(request.Arguments);
                string question = Text(args.Question, 240, "question");
                result = ToolOutcome(c, new { question }, new("player", runId, question));
            }
            else if (request.Name == "skills_list")
            {
                HarnessJson.Read<EmptyHarnessArgs>(request.Arguments);
                result = ToolOutcome(c, frozenProfile.Skills.Select(s => new { s.Id, s.Description }).ToArray());
            }
            else if (request.Name == "skills_read")
            {
                var args = HarnessJson.Read<SkillHarnessArgs>(request.Arguments);
                var skill = frozenProfile.Skills.FirstOrDefault(s => s.Id == args.Id) ?? throw HarnessJson.Conflict("harness_skill_unavailable");
                result = ToolOutcome(c, skill);
            }
            else if (request.Name == "rules_scope")
            {
                HarnessJson.Read<EmptyHarnessArgs>(request.Arguments);
                if (toolContractVersion >= 4)
                {
                    result = ToolOutcome(c, HarnessRules.Scope(localRules, rulesCatalogVersion, c.Ruleset, toolContractVersion));
                }
                else result = ToolOutcome(c, new { ruleset = c.Ruleset, source = "XPHB", mode = "implemented_operations_only",
                    note = "This is server capability metadata, NOT full rules retrieval. Only offered actions can execute. Unsupported mechanics require a ruling; no automatic 2014 fallback." });
            }
            else throw HarnessJson.Conflict("harness_tool_unavailable");
            if (toolContractVersion >= HarnessExecutionProtocol.Version) result = HarnessExecutionProtocol.Describe(result, version);
            HarnessJson.Bound(result);
            // The player's answers to the DM's questions go on record with the action they continue, so the
            // others read what the player actually chose; the questions stay with this seat's run.
            if (write && playerAnswers is { Length: > 0 } && c.PendingIntents.FirstOrDefault(i => i.Id == runId && i.ActorId == actor) is { } asked)
                foreach (var answer in playerAnswers.Skip(asked.Clarifications.Count)) asked.Clarifications.Add(new("", answer));
            if (write) c.Receipts.Add(new(commandId, fingerprint, resolution!, actor, HarnessJson.Element(result)));
            return result;
        }, ct, authority);
    }
    private static (PendingIntent Intent, bool Root) HarnessRoot(Campaign c, string runId, string input)
    {
        var existing = c.PendingIntents.FirstOrDefault(i => i.Id == runId);
        if (existing is not null)
        {
            if (existing.ActorId != c.ActingActorId) throw HarnessJson.Conflict("harness_run_conflict");
            return (existing, false);
        }
        var intent = new PendingIntent { Id = runId, ActorId = c.ActingActorId, Text = input,
            RootSequence = c.Version + 1, Status = "harness", Source = "harness" };
        c.PendingIntents.Add(intent); return (intent, true);
    }
    private static HarnessWait? WaitFor(Resolution r) => r.Status switch
    {
        "awaiting_roll" => new("roll", r.RollId), "awaiting_confirmation" => new("intent", r.IntentId),
        "needs_adjudication" => new("ruling", r.RulingId), _ => null
    };
    private static HarnessToolOutcome ToolOutcome(Campaign c, object data, HarnessWait? wait = null, string[]? offered = null) =>
        new(c.Version, new(HarnessJson.Serialize(data), Stop: wait is not null), wait, offered);

    public Task<HarnessContinuation> HarnessContinue(string id, string token, string actor, string runId, int cursor,
        HarnessWait? wait, HarnessResumeRequest request, CancellationToken ct, string? recoveryCommand = null, string? recoveryFingerprint = null,
        CombatRunAuthority? authority = null, string? combatSessionId = null, string? executionRunId = null) => AccessHarness(id, token, false, c =>
        {
            HarnessContext(c, actor, request.ExpectedVersion);
            if (combatSessionId is not null || authority is not null) RequireCombatOwner(c, executionRunId, combatSessionId);
            if (wait is null)
            {
                if (request.Text != "") throw HarnessJson.Conflict("stale_version");
                if (c.Version != cursor)
                {
                    var receipt = recoveryCommand is null ? null : store.FindReceipt(c, recoveryCommand);
                    if (receipt?.Fingerprint != "harness:" + recoveryFingerprint || receipt.HarnessOutput is null)
                        throw HarnessJson.Conflict("stale_version");
                }
                return Task.FromResult(new HarnessContinuation(cursor, "")); // replay restores the original tool cursor
            }
            if (wait.Kind == "player")
            {
                if (c.Version != cursor && !CombatContinuationAllowed(c, combatSessionId, cursor)) throw HarnessJson.Conflict("stale_version");
                return Task.FromResult(new HarnessContinuation(c.Version, HarnessJson.Serialize(new { playerAnswer = Text(request.Text, 1000, "text") })));
            }
            if (request.Text != "") throw new GameException("invalid_input", "确认结果续接不能携带额外指令。");
            Resolution? result;
            if (wait.Kind == "roll")
            {
                var roll = c.PendingRolls.FirstOrDefault(r => r.Id == wait.Id && r.ActorId == actor && r.IntentId == runId)
                    ?? throw HarnessJson.Conflict("roll_unavailable");
                if (roll.Status == "pending") throw HarnessJson.Conflict("harness_waiting_consent");
                result = roll.Result;
            }
            else if (wait.Kind == "intent")
            {
                var intent = c.PendingIntents.FirstOrDefault(i => i.Id == wait.Id && i.Id == runId && i.ActorId == actor)
                    ?? throw HarnessJson.Conflict("intent_unavailable");
                if (intent.Status == "pending") throw HarnessJson.Conflict("harness_waiting_consent");
                result = intent.Result;
            }
            else if (wait.Kind == "ruling")
            {
                var ruling = c.PendingRulings.FirstOrDefault(r => r.Id == wait.Id && r.ActorId == actor)
                    ?? throw HarnessJson.Conflict("ruling_unavailable");
                if (ruling.Status is "pending" or "awaiting_roll") throw HarnessJson.Conflict("harness_waiting_consent");
                result = c.Events.LastOrDefault(e => e.Resolution?.RulingId == ruling.Id)?.Resolution;
            }
            else throw HarnessJson.Conflict("harness_invalid_wait");
            if (result is null) throw HarnessJson.Conflict("harness_result_unknown");
            // Only the exact confirmed result may move this run's version cursor. A later unrelated
            // write cannot silently rebase the original action, even if the client knows the new version.
            var last = c.Events.LastOrDefault();
            if (last?.Sequence != c.Version || last.Resolution is not { } lastResult ||
                !(lastResult.IntentId == runId || wait.Kind == "ruling" && lastResult.RulingId == wait.Id || CombatContinuationAllowed(c, combatSessionId, cursor)))
                throw HarnessJson.Conflict("stale_version");
            return Task.FromResult(new HarnessContinuation(c.Version, HarnessJson.Serialize(new { confirmedResult = CombatVisibility.ForViewer(c, result, publicOnly: true) }),
                WaitFor(result), result.Status == "cancelled"));
        }, ct, authority);
}

public sealed record EmptyHarnessArgs;
public sealed record ProposeHarnessArgs(string CandidateId);
public sealed record SkillHarnessArgs(string Id);
public sealed record QuestionHarnessArgs(string Question);
public sealed record NarrativeHarnessArgs(string Narrative, WorldMemoryProposal[] Memory,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? Private = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] StoryItemGrant[]? Items = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] bool? Complete = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] NarrativeContinuityEntry[]? Continuity = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] StorySupplyProposal[]? Supplies = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string[]? Paragraphs = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] PrivateMessageRequest[]? PrivateMessages = null)
{
    public string PublicText(int contract, bool worldRecord = true)
    {
        if (Paragraphs is null) return contract >= 43 && worldRecord && Narrative is not null && Narrative.Trim().Length == 0
            ? "" : WorldMemories.Text(Narrative, 4096, multiline: true);
        if (contract < 34 || !worldRecord || Narrative != "" || Paragraphs.Length > 20 || contract < 43 && Paragraphs.Length < 1)
            throw new GameException("harness_invalid_payload", "段落与正文只能采用一种表示。");
        if (contract >= 43 && Paragraphs.Length == 0) return "";
        return WorldMemories.Text(string.Join("\n\n", Paragraphs.Select(p => WorldMemories.Text(p, 4096, multiline: true))), 4096, multiline: true);
    }
}
public sealed record HarnessWorldRouteQuery(int Offset = 0, int Limit = 8);
