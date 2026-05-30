export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RoomStatus = 'setup' | 'waiting_for_actions' | 'processing' | 'waiting_for_interaction' | 'needs_admin_attention';
export type TurnStatus = 'open' | 'waiting_for_actions' | 'ready_to_resolve' | 'locked' | 'processing' | 'resolving' | 'waiting_for_interaction' | 'complete' | 'resolved' | 'needs_admin_attention';
export type ActionStatus = 'submitted' | 'processing' | 'complete';
export type VisibilityScope = 'public' | 'private' | 'admin';
export type InteractionStatus = 'pending_target' | 'ready_for_ai' | 'resolved';
export type PromptBlockRole = 'system' | 'user' | 'assistant';
export type PromptBlockPosition = 'before_world' | 'after_world' | 'before_actions' | 'after_actions' | 'final';
export type WorldBookPosition = 'before_world' | 'after_world' | 'before_actions' | 'after_actions';
export type PresetType = 'tutorial' | 'rules_strict' | 'story_first' | 'combat_first' | 'casual' | 'dark_fantasy' | 'sandbox' | 'epic';
export type ModuleCategory = 'core_identity' | 'player_boundary' | 'npc_autonomy' | 'anti_omniscience' | 'style' | 'perspective' | 'pacing' | 'rules_judgment' | 'status_update' | 'summary' | 'worldbook_injection';
export type SceneType = 'exploration' | 'social' | 'combat' | 'all';

export interface AiConfig {
  coreRules: string;
  playerAgencyRules: string;
  visibilityRules: string;
  interactionRules: string;
  outputFormatRules: string;
  styleRules: string;
}

export type AiProviderKind = 'mock' | 'openai-compatible';

