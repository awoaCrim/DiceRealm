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
import { renderDndOutputContract, summarizeActionsInSubmissionOrder } from './aiContextBuilder.js';
import { buildWorldBookScanText, matchResourceWorldBookEntries, renderResourceWorldBookMatches } from './worldBookService.js';

interface SillyTavernPromptBuilderInput {
  room: Room;
  players: Player[];
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  scriptCard: ScriptCard | null;
  presetPackage: PromptPresetPackage | null;
  worldBookEntries: ResourceWorldBookEntry[];
}

interface StPromptDefinition {
  identifier: string;
  role: string;
  content: string;
}

interface StPromptOrderItem {
  identifier: string;
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

function readSyspromptContent(value: unknown): string {
  if (!isRecord(value)) return '';
  return stringValue(value.content).trim();
}

function readPromptDefinitions(openAiSettings: unknown): StPromptDefinition[] {
  if (!isRecord(openAiSettings) || !Array.isArray(openAiSettings.prompts)) return [];
  return openAiSettings.prompts
    .filter(isRecord)
    .map((prompt) => ({
      identifier: (stringValue(prompt.identifier) || stringValue(prompt.name)).trim(),
      role: stringValue(prompt.role).trim(),
      content: stringValue(prompt.content).trim()
    }))
    .filter((prompt) => prompt.identifier.length > 0);
}

function readPromptOrder(openAiSettings: unknown): StPromptOrderItem[] {
  if (!isRecord(openAiSettings) || !Array.isArray(openAiSettings.prompt_order)) return [];
  const firstOrder = openAiSettings.prompt_order.find(isRecord);
  if (!firstOrder || !Array.isArray(firstOrder.order)) return [];
  return firstOrder.order
    .filter(isRecord)
    .map((item) => ({
      identifier: (stringValue(item.identifier) || stringValue(item.name)).trim(),
      enabled: item.enabled !== false
    }))
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

function renderPendingInteractions(interactions: InteractionRequest[]): string {
  if (interactions.length === 0) return '- None.';
  return interactions.map((interaction) => `- ${interaction.prompt}`).join('\n');
}

function buildSlots(input: SillyTavernPromptBuilderInput): { slots: Map<string, PromptPreviewSlot>; matches: ReturnType<typeof matchResourceWorldBookEntries> } {
  const scriptCard = input.scriptCard;
  const scanText = [
    buildWorldBookScanText({
      roomWorldInfo: input.room.worldInfo,
      publicLogs: input.publicLogs,
      actions: input.actions,
      players: input.players
    }),
    scriptCard?.description ?? '',
    scriptCard?.scenario ?? ''
  ].join('\n\n');
  const matches = matchResourceWorldBookEntries(input.worldBookEntries, scanText);
  const turnState = [
    `Room: ${input.room.name}`,
    `Turn: ${input.room.currentTurn}`,
    `Status: ${input.room.status}`,
    `World: ${input.room.worldInfo}`,
    'Public log so far:',
    renderPublicLogs(input.publicLogs)
  ].join('\n');
  const slotValues: Array<[string, string, string]> = [
    ['main', 'st-sysprompt', readSyspromptContent(input.presetPackage?.sysprompt)],
    ['worldInfoBefore', 'resource-world-book', renderResourceWorldBookMatches(matches, 'before')],
    ['worldInfoAfter', 'resource-world-book', renderResourceWorldBookMatches(matches, 'after')],
    ['charDescription', 'script-card', scriptCard?.description ?? ''],
    ['charPersonality', 'script-card', scriptCard?.personality ?? ''],
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

function makeBlock(identifier: string, role: PromptRole, content: string, source: PromptPreviewBlock['source']): PromptPreviewBlock | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { identifier, role: identifier === 'dndOutputContract' ? 'system' : role, content: trimmed, source };
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
    : promptDefinitions.map((prompt) => ({ identifier: prompt.identifier, enabled: true }));
  const { slots, matches } = buildSlots(input);
  const promptBlocks: PromptPreviewBlock[] = [];
  const usedRuntimeSlots = new Set<string>();

  for (const item of orderedItems) {
    if (item.identifier === 'dndOutputContract') continue;
    const definition = definitionsByIdentifier.get(item.identifier);
    const slot = slots.get(item.identifier);
    const role = normalizeRole(definition?.role);
    if (item.identifier === 'main') {
      const content = [definition?.content ?? '', slot?.content ?? ''].filter(Boolean).join('\n\n');
      const block = makeBlock(item.identifier, role, content, 'st-preset');
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
    if (definition) {
      const block = makeBlock(item.identifier, role, definition.content, 'st-preset');
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
