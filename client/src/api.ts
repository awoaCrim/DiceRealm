import type {
  AdminState,
  AiTurnPromptPreviewResponse,
  AiTurnPromptSendResponse,
  AiConfig,
  AiProviderConfig,
  AuditListResponse,
  CampaignLocation,
  CampaignNpc,
  CampaignQuest,
  CharacterBuilderAudit,
  CharacterBuilderDraft,
  CharacterBuilderOptions,
  CharacterOption,
  EmbeddingProviderConfig,
  GlobalConfigSnapshot,
  GlobalResourceWorldBookBinding,
  JsonObject,
  JsonValue,
  PlayerTurnSuggestion,
  PlayerTurnSuggestionStatus,
  PlayerVisibleState,
  PresetTemplateMeta,
  PresetType,
  PromptPreset,
  PromptPresetPackage,
  PromptPreviewResponse,
  RemoteDbRow,
  RemoteDbSource,
  RemoteDbSheet,
  RoomDbSourceBinding,
  ResourceImportDraft,
  ResourceImportDraftKind,
  ResourceImportDraftStatus,
  ResourceImportInput,
  ResourceImportJob,
  ResourceImportRuleset,
  ResourceImportSourceType,
  ResourceRule,
  ResourceWorldBook,
  ResourceWorldBookEntry,
  RestInput,
  RestResponse,
  RollbackResponse,
  Room,
  RoomPresetBinding,
  RoomScriptBinding,
  RoomSummary,
  RoomWorldBookBinding,
  RuleRetrievalMatch,
  RuleWorldBookEntry,
  ScriptCard,
  SessionSummary,
  WorldBook,
  WorldBookEntry
} from './types';

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_AI_TIMEOUT_MS = 120000;
const CHARACTER_CONFIRM_TIMEOUT_MS = 120000;
const ROOM_CREATE_TIMEOUT_MS = 120000;
const DEV_BACKEND_PORT = '3000';

let cachedAiTimeoutMs: number | null = null;

async function getAiTimeoutMs(): Promise<number> {
  if (cachedAiTimeoutMs !== null) return cachedAiTimeoutMs;
  try {
    const res = await fetch(eventSourceUrl('/api/player/public/runtime'));
    if (res.ok) {
      const data = await res.json();
      cachedAiTimeoutMs = typeof data.timeoutMs === 'number' && data.timeoutMs > 0 ? data.timeoutMs : DEFAULT_AI_TIMEOUT_MS;
    } else {
      cachedAiTimeoutMs = DEFAULT_AI_TIMEOUT_MS;
    }
  } catch {
    cachedAiTimeoutMs = DEFAULT_AI_TIMEOUT_MS;
  }
  return cachedAiTimeoutMs!;
}

export function invalidateAiTimeoutCache(): void {
  cachedAiTimeoutMs = null;
}

function eventSourceUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  if (window.location.hostname && window.location.port === '5180') {
    return `${window.location.protocol}//${window.location.hostname}:${DEV_BACKEND_PORT}${path}`;
  }
  return path;
}

async function jsonRequest<T>(url: string, init?: RequestInit, options: { timeoutMs?: number; timeoutLabel?: string } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
    });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (typeof record.message === 'string' && record.message.trim()) {
          message = record.message;
        } else if (typeof record.error === 'string' && record.error.trim()) {
          message = record.error;
        }
      }
    } catch {
    }
    throw new Error(message);
  }
    return response.json() as Promise<T>;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      const seconds = Math.round(timeoutMs / 1000);
      const target = options.timeoutLabel ?? '后端';
      throw new Error(`请求已被前端超时取消：${target} ${seconds} 秒内没有响应，请确认服务是否仍在运行。`);
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export function createRoom(input: { name: string; expectedPlayerCount: number }) {
  return jsonRequest<{ roomId: string; adminUrl: string }>('/api/admin/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: input.name, expectedPlayerCount: input.expectedPlayerCount })
  }, {
    timeoutMs: ROOM_CREATE_TIMEOUT_MS,
    timeoutLabel: 'AI 开场生成'
  });
}

export function listRooms() {
  return jsonRequest<{ rooms: RoomSummary[] }>('/api/admin/rooms');
}

