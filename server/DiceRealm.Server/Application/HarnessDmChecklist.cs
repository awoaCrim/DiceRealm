using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record HarnessPendingOperation(string Kind, string Id, string Status);
public sealed record HarnessProgressReceipt(string StepId, string Tool, int Version, bool IsError,
    bool? Applied, HarnessWait? WaitAtCall);
public sealed record HarnessRulingProgress(string Id, string Status, string Outcome, string Rationale,
    string RollId, DiceCheck? Check, CharacterChangeView[] Effects, StorySettlement? Story);
public sealed record HarnessActionProgress(string IntentId, string ActorId, int Version,
    HarnessActionStep[] RecordedSteps, HarnessPendingOperation[] Pending, HarnessRulingProgress[] Rulings,
    HarnessProgressReceipt[] ToolReceipts, string Notice);

// One versioned, parent-owned operating contract per provider request. Never appended to
// the SDK transcript, imported system prompt, tool results or player-visible narrative.
public sealed record HarnessDmChecklist(string Instructions, HarnessActionProgress Progress)
{
    public const int MinimumToolVersion = 30;
    public const string ProgressNotice = "这是本次行动的权威记录，不是重新生成的行动计划。recordedSteps保留实际结果与当时的消耗，rulings保留精确关联的主持裁定及实际检定/后果（它们不一定写入原行动步骤）；toolReceipts只表示工具调用已处理，applied=true也可能只是读取或进入等待，不代表整项行动成功。waitAtCall是当时的等待，当前是否仍在等待只看pending和最新状态。空步骤不表示无需移动/检定，空pending不表示组合意图已经全部完成。结合原始输入、后续玩家答复、回执和当前board/combat/self判断尚需处理的部分，不重做已有成功结果。";
    // v30 is immutable for saved runs. Changes to this operating contract require a new
    // tool-contract version, just like descriptions and other per-model-slot projections.
    public const string Text = """
        # 本次调用：完整主持行动检查

        你负责理解玩家的完整行动，并判断如何处理；玩家不需要额外提醒你移动棋子、申请检定、切换战斗、设置信息范围或保存结果。
        根据玩家原意、最新权威状态、当前地图与单位、相关作者资料及本次行动已有的工具回执，检查以下六项。检查用于决定实际处理方式，不向玩家输出检查清单或分析过程。
        每项都要考虑是否适用，但只执行本次确实需要的操作。这些是检查维度，不是固定执行顺序；已完成的步骤不要重新执行。

        一、行动意图

        识别玩家实际要做什么、针对谁或什么、行动范围以及明确限制。保留一句话中的多个相关步骤，不把完整行动压成最接近的一个按钮。
        “上前查看”可能包含接近与查看；“原地警戒”不包含移动；查询能否攻击不等于已经实施攻击。候选动作只有在完整含义、范围和后果符合玩家意图时才能使用。
        不擅自添加玩家的承诺、接受任务、额外花费、内心活动或后续决定。意图清楚时直接处理；只有歧义会改变后果时才澄清。普通对白可以依据人物资料直接生成，不需要逐句申请审批。

        二、移动与位置

        判断完成当前行动是否需要接近、离开、绕行或跨场景。依据实际当前位置判断；已经足够接近时不重复移动，明确保持原地时不擅自靠近。
        需要移动时，通过本轮提供的合法入口实际处理，遵守角色控制权限、玩家授权范围及已有规则限制。没有自动寻路能力时，不假装程序已经验证所有地形；需要路线时使用明确的路径或中间点。
        以执行结果中的实际位置为准。等待、拒绝或中断不等于到达；正文不能写出地图和位置状态中未发生的移动。查看地图、平移画面或读取棋子详情，不等于角色移动。跨场景旅行不能用局部棋子摆位代替。

        三、检定与投掷

        判断结果是否可以直接确定，是否适用当前规则下的被动判断，或是否需要主动检定、豁免、攻击等实际结算。结合尝试内容、位置、环境、角色能力和规则判断，不按“观察”“警惕”等关键词固定选择处理方式。
        直接可见或已足以确定的内容不强制掷骰；寻找隐藏目标的尝试不能仅靠重读普通场景介绍就算处理完成。已有作者或规则条件时引用原条件；允许主持裁定的部分，按现有权限在结算前确定，不根据结果倒改条件。
        需要结算时调用实际入口并承接回执，不自行报骰或宣布成败。未进行必要判断不等于失败，未发现也不能直接推导目标不存在。

        四、NPC反应、遭遇与战斗状态

        结合玩家行动、NPC的知识与动机、现场条件及最新结果，判断是否出现需要处理的反应、敌对事件或战斗状态变化。
        发现敌人、口头威胁或关系敌对，不自动等于已经开战；但玩家或NPC真正实施攻击时，必须进入适用的战斗或裁定流程，不能只写一段攻击描写后继续当作普通交流。
        攻击命中、落空、被护甲挡下、成功闪避、成功撤离，以及战斗中的实际位移，都不能在结算前自行宣布。“没有造成伤害”不是绕过结算的理由。
        已有战斗则承接当前阶段、行动顺序和预算，不重复开战或重置单位。出现新的中断事件时，先处理它，再判断原行动剩余部分能否继续。combat为空不单独证明现场安全，还要核对已有敌对事件和待处理意图。
        需要进入或结束战斗时使用真实状态入口；页面随服务端状态变化，不用正文宣称页面或模式已经切换。

        五、信息可见性

        区分世界发生的变化、谁看到了行动、谁实际得知了结果。本人独自发现不自动成为全队知识；现场公开发生的变化也不必因为行动者独自操作就全部变为私密。
        依据感知范围、交流方式和已成立的分享确定接收者，使用现有权限与记录入口处理。公开正文、私人信息、历史、共享线索、地图标记和棋子详情应保持一致的授权范围。
        主持知道的秘密不能因为本轮检查、工具读取或地图可见而自动公开。满足合法发现条件时记录实际揭露的部分，不倾倒其余秘密。

        六、结果保存与本轮结束

        检查本次实际发生的变化：位置、时间、生命、条件、资源、物品、线索、任务进展、单位与战斗状态，以及需要延续的对白或承诺。
        需要执行或保存的变化使用对应入口；尝试、计划、承诺、等待与实际完成分别处理。普通人物反应可以生成并按叙事合同保存，但不得借正文创造尚未结算的机械结果。
        承接本次行动已有回执，区分已完成、待执行、等待与失败。已有成功结果不重新移动、重掷骰、重复开战或重复领取。工具已处理的变化不通过另一个入口再写一次。
        根据最新结果继续玩家已授权且仍然成立的剩余步骤；遇到必须等待的确认、裁定或新的重要选择时暂停，保留尚未完成的意图，不提前写成整句行动已经完成。
        最终正文与实际位置、规则结果和信息权限一致。达到本轮完成或合法等待条件后，按工具合同交付并停止，不追加玩家尚未选择的后续行动。正文使用真实换行分段，不输出字面的反斜杠n代替换行。

        # 本轮能力入口与执行边界

        以下指向实际工具，不授予额外权限；只调用availableTools和当前schema实际提供的能力，不猜测ID或补造执行接口。
        - 补查使用context_read、map_state_read、token_read、规则/记忆查询及已提供的skills工具。资料足够时不重复查询；读取不执行动作，也不证明未查询到的事物不存在。
        - 局部移动使用token_move，缺少本人实例时按token_spawn的真实来源处理；以board中的本人的实例与实际落点为准。跨场景使用world_routes与当前actions_propose旅行候选。服从真实返回的等待/限制，不自行代替玩家确认。
        - 需要检定时优先使用完整匹配的actions_propose候选，承接其投掷等待；checks_result只读取本次权威结果，不掷骰。普通observe只返回公开场景介绍，不执行察觉检定或被动比较。被动数值本身不证明已经发现或未发现目标。没有所需检定/裁决能力时用现有ruling_request处理具体缺口，不编造DC、敌方骰点或成功失败；缺玩家意图才用ask_player。
        - 实际开战使用当前提供的combat.start候选；已有战斗使用当前战斗候选/等待。遭遇指导仅说明能力，不表示攻击已经发生；无自动执行入口而实际发生机械事件时用ruling_request一次，等待真实结果，不反复威胁、查询或重建战斗。
        - world_record.narrative、memory、continuity是公开内容；private只给行动者及主持，不重复到公开字段。公开作者动作的summary/fact不会因为后来写private而收回；需要保密的发现不能先经公开入口发布。棋盘目前为公开棋盘，不能创建“隐藏”棋子或借外观描述泄露秘密。不支持的接收者范围不能假称已隔离。
        - world_record保存当前允许的叙事与信息；items/supplies等按其已有来源合同执行，不能冒充HP、资源、路线或战斗结算。complete默认true会结束本次行动；仍有已授权步骤需要工具处理时不得提前结束，必要的中间记录用complete=false。等待玩家或裁定时使用相应停止入口，不把等待写成完成。

        资料足够时直接处理；缺少影响本轮的具体资料时按需补查。需要的执行能力未提供时，使用当前确实支持的裁定或等待流程，不以重复查询、反复威胁或虚构结果掩盖执行缺口。
        完整检查不要求每项都有工具调用，也不要求每项产生状态变化。不为了完成清单而制造检定、敌意、战斗、移动或新事件。
        """;

