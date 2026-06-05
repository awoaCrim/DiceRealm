import type { AiConfig, InteractionRequest, LogEntry, Player, PlayerAction, PromptBlock, PromptBlockPosition, PublicContext, Room, RuleRetrievalMatch, SceneType, ScriptCard, WorldBookMatch } from '../domain/types.js';
import { renderWorldBookMatches } from './worldBookService.js';

export const defaultNarrativeLengthRules = [
  '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
  '- objectiveLog：最多 300 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。',
  '- publicLog：最多 300 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。',
  '- privateUpdatesByPlayer：每名玩家最多 150 个中文字符，只写该玩家本人可见的私人信息。',
  '- ruleResults：每条最多 120 个中文字符。',
  '- interactionRequests：每条 prompt 最多 120 个中文字符。',
  '- suggestedStateChanges.reason：最多 120 个中文字符。',
  '- characterResourceChanges.reason：最多 80 个中文字符。',
  '- diceRequests.reason：最多 80 个中文字符。',
  '信息量少时可以更短，不要为了达到字数而填充内容。'
].join('\n');

export interface NarrativeLengthLimits {
  objectiveLog: number;
  publicLog: number;
  privateUpdate: number;
}

export const defaultNarrativeLengthLimits: NarrativeLengthLimits = {
  objectiveLog: 300,
  publicLog: 300,
  privateUpdate: 150
};

export const defaultAiConfig: AiConfig = {
  coreRules: '核心约束：你是本房间的 AI 地城主持人，只负责描述世界、裁定规则、扮演 NPC 和推进场景。',
  playerAgencyRules: '玩家自主权：不得替任何玩家决定意图、台词、同意、反抗、情绪或 PvP 回应；需要玩家选择时必须等待玩家输入。',
  visibilityRules: '信息隔离：区分客观剧情、公开剧情、私人剧情。objectiveLog 写完整客观真相和所有细节，只给 DM；publicLog 只写所有玩家都能看到或确定知道的内容，只要有任一玩家不知道就不能写入公开剧情；privateUpdatesByPlayer 只按玩家 ID 写该玩家本人可见的信息。不得把 objectiveLog 的隐藏事实通过 publicLog 暗示出来。',
  interactionRules: '玩家互动：当一个玩家的行动会强制影响另一个玩家的选择、资源、身体或秘密时，必须创建 interactionRequests，让目标玩家确认或回应后再结算。',
  outputFormatRules: '输出格式：只返回严格 JSON，字段为 objectiveLog、publicLog、privateUpdatesByPlayer、ruleResults、interactionRequests、diceRequests、suggestedStateChanges、characterResourceChanges；不要使用 Markdown 代码块。',
  styleRules: '叙事风格：使用中文，文字清晰克制，强调可观察事实、规则结果和下一步可行动信息。'
};

export interface BuildPublicContextInput {
  room: Room;
  players: Player[];
  logs: LogEntry[];
  actions: PlayerAction[];
}

export function normalizeAiConfig(value: unknown): AiConfig {
  if (!value || typeof value !== 'object') return defaultAiConfig;
  const partial = value as Partial<AiConfig>;
  return {
    coreRules: partial.coreRules || defaultAiConfig.coreRules,
    playerAgencyRules: partial.playerAgencyRules || defaultAiConfig.playerAgencyRules,
    visibilityRules: partial.visibilityRules || defaultAiConfig.visibilityRules,
    interactionRules: partial.interactionRules || defaultAiConfig.interactionRules,
    outputFormatRules: partial.outputFormatRules || defaultAiConfig.outputFormatRules,
    styleRules: partial.styleRules || defaultAiConfig.styleRules
  };
}

export function parseAiConfigJson(json: string | null | undefined): AiConfig {
  if (!json) return defaultAiConfig;
  try {
    return normalizeAiConfig(JSON.parse(json));
  } catch {
    return defaultAiConfig;
  }
}

export function actionTypeForPrompt(action: Pick<PlayerAction, 'actionType' | 'text'>): string {
  const text = action.text.trim();
  if (!action.actionType || action.actionType === 'narrative') {
    if (/^(我是谁|我现在是谁|我的角色是谁)[？?]?$/.test(text) || /[？?]$/.test(text)) return 'player_question';
    if (/^(观察|查看|环顾|侦查|搜索)/.test(text)) return 'observe';
    if (/^(等待|静观|观望|不行动)/.test(text)) return 'wait';
    return action.actionType ?? 'in_character_action';
  }
  return action.actionType;
}