export function deleteRoom(roomId: string) {
  return jsonRequest<{ ok: true; roomId: string }>(`/api/admin/rooms/${roomId}`, { method: 'DELETE' });
}

export function updateRoomExpectedPlayerCount(roomId: string, expectedPlayerCount: number) {
  return jsonRequest<{ room: Room | null }>(`/api/admin/rooms/${roomId}/expected-player-count`, {
    method: 'PUT',
    body: JSON.stringify({ expectedPlayerCount })
  });
}

export function addPlayer(roomId: string, name: string) {
  return jsonRequest<{ playerId: string; token: string; playerUrl: string }>(`/api/admin/rooms/${roomId}/players`, { method: 'POST', body: JSON.stringify({ name }) });
}

export function adminSkipPlayerTurn(roomId: string, playerId: string, reason?: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/rooms/${roomId}/players/${playerId}/skip-turn`, {
    method: 'POST',
    body: JSON.stringify({ ...(reason ? { reason } : {}) })
  });
}

export function getAdminState(roomId: string) {
  return jsonRequest<AdminState>(`/api/admin/rooms/${roomId}`);
}

export function getGlobalConfig() {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config');
}

export function getGlobalAiProviderConfig() {
  return jsonRequest<AiProviderConfig>('/api/admin/config/ai-provider');
}

export function saveGlobalAiProviderConfig(config: AiProviderConfig) {
  return jsonRequest<AiProviderConfig>('/api/admin/config/ai-provider', {
    method: 'PUT',
    body: JSON.stringify(config)
  });
}

export function testGlobalAiProviderConfig(config?: AiProviderConfig) {
  return jsonRequest<{ ok: true }>('/api/admin/config/ai-provider/test', {
    method: 'POST',
    ...(config ? { body: JSON.stringify(config) } : {})
  });
}

export function getGlobalEmbeddingProviderConfig() {
  return jsonRequest<EmbeddingProviderConfig>('/api/admin/config/embedding-provider');
}

export function saveGlobalEmbeddingProviderConfig(config: EmbeddingProviderConfig) {
  return jsonRequest<EmbeddingProviderConfig>('/api/admin/config/embedding-provider', {
    method: 'PUT',
    body: JSON.stringify(config)
  });
}

export function testGlobalEmbeddingProviderConfig(config?: EmbeddingProviderConfig) {
  return jsonRequest<{ ok: true }>('/api/admin/config/embedding-provider/test', {
    method: 'POST',
    ...(config ? { body: JSON.stringify(config) } : {})
  });
}

export function reindexRuleEmbeddings() {
  return jsonRequest<{ indexed: number; skipped: number }>('/api/admin/rules/embeddings/reindex', { method: 'POST' });
}

export function previewRuleRetrieval(query: string, limit = 5) {
  return jsonRequest<{ matches: RuleRetrievalMatch[] }>('/api/admin/rules/retrieval-preview', {
    method: 'POST',
    body: JSON.stringify({ query, limit })
  });
}

export function saveGlobalAiConfig(aiConfig: AiConfig) {
  return jsonRequest<AiConfig>('/api/admin/config/ai-config', { method: 'PUT', body: JSON.stringify(aiConfig) });
}

export function getAiConfig(roomId: string) {
  return jsonRequest<AiConfig>(`/api/admin/rooms/${roomId}/ai-config`);
}

export function saveAiConfig(roomId: string, aiConfig: AiConfig) {
  return jsonRequest<AiConfig>(`/api/admin/rooms/${roomId}/ai-config`, { method: 'PUT', body: JSON.stringify(aiConfig) });
}

export function previewAiPrompt(roomId: string) {
  return jsonRequest<PromptPreviewResponse>(`/api/admin/rooms/${roomId}/ai-prompt-preview`);
}

export function createAiTurnPreview(roomId: string) {
  return jsonRequest<AiTurnPromptPreviewResponse>('/api/admin/ai/turn-preview', {
    method: 'POST',
    body: JSON.stringify({ roomId })
  });
}

export async function sendAiTurnPreview(roomId: string, previewId: string, flatPrompt: string) {
  const timeoutMs = await getAiTimeoutMs();
  return jsonRequest<AiTurnPromptSendResponse>('/api/admin/ai/send-preview', {
    method: 'POST',
    body: JSON.stringify({ roomId, previewId, flatPrompt })
  }, {
    timeoutMs,
    timeoutLabel: 'AI 回合生成'
  });
}

export interface AiTurnApplyOptions {
  confirmedSuggestedStateChangeIndexes?: number[];
  confirmedCharacterResourceChangeIndexes?: number[];
}

export function applyAiTurnPreview(roomId: string, previewId: string, options: AiTurnApplyOptions = {}) {
  return jsonRequest<AiTurnPromptSendResponse>('/api/admin/ai/apply-preview', {
    method: 'POST',
    body: JSON.stringify({ roomId, previewId, ...options })
  });
}

type PresetSaveInput = Omit<PromptPreset, 'id' | 'roomId' | 'createdAt' | 'updatedAt'> & { id?: string };

export function savePreset(preset: PresetSaveInput) {
  const method = preset.id ? 'PUT' : 'POST';
  const url = preset.id ? `/api/admin/config/presets/${preset.id}` : '/api/admin/config/presets';
  return jsonRequest<{ preset: PromptPreset; presets: PromptPreset[] }>(url, { method, body: JSON.stringify(preset) });
}

export function activatePreset(presetId: string) {
  return jsonRequest<{ preset: PromptPreset; presets: PromptPreset[] }>(`/api/admin/config/presets/${presetId}/activate`, { method: 'POST' });
}

export function updatePresetNumericConfig(presetId: string, config: unknown) {
  return jsonRequest<{ preset: PromptPreset; presets: PromptPreset[] }>(`/api/admin/config/presets/${presetId}/numeric-config`, { method: 'PUT', body: JSON.stringify(config) });
}

export function getRuntimeSettings() {
  return jsonRequest<{ timeoutMs: number; maxAttempts: number; temperature: number }>('/api/admin/config/runtime-settings');
}

export function updateRuntimeSettings(settings: unknown) {
  return jsonRequest<{ timeoutMs: number; maxAttempts: number; temperature: number }>('/api/admin/config/runtime-settings', { method: 'PUT', body: JSON.stringify(settings) });
}

export function createWorldBook(input: { name: string; description: string; enabled: boolean }) {
  return jsonRequest<{ worldBook: WorldBook; worldBooks: WorldBook[] }>('/api/admin/config/world-books', { method: 'POST', body: JSON.stringify(input) });
}

export function createWorldBookEntry(worldBookId: string, input: Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>) {
  return jsonRequest<{ entry: WorldBookEntry; entries: WorldBookEntry[] }>(`/api/admin/config/world-books/${worldBookId}/entries`, { method: 'POST', body: JSON.stringify(input) });
}

export function listScriptCards() {
  return jsonRequest<{ scriptCards: ScriptCard[] }>('/api/admin/resources/script-cards');
}

export function importSillyTavernScriptCard(characterCard: JsonObject) {
  return jsonRequest<{ scriptCard: ScriptCard; importedWorldBook: ResourceWorldBook | null; warnings: string[] }>('/api/admin/resources/script-cards/import/sillytavern', { method: 'POST', body: JSON.stringify({ characterCard }) });
}

export function getScriptCard(scriptCardId: string) {
  return jsonRequest<{ scriptCard: ScriptCard }>(`/api/admin/resources/script-cards/${scriptCardId}`);
}

export function deleteScriptCard(scriptCardId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/resources/script-cards/${scriptCardId}`, { method: 'DELETE' });
}

