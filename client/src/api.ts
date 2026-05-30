import type {
  AdminState,
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
  PlayerVisibleState,
  PresetTemplateMeta,
  PresetType,
  PromptPreset,
  PromptPresetPackage,
  PromptPreviewResponse,
  RemoteDbSource,
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
  RoomPresetBinding,
  RoomScriptBinding,
  RoomWorldBookBinding,
  RuleRetrievalMatch,
  RuleWorldBookEntry,
  ScriptCard,
  SessionSummary,
  WorldBook,
  WorldBookEntry
} from './types';

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
        message = payload.error;
      }
    } catch {
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function createRoom(input: { name: string }) {
  return jsonRequest<{ roomId: string; adminUrl: string }>('/api/admin/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: input.name })
  });
}

export function addPlayer(roomId: string, name: string) {
  return jsonRequest<{ playerId: string; token: string; playerUrl: string }>(`/api/admin/rooms/${roomId}/players`, { method: 'POST', body: JSON.stringify({ name }) });
}

export function getAdminState(roomId: string) {
  return jsonRequest<AdminState>(`/api/admin/rooms/${roomId}`);
}

export function processTurn(roomId: string) {
  return jsonRequest<{ result: unknown }>(`/api/admin/rooms/${roomId}/process-turn`, { method: 'POST' });
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

type PresetSaveInput = Omit<PromptPreset, 'id' | 'roomId' | 'createdAt' | 'updatedAt'> & { id?: string };

export function savePreset(preset: PresetSaveInput) {
  const method = preset.id ? 'PUT' : 'POST';
  const url = preset.id ? `/api/admin/config/presets/${preset.id}` : '/api/admin/config/presets';
  return jsonRequest<{ preset: PromptPreset; presets: PromptPreset[] }>(url, { method, body: JSON.stringify(preset) });
}

export function activatePreset(presetId: string) {
  return jsonRequest<{ preset: PromptPreset; presets: PromptPreset[] }>(`/api/admin/config/presets/${presetId}/activate`, { method: 'POST' });
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

export function submitAction(token: string, text: string, actionType?: string, isHiddenRoll?: boolean) {
  return jsonRequest<{ ok: true }>(`/api/player/${token}/actions`, {
    method: 'POST',
    body: JSON.stringify({ text, ...(actionType ? { actionType } : {}), ...(isHiddenRoll !== undefined ? { isHiddenRoll } : {}) })
  });
}

export function respondToInteraction(token: string, interactionId: string, response: string) {
  return jsonRequest<{ ok: true }>(`/api/player/${token}/interactions/${interactionId}/respond`, { method: 'POST', body: JSON.stringify({ response }) });
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

export function confirmCharacterBuilderDraft(token: string) {
  return jsonRequest<{ character: { id: string; confirmed: boolean } }>(`/api/player/${token}/character-builder/confirm`, { method: 'POST' });
}

export function restCharacter(roomId: string, characterId: string, input: RestInput) {
  return jsonRequest<RestResponse>(`/api/admin/rooms/${roomId}/characters/${characterId}/rest`, { method: 'POST', body: JSON.stringify(input) });
}

export function listCharacterResourceChanges(roomId: string, filters: { characterId: string }) {
  const params = new URLSearchParams();
  params.set('characterId', filters.characterId);
  return jsonRequest<AuditListResponse>(`/api/admin/rooms/${roomId}/character-resource-changes?${params.toString()}`);
}

export function rollbackCharacterResourceChange(roomId: string, changeId: string, adminId: string) {
  return jsonRequest<RollbackResponse>(`/api/admin/rooms/${roomId}/character-resource-changes/${changeId}/rollback`, { method: 'POST', body: JSON.stringify({ adminId }) });
}

export function adminDiceRoll(roomId: string, input: { die: string; modifier?: number; dc?: number; reason?: string }) {
  return jsonRequest<{ values: number[]; modifier: number; total: number; success?: boolean }>(`/api/admin/rooms/${roomId}/dice/roll`, { method: 'POST', body: JSON.stringify(input) });
}

export function startCombat(roomId: string, input: { participants: Array<{ name: string; hp: number; ac?: number; initiativeModifier?: number }> }) {
  return jsonRequest<{ id: string; roomId: string; participants: Array<{ id: string; name: string; hp: number; maxHp: number; ac: number; initiative: number | null; isNpc: boolean }>; currentTurnIndex: number; round: number; status: string }>(`/api/admin/rooms/${roomId}/combat/start`, { method: 'POST', body: JSON.stringify(input) });
}

export function rollCombatInitiative(roomId: string, combatId: string) {
  return jsonRequest<{ id: string; participants: Array<{ id: string; name: string; hp: number; maxHp: number; ac: number; initiative: number | null; isNpc: boolean }>; currentTurnIndex: number; round: number; status: string }>(`/api/admin/rooms/${roomId}/combat/${combatId}/initiative`, { method: 'POST' });
}

export function combatAttack(roomId: string, input: { combatId: string; attackerId: string; targetId: string; attackBonus?: number; damageDice?: string; damageBonus?: number }) {
  return jsonRequest<{ hit: boolean; attackRoll?: { values: number[]; modifier: number; total: number }; damage?: { dice: string; bonus: number; total: number }; newHp?: number }>(`/api/admin/rooms/${roomId}/combat/attack`, { method: 'POST', body: JSON.stringify(input) });
}

export function combatNextTurn(roomId: string, combatId: string) {
  return jsonRequest<{ id: string; participants: Array<{ id: string; name: string; hp: number; maxHp: number; ac: number; initiative: number | null; isNpc: boolean }>; currentTurnIndex: number; round: number; status: string }>(`/api/admin/rooms/${roomId}/combat/${combatId}/next-turn`, { method: 'POST' });
}

export function getCombatState(roomId: string) {
  return jsonRequest<{ id: string; roomId: string; participants: Array<{ id: string; name: string; hp: number; maxHp: number; ac: number; initiative: number | null; isNpc: boolean }>; currentTurnIndex: number; round: number; status: string }>(`/api/admin/rooms/${roomId}/combat`);
}

export function getDiceLogs(roomId: string) {
  return jsonRequest<{ logs: Array<{ id: string; roomId: string; playerName: string; die: string; values: number[]; modifier: number; total: number; reason: string; success?: boolean; createdAt: string }> }>(`/api/admin/rooms/${roomId}/dice/logs`);
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
  const events = new EventSource(`/events/rooms/${roomId}`);
  events.addEventListener('room-updated', onUpdate);
  return () => events.close();
}

// --- Database Management Center APIs ---

export function importFromUrl(url: string, fallbackName?: string) {
  return jsonRequest<{
    source: RemoteDbSource;
    sourceType: string;
    worldBook?: { name: string; id: string };
    presetPackage?: { name: string; id: string };
    draftsCount: number;
  }>('/api/admin/db/import-from-url', {
    method: 'POST',
    body: JSON.stringify({ url, ...(fallbackName ? { fallbackName } : {}) })
  });
}

export function listDbSources() {
  return jsonRequest<{ sources: RemoteDbSource[] }>('/api/admin/db/sources');
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
  }>(`/api/admin/db/sources/${sourceId}/update`, { method: 'POST' });
}

export function deleteDbSource(sourceId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/db/sources/${sourceId}`, { method: 'DELETE' });
}

export function importJsDatabase(jsCode: string, name: string) {
  return jsonRequest<{
    source: RemoteDbSource;
    sourceType: string;
    worldBook?: { name: string; id: string };
    presetPackage?: { name: string; id: string };
    draftsCount: number;
    preview: { entryTypes: Array<{ type: string; count: number }> };
  }>('/api/admin/db/import-js', {
    method: 'POST',
    body: JSON.stringify({ jsCode, name })
  });
}
