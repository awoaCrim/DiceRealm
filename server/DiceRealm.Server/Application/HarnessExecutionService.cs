using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    // Uses the same public projection and short authorization gate as context_read. No
    // provider call, command, receipt or campaign write is performed by preparing a frame.
    // Local image rendering happens only after the authorized immutable capture leaves the gate.
    public async Task<HarnessExecutionFrame> ReadHarnessExecution(string id, string token, string actor,
        string intentId, string input, int version, CancellationToken ct, int toolContractVersion = HarnessExecutionProtocol.Version, bool? hasImportedSkills = null,
        string? executionRunId = null, string? combatSessionId = null, CombatRunAuthority? authority = null, bool opening = false, string? rulesCatalogVersion = null)
    {
        var captured = await AccessHarness(id, token, false, c =>
        {
        HarnessContext(c, actor, version);
        if (toolContractVersion >= 36) RequireCombatOwner(c, executionRunId, combatSessionId);
        bool combatAgent = toolContractVersion >= 36 && combatSessionId is not null;
        var session = combatAgent ? CombatAgentSessions.Require(c, combatSessionId!) : null;
        var people = combatAgent ? StoryEngine.Snapshot(c).Npcs.Where(n => n.SceneId == c.SceneId).ToArray() : [];
        var completedSessions = !combatAgent && toolContractVersion >= 36
            ? (c.CombatAgentSessions ?? []).Where(s => s.ReturnConsumed && s.Members.Contains(actor)).Select(s => s.Id).ToArray() : [];
        var agent = toolContractVersion >= 36 ? new HarnessAgentContext(combatAgent ? "combat" : "exploration", session?.Id,
            session?.EncounterId ?? CombatAgentSessions.DelegatableEncounter(c, includeActive: toolContractVersion >= 37)?.Id, session?.ParentActorId == actor ? session.Handoff : null,
            combatAgent ? people.Take(6).Select(n => new CombatAgentPerson(n.Id, n.Name, IntentContexts.Bounded(n.Summary, 240))).ToArray() : null,
            people.Length, session?.Handoff.SourceAfter, combatAgent ? null : completedSessions.TakeLast(4).ToArray(), completedSessions.Length) : null;
        if (toolContractVersion >= 49 && combatAgent)
            agent = agent! with
            {
                Narration = CombatNarration(c),
                Command = toolContractVersion >= 51 && session!.Inputs.SingleOrDefault(i => i.RunId == executionRunId && i.ActorId == actor)?.Command is { } command
                    ? new(command, HarnessCombatCommands.Instruction) : null
            };
        if (toolContractVersion >= 39)
            agent = agent! with { CombatPromptReady = combatAgent || HarnessCombatPrompts.Resolve(workspaces.Get(c).Active.Preset, toolContractVersion) is not null };
        if (toolContractVersion >= 37 && !combatAgent && authority?.ReturnId is { } returnId &&
            (c.CombatAgentSessions ?? []).SingleOrDefault(s => s.Id == authority.SessionId && s.ParentRunId == executionRunId &&
                s.ParentIntentId == intentId && s.ReturnConsumed && s.Return?.Id == returnId) is { } returned)
            agent = agent! with { AfterCombat = new(returned.Id, returnId, returned.Return!.Version, HarnessAgentContexts.AftermathInstruction) };
        if (!HarnessTools.Supports(toolContractVersion) || toolContractVersion < HarnessExecutionProtocol.Version)
            throw HarnessJson.Conflict("harness_tool_contract");
        // v15-v18 frames retain their old candidate family and bytes. Only v19 observes
        // the new weapon-selection candidates and receives the complete self projection.
        int projectionVersion = toolContractVersion >= HarnessCharacterContext.MinimumToolVersion ? toolContractVersion : HarnessExecutionProtocol.Version;
        var context = BuildHarnessContext(c, input, intentId, projectionVersion, combatAgent);
        var combat = StandardCombatEngine.IsStandard(c) && (toolContractVersion < 36 || combatAgent)
            ? HarnessJson.Element(HarnessCombatContext.Read(c, projectionVersion)) : (System.Text.Json.JsonElement?)null;
        var self = toolContractVersion >= HarnessCharacterContext.MinimumToolVersion ? HarnessCharacterContext.Capture(c, toolContractVersion) : null;
        var map = toolContractVersion >= HarnessExecutionProtocol.MinimumMapToolVersion
            ? ReadSceneMapStatus(c, context.KnownScenes.Any(scene => scene.Id == c.SceneId) ? c.SceneId : "") : null;
        var working = toolContractVersion >= 23 && !combatAgent ? HarnessSceneContexts.Build(c, context, toolContractVersion) : null;
        if (toolContractVersion >= 26 && working is not null) working = working with { Guidance = working.Guidance + HarnessItemEvidence.Guidance };
        bool? detailed = toolContractVersion >= 23 ? combatAgent || CombatEngine.Restricted(c) ||
            (c.PendingIntents.FirstOrDefault(i => i.Id == intentId)?.HarnessSteps ?? []).Any(s => s.Result.Kind != "narrative") : null;
        HarnessScenePresentation? presentation = null;
        if (toolContractVersion >= 24 && !combatAgent)
        {
            var steps = c.PendingIntents.FirstOrDefault(i => i.Id == intentId)?.HarnessSteps ?? [];
            bool observed = steps.Any(s => s.Result.Kind is "observe" or "travel" && s.Sequence > (c.HarnessSceneNarration?.Version ?? 0));
            presentation = ScenePresentation(c, context, toolContractVersion >= 56 || toolContractVersion < 25 || c.HarnessSceneNarration?.SceneId != c.SceneId || observed,
                scoped: toolContractVersion >= 25);
        }
        var board = toolContractVersion >= 27 && context.KnownScenes.Any(scene => scene.Id == c.SceneId)
            ? CaptureHarnessBoard(c, toolContractVersion) : (Context: HarnessBoardContext.Unavailable(c.Version, working?.SceneId ?? ""), Png: Array.Empty<byte>());
        if (toolContractVersion >= 42 && board.Context.Maps is null)
            board = (board.Context with { Maps = [] }, board.Png);
        if (toolContractVersion >= 28 && working is not null)
            working = working with { Guidance = working.Guidance + (toolContractVersion == 29
                ? " 日常交谈、可见信息与非机械观察直接回应，不因风险描述额外要求检定或人工审批；完整符合本轮意图的作者行动优先用现有候选，缺意图/目标先问玩家。以下遭遇信息只说明执行能力，不表示攻击已经发生；威胁、潜在敌人或缺少配置本身都不触发裁定。只有真实未覆盖机械事件或需要人工判断的具体纠错才升级。"
                : "") + EncounterGuidance(c, context, board.Context, toolContractVersion) };
        if (toolContractVersion >= 42 && working is not null)
            working = working with { Guidance = working.Guidance + " 每张图的用途、像素格距、真实距离和比例依据分别保存，以本帧board.state.map与图像为准；用途/图片大小/人物外观均不能推断尺度。board.maps列出当前公开图，选图用map_select，不移动任何实例。开战只用已校准局部tactical图；城镇已ready仍可按需map_request purpose=tactical，复用已有合格局部图优先。新局部图采用本场最长边物理范围（默认120 feet，可显式10至160），按实际成品尺寸落DM依据，非来源测绘；不继承风格图比例。明确选新图后沿用原existingId并给各单位有依据的新落点，不复制旧归一化坐标；旧图位置和HP/资源保留。encounter_prepare不再接独立grid像素参数，由服务器按实际尺度细分5尺且保持物理长度。先攻/隐藏骰、本人确认和发现呈现沿原路径；实际交锋委派combat_delegate，准备不自动开战。" };
        else if (toolContractVersion >= 39 && working is not null && agent?.CombatPromptReady == false)
            working = working with { Guidance = working.Guidance + " 独立战斗配置缺失只限制战斗委派，不应重建已准备遭遇或撤销真实检定。仍可承接普通交谈、实际发现及已保存位置；不要请求玩家批准位置。" };
        else if (toolContractVersion >= 36 && working is not null)
            working = working with { Guidance = working.Guidance + " 已有作者明确数字DC仍走原检定。缺少伏兵Stealth结果时，先encounter_read核对2024来源，必要时encounter_prepare保存战术标尺、地形与实际单位并由服务端掷隐藏骰；主动搜寻用check_request关联encounterId和原sourceId/quote、Wisdom/Perception，不传无依据dc，等待本人确认。个人发现只写private，未发现单位和骰点不得公开。已有布置不可重建或重掷；实际交锋交给combat_delegate，尚未交锋仍由探索主持。普通靠近沿本人token工具，无第二次确认。" };
        else if (toolContractVersion >= 35 && working is not null)
            working = working with { Guidance = working.Guidance + " 当前遭遇能力：已有作者明确数字DC仍走原检定。场景确有伏兵但缺少Stealth结果时，可encounter_read选已验证2024来源，encounter_prepare保存显式战术标尺/地形/各实际敌人并由服务端掷隐藏骰；随后check_request传encounterId、原sourceId/quote、Wisdom/Perception且不传dc，主动搜寻等待本人确认。encounter_read读取真实发现，个人结果只写private，不把未发现名单或骰点写公开。仅在确实发生敌对交锋时encounter_engage，沿原本人先攻确认与规则引擎，不能靠发现敌人自动开战。普通靠近仍用本人token工具，无第二次确认；不重复读取已给资料、不把找伏兵换成找足迹。" };
        else if (toolContractVersion >= 34 && working is not null)
            working = working with { Guidance = working.Guidance + " 当前检定分流：完整匹配本轮目标的作者行动优先；其他场景检定可引用资料明确给出的DC。目标需要阈值而当前资料没有时，直接ruling_request说明具体缺口；不先掷无法判定的骰子，不把寻找伏兵换成寻找足迹，也不重复读取已经提供的场景或能力说明。仅为查找尚未提供的具体资料才查询。普通靠近按原输入语义执行本人token_spawn/token_move，无需第二次确认；原地观察不移动。" };
        else if (toolContractVersion >= 31 && working is not null)
            working = working with { Guidance = working.Guidance + " 本轮普通靠近/查看由DM按原输入语义判断，不要求玩家改写成坐标。已提供地图时用实际token_spawn/token_move同步本人位置，再接作者调查；无位置依据先自然澄清，不假装已经走到。原地观察不移动。主动搜寻可用check_request进入本人投掷，不需人类主持再填表。复合行动须完成全部所需步骤或明确等待后才结束；局部作者动作不是整句完成。" };
        if (toolContractVersion >= 44 && working is not null)
            working = working with { Guidance =
                "AI DM按行动、环境或NPC事件主动发起检定/豁免，不等玩家要求；明显信息不掷，无check动作仅结算局部。无作者DC时先定DC5..30和私有reason，不转人工。真实对抗仍用原encounterId/sourceId/quote、Perception且无dc；普通检定不授隐藏发现。实际投掷须本人确认，已存结果不重掷。" +
                " 省略不表示不存在；人物出处见Sources/RelatedEvidenceIds，DM-only仅供推理，模型记录不自证。" + HarnessItemEvidence.Guidance +
                " privateMessages按实际知情者交付，可多人/非行动者；公私可空，不编秘密或提示私信。未知目标/计划/未来不给玩家，失败不反向透露。discoveryIds只释放各收件人已知目标，私聊/转述不授位置；本人旧知识保留归属。" +
                " 地图用途/比例独立，使用当前同版图片与真实尺度。map_select不移动；复用局部tactical图，城镇ready不阻止补图。跨图复用原existingId及新依据落点，不复制坐标或重置状态；按实际比例派生五尺格。" +
                EncounterGuidance(c, context, board.Context, toolContractVersion) };
        else if (toolContractVersion >= 43 && working is not null)
            working = working with { Guidance =
                "局部资料省略不表示不存在；人物Sources[0]是摘要来源，RelatedEvidenceIds可查原文。DM-only只供主持推理，不是玩家已知；模型记录不自证事实。" + HarnessItemEvidence.Guidance +
                " 信息交付用privateMessages，实际收件人与行动者独立，可一人或多席位。公私都可空，不编秘密或公开私发提示。公共现象与个人认识分开；职业本身不是依据，未发现目标、主持计划或未来剧情不给玩家，失败不反向透露目标。discoveryIds只释放每位recipient已KnownTo的对应待呈现目标；私聊/转述不授位置或其他发现。KnownInformation保留本人已知正文与公开说话的归属；省略不是未知。" +
                " 逐图用途与真实比例独立，以board.state.map及同版图像为准。map_select不移动；复用局部校准tactical图优先，城镇ready不阻止补局部图。补图范围是DM示意依据，不继承风格图尺度。跨图用原existingId和新依据落点，不复制归一坐标、不重置旧图/HP；开战按实际比例派生五尺格。" +
                EncounterGuidance(c, context, board.Context, toolContractVersion) };
        if (toolContractVersion >= 46 && working is not null)
            working = working with { Guidance = working.Guidance.Replace(
                "地图用途/比例独立，使用当前同版图片与真实尺度。map_select不移动；复用局部tactical图，城镇ready不阻止补图。跨图复用原existingId及新依据落点，不复制坐标或重置状态；按实际比例派生五尺格。",
                "侦察不依赖地图校准/用途：初次encounter_prepare省略encounterId、terrain=[]，先存隐匿再check_request，不为此补图。实际开战才用原encounterId绑定校准tactical布局；保留名单/来源/HP/隐匿/发现，省略hiding字段。map_select不移动；跨图原实例用新依据落点，不复制坐标，尺度以同版图为准。", StringComparison.Ordinal) };
        // v56 moves this routing text into the checklist: adding it to the longer
        // unbound-encounter guidance exceeds the existing 1000-character field bound.
        if (toolContractVersion == 55 && working is not null)
            working = working with { Guidance = working.Guidance + " 需要时直接调用内置主持工具：dm_reference查询2024检定、物件、陷阱和危险；encounter_plan按实际队伍规划遭遇；treasure_generate生成2024战利品方案。无需让用户打开参考网页或查看来源。规划不代表场景存在该敌人/奖励，不授予物品或改写战斗；后续用已有执行工具，未覆盖规则不假装自动结算。" };
        var frame = HarnessExecutionProtocol.Capture(c.Version, context, combat, self, toolContractVersion, map, working, detailed,
            toolContractVersion is >= 23 and < 45 ? HarnessWorkingMemories.Build(c, input, intentId, toolContractVersion < 36 ? null :
                candidate => !combatAgent && !(c.CombatAgentSessions ?? []).Any(s => s.Inputs.Any(i => i.IntentId == candidate.Id))) : null, presentation,
            toolContractVersion >= 24 ? hasImportedSkills ?? c.Harness?.Skills.Length > 0 : null,
            toolContractVersion >= 25 && !combatAgent ? HarnessSupplyContext.Read(c) : null, toolContractVersion >= 27 ? board.Context : null, agent);
        if (toolContractVersion >= 45)
        {
            var history = CaptureHistory(c, intentId, combatSessionId, toolContractVersion);
            frame = frame with { HistoryCapture = history,
                History = HarnessHistoryContexts.Build(c.Version, actor, history, input, working?.People ?? [], toolContractVersion: toolContractVersion) };
        }
        if (toolContractVersion >= 38)
            frame = frame with { SharedStories = HarnessStoryContext.Capture(c, toolContractVersion), NarrativeContract = HarnessStoryContext.ForVersion(toolContractVersion) };
        if (toolContractVersion >= 43)
            frame = frame with { KnownInformation = HarnessKnownInformations.Capture(c, input, store.ReadPrivateStoryEvents(c)) };
        if (toolContractVersion >= HarnessDmChecklist.MinimumToolVersion)
            frame = frame with { DmChecklist = HarnessDmChecklist.Capture(c, intentId, input, toolContractVersion, combatAgent) };
        if (opening) frame = HarnessOpenings.Restrict(frame, HarnessOpenings.Capture(c, generating: true, toolContractVersion), toolContractVersion);
        else if (toolContractVersion >= 38 && c.Opening is not null) frame = frame with { Opening = HarnessOpenings.Capture(c, generating: false, toolContractVersion) };
        if (toolContractVersion >= 56 && !combatAgent && !opening)
            frame = HarnessReadPreloads.Capture(frame, EncounterRead(c, toolContractVersion),
                HarnessRules.Scope(localRules, rulesCatalogVersion, c.Ruleset, toolContractVersion));
        return Task.FromResult((Frame: frame, board.Png));
        }, ct, authority);
        ct.ThrowIfCancellationRequested();
        return captured.Frame.Board is { } board ? captured.Frame with { Board = RenderHarnessBoard(board, captured.Png) } : captured.Frame;
    }

    // v58: found in the real-model playtest, where the DM took encounter_plan's executableProfileId note
    // (meant for encounter_prepare) as a reason the authored bandits could not fight, and asked the host.
    public const string AuthoredEncounterRule = " 这场遭遇由剧本写定，敌人数值随遭遇保存，可以直接委派；encounter_plan的executableProfileId只限encounter_prepare新建敌人，与它无关，不能因此转交裁定。委派前当前战术图上须有全部队员和本遭遇敌人的站位：缺的先用token_spawn从board.sources按场景描述摆好，已有的不动。";
    private string EncounterGuidance(Campaign c, AdventureContext context, HarnessBoardContext board, int contract)
    {
        const string outcomes = " NPC决定实际攻击后先进入该流程；未有回执不得写命中、射空、挡下、闪避成功或成功撤离。";
        if (contract >= 39 && HarnessCombatPrompts.Resolve(workspaces.Get(c).Active.Preset, contract) is null)
            return "当前未采用独立战斗主持提示词，无法委派战斗。不要重建遭遇、重掷、用探索提示词代打或编造交锋结果。缺项由主持工作台的主持要求→战斗主持保存并应用；保留实际位置与已结算结果。普通探索仍可继续；实际交锋须明确说明当前不能结算，不假装仍在生成。";
        if (contract >= 37 && CombatEngine.InCombat(c) && CombatAgentSessions.DelegatableEncounter(c, includeActive: true) is { } existing)
            return "当前已有真实战斗，但尚无独立战斗主持归属。用combat_delegate encounterId=" + existing.Id +
                "接续这场战斗，保留原先攻、HP、回合、站位和隐藏骰。不是重新开战，不调用encounter_prepare或重掷先攻；子代理从当前回合继续。";
        if (contract >= 51 && RuntimeEncounters.Current(c) is { Layout: null } unbound)
            return "原遭遇=" + unbound.Definition.Id + "，布局未绑定。沿用已存名单、隐匿、发现和实际玩家位置。实际交锋先检查当前board.state.map是否为合格tactical图；已有正确选择不再map_select，已有正确玩家位置不再移动。只缺布局时用原encounterId绑定，再combat_delegate；仅缺合格图时请求新图，不重建遭遇或重掷。" + outcomes;
        if (contract >= 47 && RuntimeEncounters.Current(c) is { Layout: null } pending)
            return "原遭遇=" + pending.Definition.Id + "，布局未绑定。侦察已结算则沿用，不因新输入或换图重掷。实际攻击时复用board.maps中ready的tactical图，map_select→原玩家落点→原encounterId绑定→combat_delegate。无合格图才请求一次tactical图，服务端等其完成；不轮询模型或提前委派。" + outcomes;
        if (contract >= 46 && RuntimeEncounters.Current(c) is { Layout: null } observation)
            return "已保存真实遭遇及隐匿 encounterId=" + observation.Definition.Id + "；可直接继续必要侦察，地图校准不影响检定。仅在实际交锋时先用原encounterId绑定战术布局再combat_delegate；不要重建敌人或重掷。" + outcomes;
        if (contract >= 36) return CombatAgentSessions.DelegatableEncounter(c) is { } available
            ? "真实交锋先combat_delegate encounterId=" + available.Id + "，委派整场战斗后由独立子会话进入先攻；探索代理不直接开战。必要交接保留动机、关系、原话和未完成原意图。" +
                (contract >= 58 && ContentRuntime.Scene(c)?.Encounter?.Id == available.Id ? AuthoredEncounterRule : "") + outcomes
            : "当前尚无已建立的遭遇；先核实资料并按实际需要准备，不能以威胁或发现直接触发战斗。";
        if (CombatEngine.InCombat(c)) return " 当前遭遇：已有战斗，使用本帧实际行动/等待，不另起遭遇。" + outcomes;
        if (contract >= 35 && ContentRuntime.Scene(c)?.Encounter is null)
            return RuntimeEncounters.Current(c) is null
                ? " 当前场景尚未建立机械遭遇；有可靠场景依据时可用encounter_prepare建立，不能省略实际摆位、标尺和地形。" + outcomes
                : " 当前场景已有运行时布置，使用encounter_read读取原隐匿/发现；不可重建或重掷敌人。真实敌对交锋用encounter_engage。" + outcomes;
        var start = context.Intent.Commands.FirstOrDefault(candidate => candidate.Action?.Kind == "combat.start");
        if (start is not null && ContentRuntime.AvailableEncounter(c) is { } encounter)
        {
            try
            {
                _ = BoardCombat.Prepare(c, encounter, board.State is null ? null : BoardMap(c, board.State.Map.Id, publicOnly: true));
                return " 当前遭遇入口：actions_propose candidateId=" + start.Id + "；仍按原本人确认与投掷流程。" + outcomes;
            }
            catch (GameException error) when (error.Code.StartsWith("board_combat_", StringComparison.Ordinal))
            {
                // Do not expose hidden participant identities or private preparation details.
                return " 当前遭遇：共享棋盘的实际实例、标定或执行资料不满足自动战斗；攻击入口=ruling_request。公开棋子不能补造机械资料。" + outcomes;
            }
        }
        return " 当前遭遇：没有可用自动开战候选；攻击入口=ruling_request，保留实际单位/位置供裁定，不替换规则版本。" + outcomes;
    }

    private static HarnessScenePresentation ScenePresentation(Campaign c, AdventureContext context, bool includeArrival, bool scoped = true)
    {
        var scene = ContentRuntime.Ready(c) && c.VisitedScenes.Contains(c.SceneId) && context.KnownScenes.Any(s => s.Id == c.SceneId)
            ? Adventure.Current(c) : null;
        return new(scene?.Id ?? "", scene?.Title ?? "", scene?.Summary ?? "", includeArrival ? scene?.Arrival ?? "" : "",
            scoped
                ? "Current visited scene only; summary and public evidence are current context. Arrival is supplied only for a new entry, settled observation/travel or explicit scene read. Omitted entry prose is not absence of scenery. context_read scope=scene reads it when needed. Current state and later established events take precedence; history is evidence, not a style sample."
                : "Current visited scene only. Arrival is imported public entry narration, not a new event or a claim that past conditions persist. CurrentSummary reflects the current authored variant; current state and subsequent established events take precedence. Other scenes and private source are not included.");
    }

    private static AdventureContext BuildHarnessContext(Campaign c, string input, string intentId, int contract, bool combatAgent = false)
    {
        var candidates = IntentContexts.SelectCandidates(ActionUnderstanding.Candidates(c, contract >= 8, intentId,
            contract >= 9, contract >= 10, contract >= 11, includeRecording: contract < 12,
            includeWeaponSelection: contract >= HarnessCharacterContext.MinimumToolVersion, includeLoadout: contract >= 20, includeWearables: contract >= 21), input);
        if (contract >= 36) candidates = candidates.Where(candidate => HarnessAgentContexts.Candidate(candidate, combatAgent)).ToArray();
        if (contract >= 49 && combatAgent && (HasCombatNarrationWork(c) ||
            CombatAgentSessions.Current(c)?.Inputs.Any(i => i.IntentId == intentId && i.Command is not null) == true)) candidates = [];
        var intent = IntentContexts.Build(c, input, [], candidates, combatAgent);
        if (combatAgent) return new(intent, [], [new(c.SceneId, IntentContexts.Bounded(Adventure.Current(c).Title, 100))], true);
        return AdventureDirecting.Build(c, intent);
    }
}