    // Only capability routing changes for v35; the complete six-part deliberation stays intact.
    // Keep Text and ProgressNotice frozen for every saved v30-v34 request.
    private static readonly string CurrentExplorationInstructions = BuildInstructions(HarnessTools.CurrentVersion, false);
    private static readonly string CurrentCombatInstructions = BuildInstructions(HarnessTools.CurrentVersion, true);
    public static string InstructionsFor(int contract, bool combatAgent = false) => contract == HarnessTools.CurrentVersion
        ? combatAgent ? CurrentCombatInstructions : CurrentExplorationInstructions : BuildInstructions(contract, combatAgent);
    // v57: the page shows the player's own words right above the public narration, so the
    // narration starts from what happens instead of retelling them.
    public const string NoEchoRule = "玩家原话会原样显示在本次公共叙事正上方。叙事从这一步实际发生的事写起：玩家明确写出的台词按已说出处理，不在正文中重写；不按原话顺序复述其动作、提问和计划，需要承接时只用一句简短动作衔接。人物回应、可感知的变化和结果才是正文。";
    // v59: the check scale and the usual ability/skill pairs are given here. A real-model DM read
    // dm_reference(checks) and rules_search before every ordinary check, one model round each.
    public const string CheckReferenceRule = "检定速查已在此，普通检定不必再调用dm_reference(checks)或rules_search：DC非常简单5、简单10、中等15、困难20、非常困难25、几乎不可能30。能力与技能按2024常规搭配，如追踪痕迹Wisdom/Survival、搜查物件或推断线索Intelligence/Investigation、察觉动静Wisdom/Perception、看穿谎言Wisdom/Insight、攀爬游泳Strength/Athletics、潜行Dexterity/Stealth、说服Charisma/Persuasion。只有需要具体规则正文或特殊情形时才查阅。";
    private static string BuildInstructions(int contract, bool combatAgent) => contract >= 59
        ? InstructionsFor(58, combatAgent) + (combatAgent ? "" : "\n\n" + CheckReferenceRule)
        : contract >= 57
        ? InstructionsFor(56, combatAgent) + (combatAgent ? "" : "\n\n" + NoEchoRule)
        : contract >= 56
        ? InstructionsFor(55, combatAgent) + (combatAgent ? "" : "\n\n" + HarnessReadPreloads.Instructions)
        : contract >= 53
        ? InstructionsFor(52, combatAgent) + (combatAgent
            ? "\n\n移动叙事帧暂时不提供下一步候选，不表示完整输入已完成。交付本人移动后服务器沿同一输入刷新候选；逐格移动后重新对照原话、实际距离和剩余动作：仍需接近则选合法下一格，已在范围且原话要求攻击则申请实际攻击并等待本人投掷。只有原话要求的单步移动时在新帧结束，不额外移动、攻击或结束回合。不要重复已交付段落。combat_continue会穿过只有回合切换而没有实际动作的NPC回合；完整原日志保留，不补写每个敌人瞄准、窥视或心理活动。实际动作及玩家反应/豁免仍会暂停，按当前真实结果交付。" : "")
        : contract >= 52
        ? InstructionsFor(51, combatAgent) + "\n\n" + HarnessStoryContext.IntentKnowledgeContract +
            "\n死亡豁免是倒地角色回合开始的必需流程，不要求玩家另选死亡豁免动作。交付该回合的已结算叙事后，服务器自动建立本人待投掷请求，仍由本人确认才掷骰；不代投、不用ask_player重复询问是否执行。豁免后仍0HP时服务器已把回合推进加入原队列，按实际narration/continue依次交付并继续，不再要求无法行动的角色手动结束回合。自然20恢复1HP时保留本回合供本人决定行动，不能自动跳过。"
        : contract >= 51
        ? InstructionsFor(50, combatAgent)
            .Replace("真实玩家投掷/反应等待仍须本人决定，没有自动后续时停在当前玩家。",
                "真实玩家投掷/反应等待仍须本人决定。自动队列为空不等于完整玩家意图已完成：仍有玩家已授权且当前合法的移动、攻击等步骤时，用complete=false记录中间结果并继续处理；只有原意已完成、真实条件阻断或需要新的玩家选择时才停止。不得擅自结束玩家回合。", StringComparison.Ordinal)
            .Replace("ready不代表已选图或布置完成：明确map_select，依据同版新图给原玩家实例落点，再encounter_prepare绑定原遭遇，最后combat_delegate。Layout=null不能委派。",
                "ready不代表遭遇布局已绑定；已选正确地图、原玩家实例已有正确位置时直接承接，不重复选图或摆人。只有确实换图时才map_select并依据新图安置原实例，然后encounter_prepare绑定原遭遇，最后combat_delegate。Layout=null时委派暂不可用，先按具体校验回执修正原布局；不得偷偷移动玩家使攻击够得到。", StringComparison.Ordinal) +
            "\n\n历史回忆优先ctx_search/ctx_expand，memory_*仅为本人旧行动/机械回执查核。旧摘要中的等待/未完成只描述截至所供来源的历史，不能当作当前运行或准入状态。图中state.map.grid与maps[].grid统一表示本场有效网格，原资产不被修改；方格可用不表示遭遇布局已绑定。掩护地形格不可站立，应位于观察者与单位之间。\n隐匿状态以hidden、真实隐匿结果、knownActors和当前玩家投影为准；hidingReason只是原先尝试的场景依据。已被本人发现但仍在掩体后的敌人可以显示，不能描述成本人尚未发现；未发现单位依然参战，不得因玩家先攻条/地图省略而说其没有入战或泄露身份位置。"
        : contract >= 50
        ? InstructionsFor(49, combatAgent).Replace("省略DC只用于原始数值本身确有意义的判断。",
            "每次要求玩家主动检定/豁免，必须在投掷前明确DC；普通检定不得只记原始骰点。对抗仍不由模型指定DC，由服务器固定并展示实际阈值，不能借此公开目标身份。", StringComparison.Ordinal)
            + "\n要求玩家投掷时必须明确适用DC，以权威待投掷预览为准；先攻/伤害等无DC的骰种说明用途，不伪造DC。"
        : contract >= 49
        ? InstructionsFor(48, combatAgent).Replace(
            "一次处理本批结果，不为每条战报另行请求模型；没有新事实时不重复润色。",
            "每个单位的动作组结算后立即用world_record写成剧情，完成交付后才通过combat_continue推进下一单位；不能先结算全批再补总叙述。移动、攻击、伤害及紧接后果合为一个动作组，不按每条底层日志拆调用。只写当前尚未交付的结果，不预写后续动作；有自动后续时complete不能结束当前输入。真实玩家投掷/反应等待仍须本人决定，没有自动后续时停在当前玩家。", StringComparison.Ordinal) +
            "\n\n" + HarnessStoryContext.IncrementalNarrativeContract
        : contract >= 48
        ? InstructionsFor(47, combatAgent)
            .Replace("只有歧义会改变后果时才澄清。", "可以直接向玩家提问，了解打算、选择、态度、角色本人信息或澄清当前尝试。", StringComparison.Ordinal)
            .Replace("缺玩家意图才ask_player", "需要玩家回答时用ask_player", StringComparison.Ordinal)
            .Replace("缺失会改变后果的意图或目标才ask_player，普通对白不逐句审批。", "需要玩家回答时可以ask_player，包括计划、选择、态度及NPC自然问话；普通对白不逐句审批。", StringComparison.Ordinal) +
            (combatAgent ? "\n\n战斗反馈由你直接润色：把本次已经结算、本人可见且允许公开的连续战报写成自然连贯的叙事，用world_record保存。保留真实行动顺序、命中或落空、伤害、倒地和当前等待；不要把尝试当成已执行，不增伤害、位移、缴械或额外行动。发起交锋的原攻击仍须先攻排序；若尚未轮到本人，或轮到前已失能等条件使原攻击无法执行，明确说明还未出手的原因，不额外补攻击。一次处理本批结果，不为每条战报另行请求模型；没有新事实时不重复润色。机械原记录由界面保留供查阅。" : "") +
            "\n\nDM允许主动向当前玩家提问，也可承接NPC的自然问话。下一步需要回答时直接ask_player暂停，玩家在主输入框回答后继续同一行动，不把问题写成已经完成、不替玩家答应或决定。提问不是只用于参数缺失，也不必先转人工裁定；不为已经明确的普通行动重复确认，不要求每轮都问。提问和回答本身不掷骰、消耗资源、移动、跳过回合或代其他席位同意。问题只包含该玩家实际可知的信息，不借问句透露其他人的秘密。"
        : contract >= 47
        ? InstructionsFor(46, combatAgent).Replace(
            "已请求、已结算或取消的同项判断不因改变reason、DC、模式或主动/被动而重掷；后续失败也承接已保存结果。",
            "同一角色对同目标的同一未变任务只进行一次主动检定，成功失败均承接原结果；换输入措辞、quote、技能、reason、DC、地图或重新进入场景不构成新机会。先被动后首次主动搜寻可以成立，但不能用被动覆盖已经投掷的结果；取消且未投骰不算已完成一次。不同真实任务、情况确有相关变化、独立豁免触发和战斗回合Search按其规则判断，不把同一个物体终身锁死。用checks_result scope=scene回查本人旧规格和结果，隐藏目标以原encounterId保持身份。", StringComparison.Ordinal) +
            "\n\n战斗衔接：已有合格局部战术图必须复用。首次确需生成局部站位图时预先选择tactical及有依据的本场DM范围，不先生成概念图再为了开战重复补图；城镇/区域/只有概念关系的图仍保留其用途，不能改成五尺图。确实需要补战术图时map_request由服务端等待该原任务结束，期间不用模型反复轮询。ready不代表已选图或布置完成：明确map_select，依据同版新图给原玩家实例落点，再encounter_prepare绑定原遭遇，最后combat_delegate。Layout=null不能委派。失败或暂停公开保留原结果并明确尚未开战，不自行重试图片、补骰或伪称命中。"
        : contract >= 46
        ? InstructionsFor(45, combatAgent) + "\n\n必要侦察和战术地图校准相互独立。场景依据成立且缺真实NPC隐匿时，初次encounter_prepare省略encounterId，terrain=[]，用当前公开图的实际位置和场景掩护先保存一次隐匿；无论地图是否校准，都可随后check_request按原encounterId/sourceId/quote进行Perception对抗，等待本人投掷。不能因缺少战术尺度改为纯景物描写、跳过必要检定或先补战术图。直接可见信息仍不强掷。Layout=null仅表示未绑定战术布局。仅实际开战才需要校准tactical图及全队真实位置；用encounter_prepare传原encounterId补布局，按原名单顺序/姓名/来源/策略给新坐标和terrain，省略hiding字段。此步骤不新增实例、不重掷隐匿、不重置HP或个人发现；探索交锋仍委派战斗主持。"
        : contract >= 44 && !combatAgent
        ? InstructionsFor(43).Replace(
            """
            判断结果是否可以直接确定，是否适用当前规则下的被动判断，或是否需要主动检定、豁免、攻击等实际结算。结合尝试内容、位置、环境、角色能力和规则判断，不按“观察”“警惕”等关键词固定选择处理方式。
            直接可见或已足以确定的内容不强制掷骰；寻找隐藏目标的尝试不能仅靠重读普通场景介绍就算处理完成。已有作者或规则条件时引用原条件；允许主持裁定的部分，按现有权限在结算前确定，不根据结果倒改条件。
            需要结算时调用实际入口并承接回执，不自行报骰或宣布成败。未进行必要判断不等于失败，未发现也不能直接推导目标不存在。
            """,
            """
            由AI DM主动判断检定触发：玩家的行动、已成立的环境变化或NPC行为都可能需要能力检定或豁免，不必等玩家明确要求“检定”或“投掷”，也不交人工主持发起。按真实尝试、风险、位置、角色能力和当前规则决定，不按关键词固定掷骰，不为推进剧情凭空制造危险。
            直接可见、已经确定或无需成败判断的信息直接叙述。作者候选只有完整覆盖当前意图及触发条件时才可代结算；普通observe/inspect没有check，只说明该局部动作不掷骰，不表示全情境没有需要处理的检定。局部动作完成后，仍判断环境或NPC事件是否留下尚未结算的触发。
            有适用作者DC或规则条件时沿用；普通情境没有预写DC时，AI DM根据当前真实依据在投掷前选择DC 5..30，reason说明判断目标或触发、环境条件与难度理由，直接check_request，不转人工ruling。sourceId和quote必须来自当前已提供的非模型场景依据，quote为同一来源中的连续原文，不拼接或加省略号；quote/reason是私有审核依据，不是新机械真相，也不复制给玩家。不要等看到骰点后才选阈值或改成败；省略DC只用于原始数值本身确有意义的判断。
            普通能力/技能检定用checkType=ability，豁免用save且skill为空，由服务端使用真实豁免熟练、状态及自动失败规则；自动失败直接记录零骰结果，不另要求确认。不因Unconscious一律拒绝豁免，也不放宽死亡、席位、待处理或场景冻结边界。被动仅支持ability Wisdom/Perception。实际主动检定沿本人原投掷确认，不代同意；检查回执中的真实结果后才叙事。
            真实隐藏单位仍用已保存encounterId、原sourceId/quote及ability Wisdom/Perception，不传自定DC，不造敌方隐匿骰，不拿普通剧情检定冒充隐藏单位发现。未发现不能反推目标存在或不存在。已请求、已结算或取消的同项判断不因改变reason、DC、模式或主动/被动而重掷；后续失败也承接已保存结果。
            """, StringComparison.Ordinal).Replace(
            "需要检定时优先使用完整匹配的作者候选，其他场景检定用check_request。伏兵可先encounter_prepare保存真实NPC隐匿骰，再用check_request的encounterId与原sourceId/quote进行Perception对抗，不提交自编DC；主动检定仍等待本人投掷。普通observe只读介绍，checks_result只读本人已结算结果，encounter_read读取私有对抗与发现。缺少真正未实现能力才ruling_request；缺玩家意图才ask_player。",
            "AI DM依据当前行动、环境与NPC事件主动选择必要的check_request能力检定/豁免，无需玩家要求或人工发起。完整覆盖的作者候选优先；未预写DC时自行按真实场景依据先定DC并写私有reason，不转ruling_request。只在确实缺少执行能力时请求具体人工裁定；缺玩家意图才ask_player。伏兵仍先保存实际隐匿并按encounterId/原sourceId/quote进行Perception对抗，无模型DC。checks_result/encounter_read只读真实结果；普通observe或无check局部动作不代表其他触发已经处理。信息交付遵守当前privateMessages与逐recipient/discoveryId合同，绝不以正文替代机械发现。", StringComparison.Ordinal)
        : contract >= 37
        ? InstructionsFor(36, combatAgent).Replace(combatAgent ? "本人发现不自动变成全队知识，" : "本人独自发现不自动成为全队知识；", "本人可知与允许公开是两个范围。Search等个人发现的数量、身份、方位和描述只交付private，不能同时改写进narrative、memory或continuity；公开正文只写旁人可见的动作与实际公开结果，没有这些内容时可留空。未发生分享时，不能用‘你发现了三只……’这样的第二人称公开句代替私密交付。本人发现不自动成为全队知识；", StringComparison.Ordinal)
        : contract >= 36
        ? combatAgent ? HarnessCombatChecklist.Text : InstructionsFor(35).Replace(
            "作者遭遇使用当前combat.start候选；运行时遭遇用encounter_prepare保存有依据的2024敌人、实际位置、显式战术标尺与地形，不修改原图比例或重置棋子。真实敌对交锋用encounter_engage进入原全队先攻确认；已有战斗承接当前候选/等待。惊讶是2024先攻劣势，无惊讶轮。不反复威胁、虚构攻击结果或重建遭遇；确实超出当前能力才请求具体裁定。",
            "运行时遭遇可先encounter_prepare保存有来源的2024敌人、真实位置和战术布置；侦察准备不自动开战。真实交锋发生时先combat_delegate，将整场主持权、必要人物动机/关系/原话和未完成意图交给独立战斗子会话，再由它进入先攻确认。探索主代理随即暂停，不直接encounter_engage或combat.start，不逐回合复述子代理。权威结束后接收一次回传，核对新处境和后续选择，不重算效果或无条件续走旧计划。", StringComparison.Ordinal)
        : contract < 35 ? Text : Text
        .Replace("需要检定时优先使用完整匹配的actions_propose候选，承接其投掷等待；checks_result只读取本次权威结果，不掷骰。普通observe只返回公开场景介绍，不执行察觉检定或被动比较。被动数值本身不证明已经发现或未发现目标。没有所需检定/裁决能力时用现有ruling_request处理具体缺口，不编造DC、敌方骰点或成功失败；缺玩家意图才用ask_player。",
            "需要检定时优先使用完整匹配的作者候选，其他场景检定用check_request。伏兵可先encounter_prepare保存真实NPC隐匿骰，再用check_request的encounterId与原sourceId/quote进行Perception对抗，不提交自编DC；主动检定仍等待本人投掷。普通observe只读介绍，checks_result只读本人已结算结果，encounter_read读取私有对抗与发现。缺少真正未实现能力才ruling_request；缺玩家意图才ask_player。", StringComparison.Ordinal)
        .Replace("实际开战使用当前提供的combat.start候选；已有战斗使用当前战斗候选/等待。遭遇指导仅说明能力，不表示攻击已经发生；无自动执行入口而实际发生机械事件时用ruling_request一次，等待真实结果，不反复威胁、查询或重建战斗。",
            "作者遭遇使用当前combat.start候选；运行时遭遇用encounter_prepare保存有依据的2024敌人、实际位置、显式战术标尺与地形，不修改原图比例或重置棋子。真实敌对交锋用encounter_engage进入原全队先攻确认；已有战斗承接当前候选/等待。惊讶是2024先攻劣势，无惊讶轮。不反复威胁、虚构攻击结果或重建遭遇；确实超出当前能力才请求具体裁定。", StringComparison.Ordinal)
        .Replace("棋盘目前为公开棋盘，不能创建“隐藏”棋子或借外观描述泄露秘密。不支持的接收者范围不能假称已隔离。",
            "普通token工具只处理公开单位；受限隐藏遭遇由encounter_prepare创建，NPC骰点保存在主持记录。Search发现只给行动者，攻击后由引擎揭示攻击者；不把隐藏名单、先攻或位置复制到公开叙事。不支持的接收者范围不能假称已隔离。", StringComparison.Ordinal);