export function actionVisibilityForPrompt(action: Pick<PlayerAction, 'visibility' | 'actionType' | 'text'>): 'public' | 'private' | 'dm_only' {
  if (action.visibility === 'public' || action.visibility === 'private' || action.visibility === 'dm_only') return action.visibility;
  const actionType = actionTypeForPrompt(action);
  return actionType === 'player_question' || actionType === 'meta_question' ? 'private' : 'public';
}

export function sanitizePublicDiceReason(reason: string): string {
  return reason
    .replace(/地精伏兵|地精埋伏者|goblin ambushers?|goblin ambush/gi, '隐藏威胁')
    .replace(/伏兵|ambushers?/gi, '隐藏威胁')
    .replace(/陷阱机关|trap mechanism/gi, '隐藏机关')
    .replace(/黑蜘蛛|Black Spider/gi, '未公开人物')
    .trim();
}

function narrativeLengthContractLine(limits: NarrativeLengthLimits): string {
  return `剧情长度：必须遵循当前预设或系统规则中声明的硬上限；超过上限属于格式错误。当前硬上限：objectiveLog 最多 ${limits.objectiveLog} 个中文字符、publicLog 最多 ${limits.publicLog} 个中文字符、privateUpdatesByPlayer 每名玩家最多 ${limits.privateUpdate} 个中文字符。信息量少时可以更短，不要填充内容。`;
}

export function parseNarrativeLengthLimitsFromText(content: string): NarrativeLengthLimits | null {
  const objective = content.match(/objectiveLog：?(?:最多|建议\s*\d+-)\s*(\d+)/);
  const publicLog = content.match(/publicLog：?(?:最多|建议\s*\d+-)\s*(\d+)/);
  const privateLog = content.match(/privateUpdatesByPlayer：?(?:每名玩家)?(?:最多|建议\s*\d+-)\s*(\d+)/);
  if (!objective && !publicLog && !privateLog) return null;
  return {
    objectiveLog: objective ? Number(objective[1]) : defaultNarrativeLengthLimits.objectiveLog,
    publicLog: publicLog ? Number(publicLog[1]) : defaultNarrativeLengthLimits.publicLog,
    privateUpdate: privateLog ? Number(privateLog[1]) : defaultNarrativeLengthLimits.privateUpdate
  };
}

export function parseNarrativeLengthLimitsFromPromptBlocks(promptBlocks: PromptBlock[] = []): NarrativeLengthLimits {
  const narrativeBlock = promptBlocks.find((block) => block.enabled && block.name === '剧情字数限制');
  return (narrativeBlock ? parseNarrativeLengthLimitsFromText(narrativeBlock.content) : null) ?? defaultNarrativeLengthLimits;
}