export function listResourceWorldBooks() {
  return jsonRequest<{ worldBooks: ResourceWorldBook[]; entries: ResourceWorldBookEntry[] }>('/api/admin/resources/world-books');
}

export function importSillyTavernWorldBook(worldBook: JsonObject, fallbackName?: string) {
  return jsonRequest<{ worldBook: ResourceWorldBook; entries: ResourceWorldBookEntry[]; warnings: string[] }>('/api/admin/resources/world-books/import/sillytavern', { method: 'POST', body: JSON.stringify({ worldBook, ...(fallbackName ? { fallbackName } : {}) }) });
}

export function getResourceWorldBook(worldBookId: string) {
  return jsonRequest<{ worldBook: ResourceWorldBook; entries: ResourceWorldBookEntry[] }>(`/api/admin/resources/world-books/${worldBookId}`);
}

export function getResourceWorldBookEntries(worldBookId: string) {
  return jsonRequest<{ entries: ResourceWorldBookEntry[] }>(`/api/admin/resources/world-books/${worldBookId}/entries`);
}

export function deleteResourceWorldBook(worldBookId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/resources/world-books/${worldBookId}`, { method: 'DELETE' });
}

export function listPresetPackages() {
  return jsonRequest<{ presetPackages: PromptPresetPackage[] }>('/api/admin/resources/preset-packages');
}

export function importSillyTavernPresetPackage(input: { openAiSettings: JsonObject; contextTemplate?: JsonValue; instructTemplate?: JsonValue; sysprompt?: JsonValue; reasoningTemplate?: JsonValue }) {
  return jsonRequest<{ presetPackage: PromptPresetPackage; warnings: string[] }>('/api/admin/resources/preset-packages/import/sillytavern', { method: 'POST', body: JSON.stringify(input) });
}

export function getPresetPackage(presetPackageId: string) {
  return jsonRequest<{ presetPackage: PromptPresetPackage }>(`/api/admin/resources/preset-packages/${presetPackageId}`);
}

export function deletePresetPackage(presetPackageId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/resources/preset-packages/${presetPackageId}`, { method: 'DELETE' });
}