    public static HarnessDmChecklist Capture(Campaign c, string intentId, string input, int toolContractVersion = MinimumToolVersion, bool combatAgent = false)
    {
        var intent = c.PendingIntents.FirstOrDefault(i => i.Id == intentId);
        if (intent is not null && (intent.ActorId != c.ActingActorId || intent.Text != input))
            throw HarnessJson.Conflict("harness_profile_changed");
        // Copy the exact current action, not recent history or a synthesized remaining plan.
        // Detach mutable arrays before leaving the authorized campaign gate.
        var rulings = c.PendingRulings.Where(r => r.ActorId == c.ActingActorId && intent is { RootSequence: > 0 } &&
            r.OriginSequence == intent.RootSequence).ToArray();
        var rulingIds = rulings.Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
        // DM-requested rolls are linked by RulingId, not PendingRoll.IntentId. Their settled
        // results live on the ruling, not in HarnessSteps; do not manufacture step sequences.
        var rolls = c.PendingRolls.Where(r => r.ActorId == c.ActingActorId &&
            (r.IntentId == intentId || r.Ruling is { } ruling && rulingIds.Contains(ruling.RulingId))).ToArray();
        var pending = rolls.Where(r => r.Status == "pending")
            .Select(r => new HarnessPendingOperation("roll", r.Id, r.Confirmed ? "confirmed_waiting_group" : r.Status))
            .Concat(c.PendingIntents.Where(i => i.ActorId == c.ActingActorId && i.Id == intentId && i.Status == "pending")
                .Select(i => new HarnessPendingOperation("intent", i.Id, i.Status)))
            .Concat(rulings.Where(r => r.Status is "pending" or "awaiting_roll")
                .Select(r => new HarnessPendingOperation("ruling", r.Id, r.Status))).ToArray();
        var results = rulings.Select(r => new HarnessRulingProgress(r.Id, r.Status, r.Outcome, r.Rationale,
            rolls.LastOrDefault(roll => roll.Ruling?.RulingId == r.Id && roll.Status != "cancelled")?.Id ?? "",
            r.Check, r.Effects ?? [], r.Story)).ToArray();
        var progress = new HarnessActionProgress(intentId, c.ActingActorId, c.Version,
            intent?.HarnessSteps?.ToArray() ?? [], pending, results, [], ProgressNotice);
        if (toolContractVersion >= 35) progress = progress with { RecordedSteps = progress.RecordedSteps.Select(step => step with
        { Result = CombatVisibility.ForViewer(c, step.Result, publicOnly: true), Origin = CombatVisibility.ProjectOrigin(c, step.Origin, step.Result, publicOnly: true) }).ToArray() };
        return new(InstructionsFor(toolContractVersion, combatAgent), HarnessJson.Read<HarnessActionProgress>(HarnessJson.Element(progress)));
    }