function buildDndOutputContract(limits: NarrativeLengthLimits): string {
  return [
  '# DND 输出契约',
  '严格 JSON 输出：只返回一个 JSON 对象，不使用 Markdown 代码块，不输出 JSON 之外的解释。',
  'JSON 字段必须包含 objectiveLog、publicLog、privateUpdatesByPlayer、ruleResults、interactionRequests、diceRequests、suggestedStateChanges、characterResourceChanges。无内容时数组必须返回 []，对象返回 {}，字符串返回 ""。',
  '上下文优先级：结构化角色状态、房间状态、背包、插件数据库和已确认规则结果优先于世界书文本；当前回合行动优先于长期战役记忆、历史摘要和世界书常识。',
  '剧情分层：objectiveLog 是 DM 可见客观剧情，包含本次结算的完整事实、隐藏细节和全部裁定；publicLog 是所有玩家共同可见/共同已知剧情，只要有任一玩家不知道就不能写入；privateUpdatesByPlayer 只能按玩家 ID 写入该玩家本人可见的私人剧情。',
  'Private Update Routing：privateUpdatesByPlayer 是信息隔离机制，不是可选风味文本。player_question、meta_question、个人身份说明、私人背景/记忆、个人线索、个人感知结果、非公开行动揭示的信息、角色专属规则说明，必须写入对应 playerId 的 privateUpdatesByPlayer。privateUpdatesByPlayer 的 key 必须是 playerId，不能使用玩家名，除非玩家名本身就是 playerId。无私人信息时返回 {}。',
  'Action Type Routing：player_question/meta_question 默认只回复给提交者，不推进场景；observe 可公开描述动作，但只有观察者获得的结果写入 privateUpdatesByPlayer；wait/skip/ready 只做简短公开记录，不扩写姿态、武器架势、台词、情绪或心理；follow 表示跟随队伍/领队行动并计为完成。',
  narrativeLengthContractLine(limits),
  '权限边界：objectiveLog 绝不能写给玩家；publicLog 也不能暗示 objectiveLog 中尚未被玩家发现的隐藏事实，除非当前行动、已公开线索或系统骰点结果支持。失败的察觉/调查等公开描述不得泄露隐藏敌人、陷阱、秘密动机、数量、位置或未来剧情；例如不要写“发现地精伏兵失败”，应写“观察林线是否有隐藏威胁失败”。',
  'objectiveLog 是 DM 追踪客观事实、隐藏真相和裁定依据的日志，不写“AI-DM 需要在 publicLog 中...”这类元指令。',
  '玩家自主权限制：不得把含糊或被动行动扩写成玩家未提交的姿态、武器架势、台词、情绪、内心想法或详细动作。“我是谁？”通常只产生私人身份说明；“静观其变”只表示原地等待/观察，不代表拔武器、靠墙、紧张或自语。',
  '玩家自主权：不得替任何玩家决定意图、台词、同意、反抗、情绪、选择或 PvP 回应。',
  '玩家互动确认：当一个玩家的行动会强制影响另一个玩家的选择、资源、身体或秘密时，必须创建 interactionRequests 等待目标玩家确认或回应；sourcePlayerId 和 targetPlayerId 必须使用 Character Status 中的真实 playerId，不能使用玩家名或角色名。',
  'diceRequests：数组，AI 只声明需要系统自动执行的骰点，不让玩家手动投掷，也不得编造骰点结果。每项包含 type(abilityCheck/attackRoll/savingThrow/skillCheck/damage/healing)、characterId、ability/skill、dc、die、count、modifier、advantage、reason，可选 publicReason/objectiveReason。若 characterId 和 ability/skill 已知，modifier 使用 null，让系统按角色状态计算；只有 NPC 或临时骰且没有 characterId 时才显式给 modifier。diceRequests.reason/publicReason 如果会进入公开日志，必须使用玩家安全描述，不得包含隐藏敌人、陷阱、秘密目标或未公开事实。',
  'ruleResults：只记录无需掷骰的规则裁定，或基于系统已经提供的真实骰点、结构化状态和已知规则得出的结果。不得自行写“检定成功/失败/命中/伤害”等未由系统确认的结果；需要随机性时先返回 diceRequests。',
  'suggestedStateChanges：数组，只用于需要管理员审核的剧情或战役变更，例如 NPC 态度、任务进度、地点状态、战役记忆、线索揭示、客观事实、插件数据库行 upsert/delete。插件数据库变更使用 changeType=database_row_upsert 或 database_row_delete，targetId 为 sheet:<sheetId>/表名/表UID，path 为 rowKey，after 为行对象；默认仅进入待审核，不会自由改写永久战役事实。',
  'characterResourceChanges：数组，仅用于系统可严格校验并自动应用的角色资源变更。允许路径：hitPoints.current、hitPoints.max、hitPoints.temp、spellSlots.*、hitDice.remaining、ammo.*、consumables.*、currency.*、conditions。每项必须包含 characterId、path、before、after、reason、ruleRefs；characterId 必须来自 Character Status。系统会拒绝不存在的 characterId、非白名单 path、before 不匹配或 after 类型/取值非法的项目。'
  ].join('\n');
}

export function renderDndOutputContract(limits: NarrativeLengthLimits = defaultNarrativeLengthLimits): string {
  return buildDndOutputContract(limits);
}

export function buildPublicContext(input: BuildPublicContextInput): PublicContext {
  const submitted = new Set(input.actions.map((action) => action.playerId));

  return {
    room: {
      id: input.room.id,
      name: input.room.name,
      worldInfo: input.room.worldInfo,
      currentTurn: input.room.currentTurn,
      status: input.room.status
    },
    objectiveLogs: input.logs.filter((log) => log.visibilityScope === 'objective' || log.visibilityScope === 'admin'),
    publicLogs: input.logs.filter((log) => log.visibilityScope === 'public'),
    submittedPlayers: input.players.filter((player) => submitted.has(player.id)).map((player) => player.name),
    waitingPlayers: input.players.filter((player) => !submitted.has(player.id)).map((player) => player.name)
  };
}

