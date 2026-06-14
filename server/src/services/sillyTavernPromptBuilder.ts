import type {
  InteractionRequest,
  LogEntry,
  Player,
  PlayerAction,
  PromptPreviewBlock,
  PromptPreviewResponse,
  PromptPreviewSlot,
  PromptPreviewWorldBookMatch,
  PromptPresetPackage,
  ResourceWorldBookEntry,
  Room,
  ScriptCard
} from '../domain/types.js';
import { renderDndOutputContract, sanitizeContractContent, summarizeActionsInSubmissionOrder } from './aiContextBuilder.js';
import { buildWorldBookScanText, matchResourceWorldBookEntries, renderResourceWorldBookMatches } from './worldBookService.js';

interface SillyTavernPromptBuilderInput {
  room: Room;
  players: Player[];
  objectiveLogs: LogEntry[];
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  scriptCard: ScriptCard | null;
  presetPackage: PromptPresetPackage | null;
  worldBookEntries: ResourceWorldBookEntry[];
}

interface StPromptDefinition {
  identifier: string;
  displayName: string;
  role: string;
  content: string;
}

interface StPromptOrderItem {
  identifier: string;
  displayName: string;
  enabled: boolean;
}

type PromptRole = 'system' | 'user' | 'assistant';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeRole(role: unknown): PromptRole {
  return role === 'user' || role === 'assistant' || role === 'system' ? role : 'system';
}

function sanitizePromptContent(content: string): string {
  return sanitizeContractContent(content)
    .replace('需要真实随机数时使用 diceRequests', '需要随机结果时声明 diceRequests，由系统内部自动掷骰')
    .replace('AI 不直接掷骰，必须用 diceRequests 请求系统骰点。', '需要随机结果时用 diceRequests 让系统内部自动骰点，不要求玩家手动投掷。')
    .replace('AI 只输出 suggestedStateChanges，由管理员或系统应用。', 'AI 只输出 suggestedStateChanges 或可校验的 characterResourceChanges，由系统应用合法变更。');
}

function readSyspromptContent(value: unknown): string {
  if (!isRecord(value)) return '';
  return sanitizePromptContent(stringValue(value.content)).trim();
}

function readPromptDefinitions(openAiSettings: unknown): StPromptDefinition[] {
  if (!isRecord(openAiSettings) || !Array.isArray(openAiSettings.prompts)) return [];
  return openAiSettings.prompts
    .filter(isRecord)
    .map((prompt) => {
      const identifier = (stringValue(prompt.identifier) || stringValue(prompt.name)).trim();
      return {
        identifier,
        displayName: (stringValue(prompt.name) || identifier).trim(),
        role: stringValue(prompt.role).trim(),
        content: sanitizePromptContent(stringValue(prompt.content)).trim()
      };
    })
    .filter((prompt) => prompt.identifier.length > 0);
}

function readPromptOrder(openAiSettings: unknown): StPromptOrderItem[] {
  if (!isRecord(openAiSettings) || !Array.isArray(openAiSettings.prompt_order)) return [];
  const firstOrder = openAiSettings.prompt_order.find(isRecord);
  if (!firstOrder || !Array.isArray(firstOrder.order)) return [];
  return firstOrder.order
    .filter(isRecord)
    .map((item) => {
      const identifier = (stringValue(item.identifier) || stringValue(item.name)).trim();
      return {
        identifier,
        displayName: (stringValue(item.name) || identifier).trim(),
        enabled: item.enabled !== false
      };
    })
    .filter((item) => item.identifier.length > 0);
}

function section(title: string, content: string): string {
  const trimmed = content.trim();
  return trimmed ? `# ${title}\n${trimmed}` : '';
}

function renderPublicLogs(logs: LogEntry[]): string {
  if (logs.length === 0) return '- No public log yet.';
  return logs.map((log) => `- ${log.title}: ${log.content}`).join('\n');
}

function renderObjectiveLogs(logs: LogEntry[]): string {
  if (logs.length === 0) return '- No objective log yet.';
  return logs.map((log) => `- ${log.title}: ${log.content}`).join('\n');
}

function renderPendingInteractions(interactions: InteractionRequest[]): string {
  if (interactions.length === 0) return '- None.';
  return interactions.map((interaction) => `- ${interaction.prompt}`).join('\n');
}