export function createResourceImportJob(input: ResourceImportInput) {
  return jsonRequest<{ job: ResourceImportJob; drafts: ResourceImportDraft[] }>('/api/admin/resources/import-jobs', { method: 'POST', body: JSON.stringify(input) });
}

export function listResourceImportJobs() {
  return jsonRequest<{ jobs: ResourceImportJob[] }>('/api/admin/resources/import-jobs');
}

export function listResourceImportDrafts(filters: {
  status?: ResourceImportDraftStatus;
  kind?: ResourceImportDraftKind;
  sourceType?: ResourceImportSourceType;
  ruleset?: ResourceImportRuleset;
  language?: string;
} = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.sourceType) params.set('sourceType', filters.sourceType);
  if (filters.ruleset) params.set('ruleset', filters.ruleset);
  if (filters.language) params.set('language', filters.language);
  const query = params.toString();
  return jsonRequest<{ drafts: ResourceImportDraft[] }>(`/api/admin/resources/import-drafts${query ? `?${query}` : ''}`);
}

export function reviewResourceImportDraft(draftId: string, input: { status: Exclude<ResourceImportDraftStatus, 'pending'>; rejectionReason?: string }) {
  return jsonRequest<{ draft: ResourceImportDraft }>(`/api/admin/resources/import-drafts/${draftId}/review`, { method: 'PUT', body: JSON.stringify(input) });
}

export function getApprovedCatalogs() {
  return jsonRequest<{ ruleEntries: RuleWorldBookEntry[]; characterOptions: CharacterOption[]; resourceRules: ResourceRule[] }>('/api/admin/resources/approved-catalogs');
}

export function getRoomScriptBinding(roomId: string) {
  return jsonRequest<{ binding: RoomScriptBinding | null }>(`/api/admin/rooms/${roomId}/resource-bindings/script`);
}

export function putRoomScriptBinding(roomId: string, scriptCardId: string) {
  return jsonRequest<{ binding: RoomScriptBinding }>(`/api/admin/rooms/${roomId}/resource-bindings/script`, { method: 'PUT', body: JSON.stringify({ scriptCardId }) });
}

export function deleteRoomScriptBinding(roomId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/rooms/${roomId}/resource-bindings/script`, { method: 'DELETE' });
}

export function getRoomWorldBookBindings(roomId: string) {
  return jsonRequest<{ bindings: RoomWorldBookBinding[] }>(`/api/admin/rooms/${roomId}/resource-bindings/world-books`);
}

export function putRoomWorldBookBindings(roomId: string, bindings: Array<{ worldBookId: string; enabled: boolean; orderIndex: number }>) {
  return jsonRequest<{ bindings: RoomWorldBookBinding[] }>(`/api/admin/rooms/${roomId}/resource-bindings/world-books`, { method: 'PUT', body: JSON.stringify({ bindings }) });
}

export function getRoomPresetBinding(roomId: string) {
  return jsonRequest<{ binding: RoomPresetBinding | null }>(`/api/admin/rooms/${roomId}/resource-bindings/preset-package`);
}

export function putRoomPresetBinding(roomId: string, presetPackageId: string) {
  return jsonRequest<{ binding: RoomPresetBinding }>(`/api/admin/rooms/${roomId}/resource-bindings/preset-package`, { method: 'PUT', body: JSON.stringify({ presetPackageId }) });
}

export function deleteRoomPresetBinding(roomId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/rooms/${roomId}/resource-bindings/preset-package`, { method: 'DELETE' });
}