export function summarizeActionsInSubmissionOrder(actions: PlayerAction[], players: Player[]): string {
  const playerNames = new Map(players.map((player) => [player.id, player.name]));
  return [...actions]
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
    .map((action, index) => `${index + 1}. ${playerNames.get(action.playerId) ?? 'Unknown'} [${actionTypeForPrompt(action)}, ${actionVisibilityForPrompt(action)}]: ${action.text}`)
    .join('\n');
}

function sceneMatchesBlock(blockSceneType: SceneType | undefined, currentSceneType: SceneType | undefined): boolean {
  if (!currentSceneType) return true;
  if (!blockSceneType || blockSceneType === 'all') return true;
  return blockSceneType === currentSceneType;
}

function renderPromptBlocks(blocks: PromptBlock[], position: PromptBlockPosition, sceneType?: SceneType): string[] {
  return blocks
    .filter((block) => block.enabled && block.position === position && sceneMatchesBlock(block.sceneType, sceneType))
    .sort((left, right) => left.orderIndex - right.orderIndex || left.name.localeCompare(right.name))
    .map((block) => `# ${block.name}\n${block.content}`);
}

export function renderRuleMatches(matches: RuleRetrievalMatch[]): string {
  if (matches.length === 0) return '- No 5e rule matches.';
  return matches.map((match) => [
    `## ${match.title}`,
    `Category: ${match.category}`,
    `Summary: ${match.summary}`,
    `Source: ${match.sourceRef}`,
    match.content
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function buildTurnPrompt(input: {
  room: Room;
  players: Player[];
  objectiveLogs?: LogEntry[];
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  scriptCard?: ScriptCard | null;
  promptBlocks?: PromptBlock[];
  worldBookMatches?: WorldBookMatch[];
  ruleMatches?: RuleRetrievalMatch[];
  campaignContext?: string;
  sceneType?: SceneType;
}): string {
  const finalContract = renderDndOutputContract(parseNarrativeLengthLimitsFromPromptBlocks(input.promptBlocks));
  const defaultContract = renderDndOutputContract();
  const promptBlocks = (input.promptBlocks ?? [])
    .filter((block) => !(block.enabled && (block.content.trim() === finalContract || block.content.trim() === defaultContract)));
  const worldBookMatches = input.worldBookMatches ?? [];
  const sections = [
    ...renderPromptBlocks(promptBlocks, 'before_world', input.sceneType),
    ...(input.scriptCard ? [
      '# 全局主剧本卡',
      [
        `名称：${input.scriptCard.name}`,
        input.scriptCard.description,
        input.scriptCard.personality,
        input.scriptCard.scenario
      ].filter(Boolean).join('\n')
    ] : []),
    `Room: ${input.room.name}`,
    `World: ${input.room.worldInfo}`,
    ...renderPromptBlocks(promptBlocks, 'after_world', input.sceneType),
    '# 世界书触发条目',
    renderWorldBookMatches(worldBookMatches),
    '# 5e 规则检索命中',
    renderRuleMatches(input.ruleMatches ?? []),
    ...(input.campaignContext ? [input.campaignContext] : []),
    'Objective log so far (DM only, full truth):',
    (input.objectiveLogs && input.objectiveLogs.length > 0
      ? input.objectiveLogs.map((log) => `- ${log.title}: ${log.content}`).join('\n')
      : '- No objective log yet.'),
    'Public log so far (shared by every player):',
    input.publicLogs.map((log) => `- ${log.title}: ${log.content}`).join('\n') || '- No public log yet.',
    ...renderPromptBlocks(promptBlocks, 'before_actions', input.sceneType),
    'Submitted actions in order:',
    summarizeActionsInSubmissionOrder(input.actions, input.players) || '- No submitted actions yet.',
    'Pending interactions:',
    input.interactions.map((interaction) => {
      const targetResponse = interaction.targetResponse ? `\n  targetResponse: ${interaction.targetResponse}` : '';
      return `- ${interaction.type} status=${interaction.status} sourcePlayerId=${interaction.sourcePlayerId} targetPlayerId=${interaction.targetPlayerId}: ${interaction.prompt}${targetResponse}`;
    }).join('\n') || '- None.',
    ...renderPromptBlocks(promptBlocks, 'after_actions', input.sceneType),
    ...renderPromptBlocks(promptBlocks, 'final', input.sceneType)
  ];
  sections.push(finalContract);
  return sections.join('\n\n');
}