    public HarnessDmChecklist WithReceipts(IEnumerable<HarnessStep> steps) => this with
    {
        Progress = Progress with
        {
            ToolReceipts = steps.Where(s => s.Kind == "tool" && s.Status == "done" && s.Outcome is not null)
                .Select(s => new HarnessProgressReceipt(s.Id, s.ToolName!, s.Outcome!.Version, s.Outcome.Reply.IsError,
                    Applied(s.Outcome.Reply.Content), s.Outcome.Wait)).ToArray()
        }
    };

    private static bool? Applied(string content)
    {
        using var json = JsonDocument.Parse(content);
        if (json.RootElement.ValueKind == JsonValueKind.Object && json.RootElement.TryGetProperty("protocol", out var protocol) &&
            protocol.TryGetProperty("applied", out var applied) && applied.ValueKind is JsonValueKind.True or JsonValueKind.False)
            return applied.GetBoolean();
        return null; // Some successful read tools return arrays, not transition envelopes.
    }

    public void Validate(HarnessExecutionFrame frame, int toolContractVersion = MinimumToolVersion)
    {
        if (Instructions != InstructionsFor(toolContractVersion, frame.Agent?.Role == "combat") || Progress is not { } p || p.Notice != ProgressNotice ||
            !Guid.TryParseExact(p.IntentId, "D", out _) || p.ActorId != frame.Self?.ActorId || p.Version != frame.Version ||
            p.RecordedSteps is null || p.RecordedSteps.Length > 64 || p.Pending is null || p.Pending.Length > 64 ||
            p.Rulings is null || p.Rulings.Length > 64 || p.Rulings.Any(r => r is null || !Guid.TryParseExact(r.Id, "D", out _) ||
                r.Status is not ("pending" or "awaiting_roll" or "resolved") || r.Rationale is null || r.Effects is null ||
                r.RollId is null || r.RollId.Length > 0 && !Guid.TryParseExact(r.RollId, "D", out _)) ||
            p.Rulings.Select(r => r.Id).Distinct().Count() != p.Rulings.Length ||
            p.ToolReceipts is null || p.ToolReceipts.Length > 64 ||
            p.RecordedSteps.Any(s => s?.Result is null || s.Sequence < 1 || s.Sequence > p.Version || s.Result.IntentId != p.IntentId) ||
            !p.RecordedSteps.Select(s => s.Sequence).SequenceEqual(p.RecordedSteps.Select(s => s.Sequence).Distinct().Order()) ||
            p.Pending.Any(w => w is null || !Guid.TryParseExact(w.Id, "D", out _) || w.Kind is not ("roll" or "intent" or "ruling") ||
                w.Status is not ("pending" or "awaiting_roll" or "confirmed_waiting_group") || w.Kind == "intent" && w.Id != p.IntentId) ||
            p.Pending.Select(w => (w.Kind, w.Id)).Distinct().Count() != p.Pending.Length ||
            p.ToolReceipts.Any(r => r is null || string.IsNullOrEmpty(r.StepId) || r.StepId.Length > 64 ||
                !HarnessTools.ForVersion(toolContractVersion).Any(t => t.Name == r.Tool) || r.Version < 1 || r.Version > p.Version ||
                r.WaitAtCall is { } wait && (wait.Kind is not ("roll" or "intent" or "ruling" or "player") || string.IsNullOrEmpty(wait.Id))) ||
            p.ToolReceipts.Select(r => r.StepId).Distinct().Count() != p.ToolReceipts.Length)
            throw new InvalidDataException("Invalid DM checklist progress.");
    }
}