export function putGlobalScriptCard(scriptCardId: string) {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/script-card', { method: 'PUT', body: JSON.stringify({ scriptCardId }) });
}

export function clearGlobalScriptCard() {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/script-card', { method: 'DELETE' });
}

export function putGlobalResourceWorldBookBindings(bindings: Array<{ worldBookId: string; enabled: boolean; orderIndex: number }>) {
  return jsonRequest<{ bindings: GlobalResourceWorldBookBinding[] }>('/api/admin/config/resource-world-books', { method: 'PUT', body: JSON.stringify({ bindings }) });
}

export function putGlobalPresetPackage(presetPackageId: string) {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/preset-package', { method: 'PUT', body: JSON.stringify({ presetPackageId }) });
}

export function clearGlobalPresetPackage() {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/preset-package', { method: 'DELETE' });
}

export function getPlayerState(token: string) {
  return jsonRequest<PlayerVisibleState>(`/api/player/${token}/state`);
}

export async function generatePlayerTurnSuggestions(token: string) {
  const timeoutMs = await getAiTimeoutMs();
  return jsonRequest<{ suggestions: PlayerTurnSuggestion[]; status: PlayerTurnSuggestionStatus; error?: string }>(`/api/player/${token}/turn-suggestions`, {
    method: 'POST'
  }, {
    timeoutMs,
    timeoutLabel: '玩家回合建议生成'
  });
}

export function submitAction(token: string, text: string, actionType?: string, isHiddenRoll?: boolean, visibility?: 'public' | 'private' | 'dm_only') {
  return jsonRequest<{ ok: true }>(`/api/player/${token}/actions`, {
    method: 'POST',
    body: JSON.stringify({ text, ...(actionType ? { actionType } : {}), ...(visibility ? { visibility } : {}), ...(isHiddenRoll !== undefined ? { isHiddenRoll } : {}) })
  });
}

export function respondToInteraction(token: string, interactionId: string, response: string) {
  return jsonRequest<{ ok: true }>(`/api/player/${token}/interactions/${interactionId}/respond`, { method: 'POST', body: JSON.stringify({ response }) });
}

export async function sendDmChatMessage(token: string, message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const timeoutMs = await getAiTimeoutMs();
  return jsonRequest<{ reply: string }>(`/api/player/${token}/dm-chat`, { method: 'POST', body: JSON.stringify({ message, history }) }, { timeoutMs, timeoutLabel: 'DM 助手' });
}

export function loadDmChatHistory(token: string) {
  return jsonRequest<{ messages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: string }> }>(`/api/player/${token}/dm-chat/history`);
}

export function getCharacterBuilderOptions(token: string) {
  return jsonRequest<{ options: CharacterBuilderOptions }>(`/api/player/${token}/character-builder/options`);
}

export function auditCharacterBuilderDraft(token: string, draft: CharacterBuilderDraft) {
  return jsonRequest<{ draft: CharacterBuilderDraft; audit: CharacterBuilderAudit }>(`/api/player/${token}/character-builder/audit`, { method: 'POST', body: JSON.stringify({ draft }) });
}

export function saveCharacterBuilderDraft(token: string, draft: CharacterBuilderDraft) {
  return jsonRequest<{ character: { id: string; confirmed: boolean } }>(`/api/player/${token}/character-builder/draft`, { method: 'PUT', body: JSON.stringify({ draft }) });
}

export function confirmCharacterBuilderDraft(token: string, draft?: CharacterBuilderDraft) {
  return jsonRequest<{ character: { id: string; confirmed: boolean } }>(`/api/player/${token}/character-builder/confirm`, {
    method: 'POST',
    ...(draft ? { body: JSON.stringify({ draft }) } : {})
  }, {
    timeoutMs: CHARACTER_CONFIRM_TIMEOUT_MS,
    timeoutLabel: '角色确认与个人开场生成'
  });
}

