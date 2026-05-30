import type { AiConfig, InteractionRequest, LogEntry, Player, PlayerAction, PromptBlock, PromptBlockPosition, PublicContext, Room, RuleRetrievalMatch, SceneType, ScriptCard, WorldBookMatch } from '../domain/types.js';
import { renderWorldBookMatches } from './worldBookService.js';

export const defaultAiConfig: AiConfig = {
  coreRules: '核心约束：你是本房间的 AI 地城主持人，只负责描述世界、裁定规则、扮演 NPC 和推进场景。',
  playerAgencyRules: '玩家自主权：不得替任何玩家决定意图、台词、同意、反抗、情绪或 PvP 回应；需要玩家选择时必须等待玩家输入。',
  visibilityRules: '信息隔离：只能使用当前上下文中授权可见的信息；不得泄露、暗示、转述或通过因果关系暴露其他玩家私密行动、线索或结果。',
  interactionRules: '玩家互动：当一个玩家的行动会强制影响另一个玩家的选择、资源、身体或秘密时，必须创建 interactionRequests，让目标玩家确认或回应后再结算。',
  outputFormatRules: '输出格式：只返回严格 JSON，字段为 publicLog、privateUpdatesByPlayer、ruleResults、interactionRequests、diceRequests、suggestedStateChanges；不要使用 Markdown 代码块。',
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

const fixedDndOutputContract = [
  '# DND 输出契约',
  '严格 JSON 输出：只返回一个 JSON 对象，不使用 Markdown 代码块，不输出 JSON 之外的解释。',
  'JSON 字段必须包含 publicLog、privateUpdatesByPlayer、ruleResults、interactionRequests、diceRequests、suggestedStateChanges。',
  '信息隔离：publicLog 只能包含所有玩家可见的信息；privateUpdatesByPlayer 只能按玩家 ID 写入该玩家可见的私密结果。',
  '玩家自主权：不得替任何玩家决定意图、台词、同意、反抗、情绪、选择或 PvP 回应。',
  '玩家互动确认：当一个玩家的行动会强制影响另一个玩家的选择、资源、身体或秘密时，必须创建 interactionRequests 等待目标玩家确认或回应。',
  'diceRequests：数组，AI 可请求系统执行真实骰点。每项包含 type(abilityCheck/attackRoll/savingThrow/skillCheck/damage/healing)、ability/skill、dc、die、count、modifier、advantage、reason。characterId 可选，无角色时使用 NPC 数据或纯骰。AI 不得编造骰点结果。',
  'suggestedStateChanges：数组，只提出建议，不表示已经应用。每项包含 changeType、targetId、path、before、after、reason、ruleRefs。系统或管理员稍后决定是否应用。',
  '兼容旧字段 characterResourceChanges：如模型返回该字段，系统会当作 suggestedStateChanges 的一类处理，但新提示应优先使用 suggestedStateChanges。'
].join('\n');

export function renderDndOutputContract(): string {
  return fixedDndOutputContract;
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
    publicLogs: input.logs.filter((log) => log.visibilityScope === 'public'),
    submittedPlayers: input.players.filter((player) => submitted.has(player.id)).map((player) => player.name),
    waitingPlayers: input.players.filter((player) => !submitted.has(player.id)).map((player) => player.name)
  };
}

export function summarizeActionsInSubmissionOrder(actions: PlayerAction[], players: Player[]): string {
  const playerNames = new Map(players.map((player) => [player.id, player.name]));
  return [...actions]
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
    .map((action, index) => `${index + 1}. ${playerNames.get(action.playerId) ?? 'Unknown'}: ${action.text}`)
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
  const finalContract = renderDndOutputContract();
  const promptBlocks = (input.promptBlocks ?? [])
    .filter((block) => !(block.enabled && block.content.trim() === finalContract));
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
    'Public log so far:',
    input.publicLogs.map((log) => `- ${log.title}: ${log.content}`).join('\n') || '- No public log yet.',
    ...renderPromptBlocks(promptBlocks, 'before_actions', input.sceneType),
    'Submitted actions in order:',
    summarizeActionsInSubmissionOrder(input.actions, input.players) || '- No submitted actions yet.',
    'Pending interactions:',
    input.interactions.map((interaction) => `- ${interaction.prompt}`).join('\n') || '- None.',
    ...renderPromptBlocks(promptBlocks, 'after_actions', input.sceneType),
    ...renderPromptBlocks(promptBlocks, 'final', input.sceneType)
  ];
  sections.push(finalContract);
  return sections.join('\n\n');
}