export interface AiProviderConfig {
  provider: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type EmbeddingProviderKind = 'mock' | 'openai-compatible';

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface RuleRetrievalMatch {
  entryId: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  score: number;
  reasons: Array<'keyword' | 'semantic'>;
}

export interface RuleSummary {
  entryId: string;
  title: string;
  summary: string;
  reason: string;
  createdAt: string;
}

export interface Room {
  id: string;
  name: string;
  systemPrompt: string;
  worldInfo: string;
  currentTurn: number;
  status: RoomStatus;
  aiConfig: AiConfig;
  createdAt: string;
}

export interface Player {
  id: string;
  roomId: string;
  name: string;
  token: string;
  isConnected: boolean;
  createdAt: string;
}

export interface CharacterBuilderOption {
  id: string;
  optionType: CharacterOptionType;
  name: string;
  summary: string;
  ruleData: JsonValue;
  prerequisites: JsonValue;
  sourceRef: string;
}

export interface CharacterBuilderOptions {
  species: CharacterBuilderOption[];
  classes: CharacterBuilderOption[];
  backgrounds: CharacterBuilderOption[];
  skills: CharacterBuilderOption[];
  equipment: CharacterBuilderOption[];
  spells: CharacterBuilderOption[];
  languages: CharacterBuilderOption[];
  proficiencies: CharacterBuilderOption[];
}

export interface CharacterBuilderDraft {
  name: string;
  concept: string;
  species: string;
  className: string;
  background: string;
  abilityScores: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
  skills: string[];
  equipment: string[];
  spells: string[];
  languages: string[];
  proficiencies: string[];
  personality: string;
  ideal: string;
  bond: string;
  flaw: string;
  notes: string;
}

export interface CharacterBuilderAuditIssue {
  field: string;
  message: string;
}

export interface CharacterBuilderAudit {
  valid: boolean;
  issues: CharacterBuilderAuditIssue[];
}

export interface CharacterSheet {
  name: string;
  species: string;
  className: string;
  level: number;
  abilityScores: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
  hitPoints: { current: number; max: number };
  armorClass: number;
  proficiencyBonus: number;
  skills: string[];
  equipment: string[];
  spells: string[];
  languages?: string[];
  proficiencies?: string[];
  privateNotes: string;
  background?: string;
  concept?: string;
  personality?: string;
  ideal?: string;
  bond?: string;
  flaw?: string;
  builderDraft?: CharacterBuilderDraft;
}

export interface CharacterRecord {
  id: string;
  playerId: string;
  sheet: CharacterSheet;
  draftSource: 'ai' | 'manual';
  confirmed: boolean;
  updatedAt: string;
}

export interface Turn {
  id: string;
  roomId: string;
  number: number;
  status: TurnStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface TurnReadiness {
  turnId: string | null;
  status: TurnStatus | null;
  requiredActorIds: string[];
  submittedActorIds: string[];
  skippedActorIds: string[];
  excludedActorIds: string[];
  completedActorIds: string[];
  missingActorIds: string[];
  ready: boolean;
}

export interface PlayerAction {
  id: string;
  roomId: string;
  turnId: string;
  playerId: string;
  text: string;
  submittedAt: string;
  status: ActionStatus;
  actionType?: 'narrative' | 'exploration' | 'social' | 'combat' | 'ooc';
  isHiddenRoll?: boolean;
}

export interface InteractionRequest {
  id: string;
  roomId: string;
  turnId: string;
  sourcePlayerId: string;
  targetPlayerId: string;
  type: string;
  prompt: string;
  targetResponse: string | null;
  status: InteractionStatus;
  createdAt: string;
}

export interface LogEntry {
  id: string;
  roomId: string;
  turnId: string | null;
  visibilityScope: VisibilityScope;
  playerId: string | null;
  title: string;
  content: string;
  createdAt: string;
}

export interface AiGeneration {
  id: string;
  roomId: string;
  turnId: string | null;
  provider: string;
  inputSummary: string;
  output: string;
  error: string | null;
  createdAt: string;
}

export interface PlayerVisibleState {
  room: Pick<Room, 'id' | 'name' | 'worldInfo' | 'currentTurn' | 'status'>;
  player: Pick<Player, 'id' | 'name'>;
  character: CharacterRecord | null;
  publicLogs: LogEntry[];
  privateLogs: LogEntry[];
  pendingInteractions: InteractionRequest[];
  submittedPlayers: string[];
  waitingPlayers: string[];
  ruleSummaries: RuleSummary[];
  resources?: CharacterResources;
  recentChanges?: Array<{ id: string; changeType: string; path: string; before: unknown; after: unknown; reason: string; createdAt: string }>;
  combatState?: CombatState;
  recentDiceLogs?: DiceLogEntry[];
  campaignSummary?: SessionSummary | null;
  quests?: CampaignQuest[];
  npcs?: CampaignNpc[];
}

export interface CharacterResources {
  hitPoints: { current: number; max: number; temp: number };
  hitDice: { total: number; remaining: number; die: string };
  spellSlots: Record<string, { total: number; used: number }>;
  ammo: Array<{ name: string; current: number; max: number }>;
  consumables: Array<{ name: string; quantity: number }>;
  currency: { gp: number; sp: number; cp: number };
  conditions: string[];
}

export interface PromptBlock {
  id?: string;
  presetId?: string;
  name: string;
  role: PromptBlockRole;
  position: PromptBlockPosition;
  enabled: boolean;
  orderIndex: number;
  content: string;
  category?: ModuleCategory;
  sceneType?: SceneType;
}

export interface PromptPreset {
  id: string;
  roomId: string;
  name: string;
  description: string;
  isActive: boolean;
  blocks: PromptBlock[];
  createdAt: string;
  updatedAt: string;
  presetType?: PresetType;
  isTemplate?: boolean;
}

export interface WorldBook {
  id: string;
  roomId: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorldBookEntry {
  id: string;
  worldBookId: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  priority: number;
  position: WorldBookPosition;
  createdAt: string;
  updatedAt: string;
}

export type ResourceSourceType = 'sillytavern_character' | 'sillytavern_world_book' | 'sillytavern_preset_package';
export type ImportedWorldBookPosition = 'before' | 'after';

export interface ScriptCard {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  visibilityNotes: string;
  sourceType: ResourceSourceType;
  rawJson: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceWorldBook {
  id: string;
  name: string;
  sourceType: ResourceSourceType;
  rawJson: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceWorldBookEntry {
  id: string;
  worldBookId: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  priority: number;
  orderIndex: number;
  position: ImportedWorldBookPosition;
  rawJson: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface PromptPresetPackage {
  id: string;
  name: string;
  sourceType: ResourceSourceType;
  openAiSettings: JsonValue;
  contextTemplate: JsonValue | null;
  instructTemplate: JsonValue | null;
  sysprompt: JsonValue | null;
  reasoningTemplate: JsonValue | null;
  rawJson: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export type ResourceImportDraftKind =
  | 'rule_entry'
  | 'character_option'
  | 'resource_rule'
  | 'worldbook_entry'
  | 'spell'
  | 'monster'
  | 'item'
  | 'npc'
  | 'campaign_entry'
  | 'preset_module';
export type ResourceImportDraftStatus = 'pending' | 'approved' | 'rejected';
export type ResourceImportSourceType = 'local_json' | 'phb_extraction' | 'sillytavern_worldbook' | 'sillytavern_preset' | 'remote_url' | 'manual';
export type ResourceImportRuleset = '5e-2014' | '5e-2024' | 'homebrew' | 'unknown';
export type ResourceImportVisibility = 'private' | 'campaign' | 'workspace' | 'public';
export type CharacterOptionType = 'species' | 'class' | 'background' | 'skill' | 'equipment' | 'spell' | 'language' | 'proficiency';

export interface ResourceImportJob {
  id: string;
  name: string;
  sourceType: ResourceImportSourceType;
  sourceName: string;
  sourceFileName: string;
  sourceUrl: string;
  sourceVersion: string;
  sourceHash: string;
  sourceLicense: string;
  ruleset: ResourceImportRuleset;
  language: string;
  visibility: ResourceImportVisibility;
  isPrivate: boolean;
  importedBy: string;
  status: 'imported' | 'failed';
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceImportDraft {
  id: string;
  jobId: string;
  kind: ResourceImportDraftKind;
  sourceType: ResourceImportSourceType;
  sourceName: string;
  sourceFileName: string;
  sourceUrl: string;
  sourceVersion: string;
  sourceHash: string;
  sourceLicense: string;
  ruleset: ResourceImportRuleset;
  language: string;
  visibility: ResourceImportVisibility;
  isPrivate: boolean;
  importedBy: string;
  contentHash: string;
  title: string;
  category: string;
  optionType: CharacterOptionType | null;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  ruleData: JsonValue;
  prerequisites: JsonValue;
  raw: JsonValue;
  status: ResourceImportDraftStatus;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterOption {
  id: string;
  draftId: string;
  optionType: CharacterOptionType;
  name: string;
  summary: string;
  ruleData: JsonValue;
  prerequisites: JsonValue;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleWorldBookEntry {
  id: string;
  draftId: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceRule {
  id: string;
  draftId: string;
  name: string;
  category: string;
  summary: string;
  ruleData: JsonValue;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceImportInput {
  name: string;
  sourceType?: ResourceImportSourceType;
  sourceName?: string;
  sourceFileName?: string;
  sourceUrl?: string;
  sourceVersion?: string;
  sourceHash?: string;
  sourceLicense?: string;
  ruleset?: ResourceImportRuleset;
  language?: string;
  visibility?: ResourceImportVisibility;
  isPrivate?: boolean;
  importedBy?: string;
  drafts: Array<{
    kind: ResourceImportDraftKind;
    title: string;
    category?: string;
    optionType?: CharacterOptionType;
    summary: string;
    content?: string;
    keys?: string[];
    sourceRef?: string;
    ruleData?: JsonValue;
    prerequisites?: JsonValue;
    priority?: number;
    status?: 'pending';
  }>;
}

export interface RoomScriptBinding {
  roomId: string;
  scriptCardId: string;
  bindingType: 'main';
  enabled: boolean;
  createdAt: string;
}

export interface RoomWorldBookBinding {
  roomId: string;
  worldBookId: string;
  enabled: boolean;
  orderIndex: number;
  createdAt: string;
}

export interface RoomPresetBinding {
  roomId: string;
  presetPackageId: string;
  enabled: boolean;
  createdAt: string;
}

export interface GlobalResourceWorldBookBinding {
  worldBookId: string;
  enabled: boolean;
  orderIndex: number;
  createdAt: string;
}

export interface GlobalConfigSnapshot {
  aiConfig: AiConfig;
  aiProviderConfig: AiProviderConfig;
  embeddingProviderConfig: EmbeddingProviderConfig;
  activeScriptCardId: string | null;
  activePresetPackageId: string | null;
  globalWorldBookBindings: GlobalResourceWorldBookBinding[];
  presets: PromptPreset[];
  worldBooks: WorldBook[];
  worldBookEntries: WorldBookEntry[];
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
}

export interface PromptPreviewMessage {
  role: PromptBlockRole;
  content: string;
}

export interface PromptPreviewSlot {
  key: string;
  source: string;
  content: string;
}

export interface PromptPreviewWorldBookMatch {
  worldBookId: string;
  entryId: string;
  keys: string[];
  reason: 'constant' | 'primary-key' | 'primary-and-secondary-key';
  position: ImportedWorldBookPosition;
  content: string;
}

export interface PromptPreviewRuleMatch {
  entryId: string;
  title: string;
  category: string;
  score: number;
  reasons: Array<'keyword' | 'semantic'>;
  summary: string;
}

export interface PromptPreviewBlock {
  identifier: string;
  source: 'st-preset' | 'runtime-slot' | 'dnd-contract' | 'native-preset';
  role: PromptBlockRole;
  content: string;
}

export interface PromptPreviewResponse {
  mode: 'native' | 'sillytavern-compatible';
  prompt: string;
  messages: PromptPreviewMessage[];
  slots: PromptPreviewSlot[];
  worldBookMatches: PromptPreviewWorldBookMatch[];
  ruleMatches: PromptPreviewRuleMatch[];
  promptBlocks: PromptPreviewBlock[];
  warnings: string[];
}

export interface AiTurnPromptContextSection {
  title: string;
  content: string;
}

export interface AiTurnPromptPreviewResponse {
  previewId: string;
  roomId: string;
  turnId: string | null;
  flatPrompt: string;
  messages: PromptPreviewMessage[];
  contextSections: AiTurnPromptContextSection[];
  warnings: string[];
}

export interface AiTurnPromptSendResponse {
  responseText: string;
  suggestedStateChanges: JsonValue[];
  raw: JsonValue;
}

export interface CharacterResourceChange {
  id: string;
  characterId: string;
  path: string;
  before: unknown;
  after: unknown;
  reason: string;
  actorType: string;
  actorId: string;
  createdAt: string;
  revertedAt: string | null;
  revertedBy: string | null;
}

export interface RestInput {
  action: 'short' | 'long';
  actorType: string;
  actorId: string;
  hitDiceSpent?: number;
}

export interface RestResponse {
  resources: CharacterResources;
}

export interface AuditListResponse {
  changes: CharacterResourceChange[];
}

export interface RollbackResponse {
  change: CharacterResourceChange;
}

export type DieType = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20';

export interface DiceRollInput {
  die: DieType;
  modifier?: number;
  dc?: number;
  reason?: string;
}

export interface DiceRollResult {
  values: number[];
  modifier: number;
  total: number;
  success?: boolean;
}

export interface SessionSummary {
  id: string;
  roomId: string;
  turnStart: number;
  turnEnd: number;
  summary: string;
  questUpdatesJson: string;
  npcUpdatesJson: string;
  locationUpdatesJson: string;
  characterUpdatesJson: string;
  createdAt: string;
}

export interface CampaignQuest {
  id: string;
  roomId: string;
  title: string;
  status: 'active' | 'in_progress' | 'completed' | 'failed';
  description: string;
  updatedAt: string;
}

export interface CampaignNpc {
  id: string;
  roomId: string;
  name: string;
  role: string;
  attitude: 'friendly' | 'neutral' | 'hostile' | 'unknown';
  notes: string;
  location: string;
  updatedAt: string;
}

export interface CampaignLocation {
  id: string;
  roomId: string;
  name: string;
  description: string;
  notes: string;
  updatedAt: string;
}

export interface DiceLogEntry {
  id: string;
  roomId: string;
  playerName: string;
  die: string;
  values: number[];
  modifier: number;
  total: number;
  reason: string;
  success?: boolean;
  createdAt: string;
}

export interface DiceLogsResponse {
  logs: DiceLogEntry[];
}

export interface CombatParticipant {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  ac: number;
  initiative: number | null;
  isNpc: boolean;
}

export interface CombatState {
  id: string;
  roomId: string;
  participants: CombatParticipant[];
  currentTurnIndex: number;
  round: number;
  status: 'active' | 'ended';
}

export interface CombatStartInput {
  participants: Array<{
    name: string;
    hp: number;
    ac?: number;
    initiativeModifier?: number;
  }>;
}

export interface CombatAttackInput {
  combatId: string;
  attackerId: string;
  targetId: string;
  attackBonus?: number;
  damageDice?: string;
  damageBonus?: number;
}

export interface CombatAttackResult {
  hit: boolean;
  attackRoll?: { values: number[]; modifier: number; total: number };
  damage?: { dice: string; bonus: number; total: number };
  newHp?: number;
}

export interface PresetTemplateMeta {
  type: PresetType;
  name: string;
  description: string;
  blockCount: number;
}

export interface RemoteDbSource {
  id: string;
  url: string;
  name: string;
  sourceType: 'world_book' | 'preset_package' | 'character_options' | 'rules_json' | 'unknown';
  version: string;
  fileHash: string;
  fileSize: number;
  entryCount: number;
  lastCheckedAt: string;
  createdAt: string;
}

export interface AdminState {
  room: Room;
  players: Player[];
  turns: Turn[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  logs: LogEntry[];
  aiGenerations: AiGeneration[];
  turnReadiness: TurnReadiness;
  globalConfig: GlobalConfigSnapshot;
  presets: PromptPreset[];
  worldBooks: WorldBook[];
  worldBookEntries: WorldBookEntry[];
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
  globalScriptCardId: string | null;
  globalWorldBookBindings: GlobalResourceWorldBookBinding[];
  globalPresetPackageId: string | null;
  roomScriptBinding: RoomScriptBinding | null;
  roomWorldBookBindings: RoomWorldBookBinding[];
  roomPresetBinding: RoomPresetBinding | null;
}