export function restCharacter(roomId: string, characterId: string, input: RestInput) {
  return jsonRequest<RestResponse>(`/api/admin/rooms/${roomId}/characters/${characterId}/rest`, { method: 'POST', body: JSON.stringify(input) });
}

export function listCharacterResourceChanges(roomId: string, filters: { characterId?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.characterId) params.set('characterId', filters.characterId);
  const query = params.toString();
  return jsonRequest<AuditListResponse>(`/api/admin/rooms/${roomId}/character-resource-changes${query ? `?${query}` : ''}`);
}

export function rollbackCharacterResourceChange(roomId: string, changeId: string, adminId: string) {
  return jsonRequest<RollbackResponse>(`/api/admin/rooms/${roomId}/character-resource-changes/${changeId}/rollback`, { method: 'POST', body: JSON.stringify({ adminId }) });
}

export interface AdminCombatant {
  id: string;
  characterId: string | null;
  npcId: string | null;
  name: string;
  initiative: number | null;
  hp: { current: number; max: number };
  ac: number;
  isPlayer: boolean;
  conditions: string[];
}

export interface AdminCombatState {
  id: string;
  roomId: string;
  round: number;
  currentTurn: number;
  combatants: AdminCombatant[];
  status: 'active' | 'paused' | 'ended';
  startedAt: string;
}

export function adminDiceRoll(roomId: string, input: { diceType: string; modifier?: number; dc?: number; reason: string }) {
  return jsonRequest<{ values: number[]; modifier: number; total: number; success: boolean | null; diceLog: { id: string } }>(`/api/admin/rooms/${roomId}/dice/roll`, { method: 'POST', body: JSON.stringify(input) });
}

export function startCombat(roomId: string, input: { combatants: Array<{ characterId?: string | null; npcId?: string | null; name: string; hp?: number; ac?: number; dexMod?: number }> }) {
  return jsonRequest<{ combatState: AdminCombatState }>(`/api/admin/rooms/${roomId}/combat/start`, { method: 'POST', body: JSON.stringify(input) });
}

export function rollCombatInitiative(roomId: string, combatId: string) {
  return jsonRequest<{ combatState: AdminCombatState }>(`/api/admin/rooms/${roomId}/combat/roll-initiative`, { method: 'POST', body: JSON.stringify({ combatId }) });
}

export function combatAttack(roomId: string, input: { combatId: string; attackerIndex: number; targetIndex: number; weaponDie?: string }) {
  return jsonRequest<{ combatState: AdminCombatState; hit: boolean; criticalHit: boolean; criticalMiss: boolean; attackRoll: number; attackTotal: number; damageTotal?: number }>(`/api/admin/rooms/${roomId}/combat/attack`, { method: 'POST', body: JSON.stringify(input) });
}

export function combatNextTurn(roomId: string, combatId: string) {
  return jsonRequest<{ combatState: AdminCombatState }>(`/api/admin/rooms/${roomId}/combat/next-turn`, { method: 'POST', body: JSON.stringify({ combatId }) });
}

export function getCombatState(roomId: string) {
  return jsonRequest<{ combatState: AdminCombatState }>(`/api/admin/rooms/${roomId}/combat`);
}

export function getDiceLogs(roomId: string) {
  return jsonRequest<{ logs: Array<{ id: string; roomId: string; turnId: string | null; combatId: string | null; characterId: string | null; diceType: string; values: number[]; modifier: number; total: number; dc: number | null; success: boolean | null; isPublic: boolean; reason: string; createdAt: string }> }>(`/api/admin/rooms/${roomId}/dice-logs`);
}

export function listSessionSummaries(roomId: string) {
  return jsonRequest<{ summaries: SessionSummary[] }>(`/api/admin/rooms/${roomId}/summaries`);
}

export function triggerSessionSummary(roomId: string) {
  return jsonRequest<{ summary: SessionSummary }>(`/api/admin/rooms/${roomId}/summaries`, { method: 'POST' });
}

export function listQuests(roomId: string) {
  return jsonRequest<{ quests: CampaignQuest[] }>(`/api/admin/rooms/${roomId}/quests`);
}