const runtimeOnlyPromptSlots = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'scenario',
  'chatHistory',
  'dndTurnState',
  'dndPlayerActions',
  'dndPendingInteractions',
  'dndOutputContract'
]);

const skippedPromptSlots = new Set([
  'charDescription',
  'charPersonality',
  'dialogueExamples',
  'chatHistory'
]);

function buildSlots(input: SillyTavernPromptBuilderInput): { slots: Map<string, PromptPreviewSlot>; matches: ReturnType<typeof matchResourceWorldBookEntries> } {
  const scriptCard = input.scriptCard;
  const scanText = [
    buildWorldBookScanText({
      roomWorldInfo: input.room.worldInfo,
      publicLogs: [...input.objectiveLogs.slice(-4), ...input.publicLogs.slice(-4)],
      actions: input.actions,
      players: input.players
    }),
    scriptCard?.name ?? '',
    scriptCard?.description ?? ''
  ].join('\n\n');
  const matches = matchResourceWorldBookEntries(input.worldBookEntries, scanText);
  const turnState = [
    `Room: ${input.room.name}`,
    `Turn: ${input.room.currentTurn}`,
    `Status: ${input.room.status}`,
    `World: ${input.room.worldInfo}`,
    'Objective log so far (DM only, never reveal hidden facts to players):',
    renderObjectiveLogs(input.objectiveLogs.slice(-8)),
    'Public log so far (shared by every player):',
    renderPublicLogs(input.publicLogs.slice(-8))
  ].join('\n');
  const slotValues: Array<[string, string, string]> = [
    ['main', 'st-sysprompt', readSyspromptContent(input.presetPackage?.sysprompt)],
    ['worldInfoBefore', 'resource-world-book', renderResourceWorldBookMatches(matches, 'before', 6)],
    ['worldInfoAfter', 'resource-world-book', renderResourceWorldBookMatches(matches, 'after', 4)],
    ['charDescription', 'script-card', ''],
    ['charPersonality', 'script-card', ''],
    ['scenario', 'script-card', scriptCard?.scenario ?? ''],
    ['dialogueExamples', 'script-card', scriptCard?.mesExample ?? ''],
    ['chatHistory', 'runtime', renderPublicLogs(input.publicLogs)],
    ['dndTurnState', 'runtime', turnState],
    ['dndPlayerActions', 'runtime', summarizeActionsInSubmissionOrder(input.actions, input.players) || '- No submitted actions yet.'],
    ['dndPendingInteractions', 'runtime', renderPendingInteractions(input.interactions)],
    ['dndOutputContract', 'dnd-contract', renderDndOutputContract()]
  ];

  return {
    slots: new Map(
      slotValues.map(([key, source, content]) => [key, { key, source, content: content.trim() }])
    ),
    matches
  };
}

function blockSource(identifier: string): PromptPreviewBlock['source'] {
  return identifier === 'dndOutputContract' ? 'dnd-contract' : 'runtime-slot';
}

const runtimeSlotNames: Record<string, string> = {
  main: '主提示词',
  worldInfoBefore: '世界书前置注入',
  worldInfoAfter: '世界书后置注入',
  charDescription: '角色描述',
  charPersonality: '角色人格',
  scenario: '场景',
  dialogueExamples: '对话示例',
  chatHistory: '公开日志',
  dndTurnState: '当前回合状态',
  dndPlayerActions: '玩家行动',
  dndPendingInteractions: '待回应互动',
  dndOutputContract: 'DND 输出契约'
};

function titleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean) ?? '';
  if (firstLine.includes('绝不代替玩家') || firstLine.includes('玩家自主权')) return '玩家自主权';
  if (firstLine.includes('先攻') || firstLine.includes('攻击检定') || firstLine.includes('AC') || firstLine.includes('DC')) return '战斗规则';
  if (firstLine.includes('NPC') || firstLine.includes('独立动机')) return 'NPC自主性';
  if (firstLine.includes('信息隔离') || firstLine.includes('私密')) return '信息隔离';
  if (firstLine.includes('JSON') || firstLine.includes('输出格式')) return '输出格式';
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}...` : firstLine;
}

function previewBlockName(identifier: string, content: string, displayName?: string): string {
  const normalizedName = displayName?.trim();
  if (normalizedName && normalizedName !== identifier) return normalizedName;
  return runtimeSlotNames[identifier] ?? titleFromContent(content) ?? identifier;
}

function makeBlock(
  identifier: string,
  role: PromptRole,
  content: string,
  source: PromptPreviewBlock['source'],
  displayName?: string,
): PromptPreviewBlock | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return {
    identifier,
    displayName: previewBlockName(identifier, trimmed, displayName),
    role: identifier === 'dndOutputContract' ? 'system' : role,
    content: trimmed,
    source
  };
}

export function buildSillyTavernPromptPreview(input: SillyTavernPromptBuilderInput): PromptPreviewResponse {
  const warnings: string[] = [];
  const promptDefinitions = readPromptDefinitions(input.presetPackage?.openAiSettings);
  const promptOrder = readPromptOrder(input.presetPackage?.openAiSettings);
  if (!input.presetPackage) warnings.push('No SillyTavern preset package is bound.');
  if (promptDefinitions.length === 0) warnings.push('No SillyTavern prompt definitions found.');
  if (promptOrder.length === 0) warnings.push('No SillyTavern prompt order found; using prompt definition order.');

  const definitionsByIdentifier = new Map(promptDefinitions.map((prompt) => [prompt.identifier, prompt]));
  const orderedItems = promptOrder.length > 0
    ? promptOrder.filter((item) => item.enabled)
    : promptDefinitions.map((prompt) => ({ identifier: prompt.identifier, displayName: prompt.displayName, enabled: true }));
  const { slots, matches } = buildSlots(input);
  const promptBlocks: PromptPreviewBlock[] = [];
  const usedRuntimeSlots = new Set<string>();

  for (const item of orderedItems) {
    if (item.identifier === 'dndOutputContract') continue;
    if (skippedPromptSlots.has(item.identifier)) continue;
    const definition = definitionsByIdentifier.get(item.identifier);
    const slot = slots.get(item.identifier);
    const role = normalizeRole(definition?.role);
    if (item.identifier === 'main') {
      const content = slot?.content || definition?.content || '';
      const block = makeBlock(item.identifier, role, content, 'st-preset', item.displayName || definition?.displayName);
      if (block) promptBlocks.push(block);
      usedRuntimeSlots.add(item.identifier);
      continue;
    }
    if (slot) {
      if (usedRuntimeSlots.has(item.identifier)) continue;
      const block = makeBlock(item.identifier, role, slot.content, blockSource(item.identifier));
      if (block) promptBlocks.push(block);
      usedRuntimeSlots.add(item.identifier);
      continue;
    }
    if (runtimeOnlyPromptSlots.has(item.identifier)) continue;
    if (definition) {
      const block = makeBlock(item.identifier, role, definition.content, 'st-preset', item.displayName || definition.displayName);
      if (block) promptBlocks.push(block);
    }
  }

  const dndSlotOrder = ['dndTurnState', 'dndPlayerActions', 'dndPendingInteractions'];
  for (const identifier of dndSlotOrder) {
    if (usedRuntimeSlots.has(identifier)) continue;
    const slot = slots.get(identifier);
    if (!slot) continue;
    const block = makeBlock(identifier, 'system', slot.content, blockSource(identifier));
    if (block) promptBlocks.push(block);
  }

  promptBlocks.push({
    identifier: 'dndOutputContract',
    displayName: runtimeSlotNames.dndOutputContract,
    role: 'system',
    source: 'dnd-contract',
    content: renderDndOutputContract().trim()
  });

  const prompt = promptBlocks.map((block) => block.content).join('\n\n');
  const worldBookMatches: PromptPreviewWorldBookMatch[] = matches.map((match) => ({
    worldBookId: match.entry.worldBookId,
    entryId: match.entry.id,
    keys: match.matchedKeys,
    reason: match.reason,
    position: match.entry.position,
    content: match.entry.content
  }));

  return {
    mode: 'sillytavern-compatible',
    prompt,
    messages: promptBlocks.map((block) => ({ role: block.role, content: block.content })),
    slots: [...slots.values()],
    worldBookMatches,
    ruleMatches: [],
    promptBlocks,
    warnings
  };
}