export function updateQuest(roomId: string, input: { title: string; status: CampaignQuest['status']; description: string }) {
  return jsonRequest<{ quest: CampaignQuest }>(`/api/admin/rooms/${roomId}/quests`, { method: 'PUT', body: JSON.stringify(input) });
}

export function listNpcs(roomId: string) {
  return jsonRequest<{ npcs: CampaignNpc[] }>(`/api/admin/rooms/${roomId}/npcs`);
}

export function updateNpc(roomId: string, input: { name: string; role: string; attitude: CampaignNpc['attitude']; notes: string; location: string }) {
  return jsonRequest<{ npc: CampaignNpc }>(`/api/admin/rooms/${roomId}/npcs`, { method: 'PUT', body: JSON.stringify(input) });
}

export function listLocations(roomId: string) {
  return jsonRequest<{ locations: CampaignLocation[] }>(`/api/admin/rooms/${roomId}/locations`);
}

export function updateLocation(roomId: string, input: { name: string; description: string }) {
  return jsonRequest<{ location: CampaignLocation }>(`/api/admin/rooms/${roomId}/locations`, { method: 'PUT', body: JSON.stringify(input) });
}

export function listPresetTemplates() {
  return jsonRequest<{ templates: PresetTemplateMeta[] }>('/api/admin/preset-templates');
}

export function applyPresetTemplate(presetType: PresetType) {
  return jsonRequest<{ preset: PromptPreset; presets: PromptPreset[] }>(`/api/admin/preset-templates/${presetType}/apply`, { method: 'POST' });
}

export function getActivePresetType() {
  return jsonRequest<{ presetType: PresetType | null }>('/api/admin/active-preset-type');
}

export function subscribeRoom(roomId: string, onUpdate: () => void): () => void {
  const events = new EventSource(eventSourceUrl(`/events/rooms/${roomId}`));
  events.addEventListener('room-updated', onUpdate);
  return () => events.close();
}

// --- Database Management Center APIs ---

export function listDbSources() {
  return jsonRequest<{ sources: RemoteDbSource[] }>('/api/admin/db/sources');
}

export function listDbSourceSheets(sourceId: string) {
  return jsonRequest<{ sheets: RemoteDbSheet[] }>(`/api/admin/db/sources/${sourceId}/sheets`);
}

export function listRoomDbSourceBindings(roomId: string) {
  return jsonRequest<{ bindings: RoomDbSourceBinding[] }>(`/api/admin/rooms/${roomId}/db/sources`);
}

export function putRoomDbSourceBindings(roomId: string, bindings: Array<{ sourceId: string; enabled: boolean; orderIndex: number }>) {
  return jsonRequest<{ bindings: RoomDbSourceBinding[] }>(`/api/admin/rooms/${roomId}/db/sources`, {
    method: 'PUT',
    body: JSON.stringify({ bindings })
  });
}

export function listRoomDbSheets(roomId: string) {
  return jsonRequest<{ sheets: RemoteDbSheet[] }>(`/api/admin/rooms/${roomId}/db/sheets`);
}

export function listRoomDbRows(roomId: string, sheetId: string) {
  return jsonRequest<{ rows: RemoteDbRow[] }>(`/api/admin/rooms/${roomId}/db/sheets/${sheetId}/rows`);
}

export function putRoomDbRow(roomId: string, sheetId: string, rowKey: string, data: Record<string, unknown>) {
  return jsonRequest<{ row: RemoteDbRow }>(`/api/admin/rooms/${roomId}/db/sheets/${sheetId}/rows/${encodeURIComponent(rowKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ data })
  });
}

export function checkDbSourceUpdates(sourceId: string) {
  return jsonRequest<{ hasUpdate: boolean; newHash?: string; newSize?: number; newEntryCount?: number }>(
    `/api/admin/db/sources/${sourceId}/check-updates`,
    { method: 'POST' }
  );
}

export function updateDbSource(sourceId: string) {
  return jsonRequest<{
    source: RemoteDbSource;
    sourceType: string;
    worldBook?: { name: string; id: string };
    presetPackage?: { name: string; id: string };
    draftsCount: number;
    sheetsCount?: number;
  }>(`/api/admin/db/sources/${sourceId}/update`, { method: 'POST' });
}

export function deleteDbSource(sourceId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/db/sources/${sourceId}`, { method: 'DELETE' });
}
