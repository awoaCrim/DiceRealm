import { useEffect, useRef, useState } from 'react';
import { activatePreset, addPlayer, applyAiTurnPreview, applyPresetTemplate, checkDbSourceUpdates, createAiTurnPreview, createWorldBook, createWorldBookEntry, deleteDbSource, getActivePresetType, getAdminState, getGlobalAiProviderConfig, getGlobalEmbeddingProviderConfig, listCharacterResourceChanges, listDbSourceSheets, listDbSources, listLocations, listNpcs, listPresetTemplates, listQuests, listRoomDbRows, listRoomDbSheets, listRoomDbSourceBindings, listSessionSummaries, previewAiPrompt, putRoomDbRow, putRoomDbSourceBindings, reindexRuleEmbeddings, rollbackCharacterResourceChange, saveGlobalAiProviderConfig, saveGlobalEmbeddingProviderConfig, savePreset, sendAiTurnPreview, subscribeRoom, testGlobalAiProviderConfig, testGlobalEmbeddingProviderConfig, triggerSessionSummary, updateDbSource, updateLocation, updateNpc, updateQuest } from '../api';
import { LogList } from '../components/LogList';
import { CharacterCard } from '../components/CharacterCard';
import { PromptPreviewPanel } from '../components/PromptPreviewPanel';
import { ResourceImportPanel } from '../components/ResourceImportPanel';
import { GlobalResourceConfigPanel } from '../components/RoomResourceBindingsPanel';
import { actorTypeLabel, dbSourceTypeLabel, formatFileSize, formatIsoDateTime, moduleCategoryLabel, npcAttitudeLabel, presetTypeLabel, promptBlockPositionLabel, promptRoleLabel, questStatusLabel, roomStatusLabel, sceneTypeLabel } from '../displayLabels';
import type { AdminState, AiProviderConfig, AiTurnPromptPreviewResponse, AiTurnPromptSendResponse, CampaignLocation, CampaignNpc, CampaignQuest, CharacterResourceChange, EmbeddingProviderConfig, PresetTemplateMeta, PresetType, PromptBlock, PromptPreset, PromptPresetPackage, PromptPreviewResponse, RemoteDbRow, RemoteDbSheet, RemoteDbSource, RoomDbSourceBinding, SessionSummary, WorldBookEntry } from '../types';

interface PromptPackageBlockView {
  identifier: string;
  name: string;
  role: string;
  enabled: boolean;
  content: string;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJsonArrayText(value: string): unknown[] {
  try {
    return readJsonArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function renderJsonValue(value: unknown) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

function renderTextValue(value: unknown, emptyText: string) {
  const text = readString(value).trim();
  return text ? <pre>{text}</pre> : <p className="muted">{emptyText}</p>;
}

function renderJsonArraySection(items: unknown[], emptyText: string) {
  return items.length > 0 ? renderJsonValue(items) : <p className="muted">{emptyText}</p>;
}

function aiResultHasInteractionRequests(result: AiTurnPromptSendResponse | null): boolean {
  if (!result || !isJsonRecord(result.raw)) return false;
  return readJsonArray(result.raw.interactionRequests).length > 0;
}

function appliedAiResultMessage(result: AiTurnPromptSendResponse): string {
  return aiResultHasInteractionRequests(result)
    ? '已写入本回合客观剧情、公开剧情和私人剧情；当前回合正在等待目标玩家回应互动请求。'
    : '已写入本回合客观剧情、公开剧情、私人剧情并推进到下一回合。';
}

function actionTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'player_question': return '玩家问题';
    case 'meta_question': return '场外问题';
    case 'observe': return '观察';
    case 'wait': return '等待';
    case 'skip': return '跳过';
    case 'ready': return '准备';
    case 'follow': return '跟随';
    case 'combat_action':
    case 'combat': return '战斗行动';
    case 'exploration': return '探索行动';
    case 'social': return '社交行动';
    case 'ooc': return '场外说明';
    default: return '角色行动';
  }
}

function actionVisibilityLabel(visibility: string | undefined): string {
  switch (visibility) {
    case 'private': return '私人';
    case 'dm_only': return '仅主持人';
    default: return '公开';
  }
}

function actionStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'complete': return '已结算';
    case 'processing': return '处理中';
    default: return '已提交';
  }
}

function promptPackageBlocks(presetPackage: PromptPresetPackage | null): PromptPackageBlockView[] {
  if (!presetPackage || !isJsonRecord(presetPackage.openAiSettings)) return [];
  const prompts: Record<string, unknown>[] = Array.isArray(presetPackage.openAiSettings.prompts)
    ? presetPackage.openAiSettings.prompts.filter(isJsonRecord) as Record<string, unknown>[]
    : [];
  const firstOrder = Array.isArray(presetPackage.openAiSettings.prompt_order)
    ? presetPackage.openAiSettings.prompt_order.filter(isJsonRecord)[0] as Record<string, unknown> | undefined
    : undefined;
  const order = firstOrder ? firstOrder['order'] : undefined;
  const orderItems: Record<string, unknown>[] = Array.isArray(order) ? order.filter(isJsonRecord) as Record<string, unknown>[] : [];
  const enabledByIdentifier = new Map<string, boolean>();
  orderItems.forEach((item) => {
    const identifier = (readString(item.identifier) || readString(item.name)).trim();
    if (identifier) enabledByIdentifier.set(identifier, item.enabled !== false);
  });

  return prompts
    .map((prompt) => {
      const identifier = (readString(prompt.identifier) || readString(prompt.name)).trim();
      return {
        identifier,
        name: (readString(prompt.name) || identifier || '未命名块').trim(),
        role: readString(prompt.role) || 'system',
        enabled: enabledByIdentifier.get(identifier) ?? true,
        content: readString(prompt.content).trim()
      };
    })
    .filter((block) => block.identifier.length > 0 || block.content.length > 0);
}

const runtimePromptSlotIds = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'dialogueExamples',
  'chatHistory',
  'dndTurnState',
  'dndPlayerActions',
  'dndPendingInteractions',
  'dndOutputContract'
]);

function promptPackageBlockContent(block: PromptPackageBlockView): string {
  if (block.content) return block.content;
  if (runtimePromptSlotIds.has(block.identifier)) {
    return '运行时槽位：实际内容由当前房间、剧本卡、世界书、日志或输出契约生成。点击“预览 AI 请求”查看最终内容。';
  }
  return '空内容';
}

interface NarrativeLengthLimits {
  objectiveMax: number;
  publicMax: number;
  privateMax: number;
}

const defaultNarrativeLengthLimits: NarrativeLengthLimits = {
  objectiveMax: 300,
  publicMax: 300,
  privateMax: 150
};

function buildNarrativeLengthRuleContent(limits: NarrativeLengthLimits): string {
  return [
    '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
    `- objectiveLog：最多 ${limits.objectiveMax} 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。`,
    `- publicLog：最多 ${limits.publicMax} 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。`,
    `- privateUpdatesByPlayer：每名玩家最多 ${limits.privateMax} 个中文字符，只写该玩家本人可见的私人信息。`,
    '- ruleResults：每条最多 120 个中文字符。',
    '- interactionRequests：每条 prompt 最多 120 个中文字符。',
    '- suggestedStateChanges.reason：最多 120 个中文字符。',
    '- characterResourceChanges.reason：最多 80 个中文字符。',
    '- diceRequests.reason：最多 80 个中文字符。',
    '信息量少时可以更短，不要为了达到字数而填充内容。'
  ].join('\n');
}

function readNarrativeLengthLimits(preset: PromptPreset | null): NarrativeLengthLimits {
  const block = preset?.blocks.find((item) => item.name === '剧情字数限制');
  const content = block?.content ?? '';
  const objective = content.match(/objectiveLog：(?:最多|建议\s*\d+-)\s*(\d+)/);
  const publicLog = content.match(/publicLog：(?:最多|建议\s*\d+-)\s*(\d+)/);
  const privateLog = content.match(/privateUpdatesByPlayer：(?:每名玩家)?(?:最多|建议\s*\d+-)\s*(\d+)/);
  return {
    objectiveMax: objective ? Number(objective[1]) : defaultNarrativeLengthLimits.objectiveMax,
    publicMax: publicLog ? Number(publicLog[1]) : defaultNarrativeLengthLimits.publicMax,
    privateMax: privateLog ? Number(privateLog[1]) : defaultNarrativeLengthLimits.privateMax
  };
}

function upsertNarrativeLengthBlock(preset: PromptPreset, limits: NarrativeLengthLimits): PromptPreset {
  const content = buildNarrativeLengthRuleContent(limits);
  const blocks = preset.blocks.some((block) => block.name === '剧情字数限制')
    ? preset.blocks.map((block) => block.name === '剧情字数限制' ? { ...block, enabled: true, role: 'system' as const, position: 'final' as const, orderIndex: 850, content } : block)
    : [...preset.blocks, { name: '剧情字数限制', role: 'system' as const, position: 'final' as const, enabled: true, orderIndex: 850, content }];
  return { ...preset, blocks };
}

type AdminTab = 'overview' | 'aiProvider' | 'characterResources' | 'campaignMemory' | 'resources' | 'database' | 'presets' | 'worldBooks';
type AdminLogTab = 'objective' | 'public' | `player:${string}`;

const adminTabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'aiProvider', label: 'AI 接口' },
  { id: 'presets', label: 'Prompt 配置' },
  { id: 'resources', label: '剧本/世界书' },
  { id: 'database', label: '数据库插件' },
  { id: 'campaignMemory', label: '战役记忆' },
  { id: 'characterResources', label: '角色资源' }
];

export function AdminPage({ roomId }: { roomId: string }) {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [activeLogTab, setActiveLogTab] = useState<AdminLogTab>('objective');
  const [state, setState] = useState<AdminState | null>(null);
  const [playerName, setPlayerName] = useState('新英雄');
  const [lastLink, setLastLink] = useState('');
  const [error, setError] = useState('');
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderConfig | null>(null);
  const aiProviderConfigDirtyRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const adminLogScrollRef = useRef<HTMLDivElement | null>(null);
  const [aiProviderMessage, setAiProviderMessage] = useState('');
  const [aiProviderTesting, setAiProviderTesting] = useState(false);
  const [embeddingProviderConfig, setEmbeddingProviderConfig] = useState<EmbeddingProviderConfig | null>(null);
  const [embeddingMessage, setEmbeddingMessage] = useState('');
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreviewResponse | null>(null);
  const [aiTurnPreview, setAiTurnPreview] = useState<AiTurnPromptPreviewResponse | null>(null);
  const [aiTurnPromptDraft, setAiTurnPromptDraft] = useState('');
  const [aiTurnResult, setAiTurnResult] = useState<AiTurnPromptSendResponse | null>(null);
  const [aiTurnBusy, setAiTurnBusy] = useState(false);
  const [aiTurnMessage, setAiTurnMessage] = useState('');
  const [confirmedSuggestedChangeIndexes, setConfirmedSuggestedChangeIndexes] = useState<Set<number>>(new Set());
  const [confirmedResourceChangeIndexes, setConfirmedResourceChangeIndexes] = useState<Set<number>>(new Set());
  const [presetDraft, setPresetDraft] = useState<PromptPreset | null>(null);
  const [expandedPresetBlockKey, setExpandedPresetBlockKey] = useState<string | null>(null);
  const [presetTemplates, setPresetTemplates] = useState<PresetTemplateMeta[]>([]);
  const [activePresetType, setActivePresetType] = useState<PresetType | null>(null);
  const [templateApplying, setTemplateApplying] = useState<PresetType | null>(null);
  const [narrativeLengthDraft, setNarrativeLengthDraft] = useState<NarrativeLengthLimits>(defaultNarrativeLengthLimits);
  const [narrativeLengthMessage, setNarrativeLengthMessage] = useState('');
  const [narrativeLengthSaving, setNarrativeLengthSaving] = useState(false);
  const [resourceChanges, setResourceChanges] = useState<CharacterResourceChange[]>([]);
  const [resourceChangeLoading, setResourceChangeLoading] = useState(false);

  const [worldBookName, setWorldBookName] = useState('凡戴尔补充世界书');
  const [entryDraft, setEntryDraft] = useState<Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>>({
    title: '凡达林新线索',
    keys: ['凡达林', '线索'],
    secondaryKeys: [],
    content: '当玩家围绕凡达林调查新线索时，按当前公开信息、NPC 立场和玩家行动逐步揭示，不提前公开隐藏真相。',
    enabled: true,
    constant: false,
    selective: false,
    priority: 100,
    position: 'after_world'
  });

  // Campaign memory state
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [quests, setQuests] = useState<CampaignQuest[]>([]);
  const [npcs, setNpcs] = useState<CampaignNpc[]>([]);
  const [locations, setLocations] = useState<CampaignLocation[]>([]);
  const [memoryMessage, setMemoryMessage] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [questDraft, setQuestDraft] = useState<{ title: string; status: CampaignQuest['status']; description: string }>({ title: '', status: 'active', description: '' });
  const [npcDraft, setNpcDraft] = useState<{ name: string; role: string; attitude: CampaignNpc['attitude']; notes: string; location: string }>({ name: '', role: '', attitude: 'unknown', notes: '', location: '' });
  const [locationDraft, setLocationDraft] = useState<{ name: string; description: string }>({ name: '', description: '' });

  // DB Management state
  const [dbSources, setDbSources] = useState<RemoteDbSource[]>([]);
  const [dbSheetsBySource, setDbSheetsBySource] = useState<Record<string, RemoteDbSheet[]>>({});
  const [dbRoomBindings, setDbRoomBindings] = useState<RoomDbSourceBinding[]>([]);
  const [dbRoomSheets, setDbRoomSheets] = useState<RemoteDbSheet[]>([]);
  const [dbRowsBySheet, setDbRowsBySheet] = useState<Record<string, RemoteDbRow[]>>({});
  const [dbSelectedSheetId, setDbSelectedSheetId] = useState('');
  const [dbRowKey, setDbRowKey] = useState('');
  const [dbRowJson, setDbRowJson] = useState('{\n  \n}');
  const [dbMessage, setDbMessage] = useState('');
  const [dbLoading, setDbLoading] = useState(false);

  async function refresh() {
    const seq = ++refreshSeqRef.current;
    const startedDirty = aiProviderConfigDirtyRef.current;
    const [nextState, nextAiProviderConfig, nextEmbeddingProviderConfig] = await Promise.all([getAdminState(roomId), getGlobalAiProviderConfig(), getGlobalEmbeddingProviderConfig()]);
    if (seq !== refreshSeqRef.current) return;
    setState(nextState);
    setEmbeddingProviderConfig(nextEmbeddingProviderConfig);
    if (!startedDirty && !aiProviderConfigDirtyRef.current) {
      setAiProviderConfig(nextAiProviderConfig);
    }
  }

  useEffect(() => {
    refreshSeqRef.current += 1;
    aiProviderConfigDirtyRef.current = false;
    setPromptPreview(null);
    setAiTurnPreview(null);
    setAiTurnPromptDraft('');
    setAiTurnResult(null);
    setAiTurnBusy(false);
    setAiTurnMessage('');
    setConfirmedSuggestedChangeIndexes(new Set());
    setConfirmedResourceChangeIndexes(new Set());
    setError('');
    setAiProviderMessage('');
    setAiProviderTesting(false);
    setEmbeddingMessage('');
    setEmbeddingTesting(false);
    setPresetDraft(null);
    setExpandedPresetBlockKey(null);
    setNarrativeLengthDraft(defaultNarrativeLengthLimits);
    setNarrativeLengthMessage('');
    setNarrativeLengthSaving(false);
    setState(null);
    setPresetTemplates([]);
    setActivePresetType(null);
    void refresh();
    const unsubscribe = subscribeRoom(roomId, () => void refresh());
    return () => {
      refreshSeqRef.current += 1;
      unsubscribe();
    };
  }, [roomId]);

  useEffect(() => {
    if (activeTab === 'presets') {
      void loadPresetTemplatesData();
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'database') {
      void loadDbSources();
    }
  }, [activeTab, roomId]);

  useEffect(() => {
    setNarrativeLengthDraft(readNarrativeLengthLimits(activePreset()));
  }, [state?.presets]);

  async function createPlayer() {
    setError('');
    try {
      const player = await addPlayer(roomId, playerName);
      setLastLink(`${window.location.origin}${player.playerUrl}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function advance() {
    setError('');
    setAiTurnBusy(true);
    setAiTurnMessage('正在生成 AI 回合提示词...');
    setAiTurnResult(null);
    setConfirmedSuggestedChangeIndexes(new Set());
    setConfirmedResourceChangeIndexes(new Set());
    try {
      const preview = await createAiTurnPreview(roomId);
      setAiTurnPreview(preview);
      setAiTurnPromptDraft(preview.flatPrompt);
      setAiTurnMessage('提示词已生成，可检查后发送给 AI。');
    } catch (err) {
      setAiTurnMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiTurnBusy(false);
    }
  }

  async function sendCurrentAiTurnPrompt() {
    if (!aiTurnPreview || !aiTurnPromptDraft.trim()) return;
    setError('');
    setAiTurnBusy(true);
    setAiTurnMessage('正在发送给 AI...');
    try {
      const result = await sendAiTurnPreview(roomId, aiTurnPreview.previewId, aiTurnPromptDraft);
      setAiTurnResult(result);
      setConfirmedSuggestedChangeIndexes(new Set());
      setConfirmedResourceChangeIndexes(new Set());
      setAiTurnMessage('AI 已返回，尚未写入系统。请检查下方待确认内容，最终确认后才会应用。');
    } catch (err) {
      setAiTurnMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiTurnBusy(false);
    }
  }

  async function applyCurrentAiTurnResult() {
    if (!aiTurnPreview || aiTurnResult?.applied) return;
    setError('');
    setAiTurnBusy(true);
    setAiTurnMessage('正在应用已确认的 AI 结果...');
    try {
      const result = await applyAiTurnPreview(roomId, aiTurnPreview.previewId, {
        confirmedSuggestedStateChangeIndexes: Array.from(confirmedSuggestedChangeIndexes).sort((a, b) => a - b),
        confirmedCharacterResourceChangeIndexes: Array.from(confirmedResourceChangeIndexes).sort((a, b) => a - b)
      });
      setAiTurnResult(result);
      const appliedMessage = aiResultHasInteractionRequests(result)
        ? '已应用：客观剧情、公开剧情、玩家私人剧情和已确认的可应用状态已写入系统；当前回合正在等待玩家回应互动请求。'
        : '已应用：客观剧情、公开剧情、玩家私人剧情和已确认的可应用状态已写入系统。';
      setAiTurnMessage(result.resourceErrors?.length
        ? `${appliedMessage} 部分玩家状态更新失败，请查看状态更新错误。`
        : appliedMessage);
      await refresh();
    } catch (err) {
      setAiTurnMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiTurnBusy(false);
    }
  }

  function toggleConfirmedSuggestedChange(index: number, checked: boolean) {
    setConfirmedSuggestedChangeIndexes((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function toggleConfirmedResourceChange(index: number, checked: boolean) {
    setConfirmedResourceChangeIndexes((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function updateAiProviderConfig(key: keyof AiProviderConfig, value: string) {
    aiProviderConfigDirtyRef.current = true;
    setAiProviderMessage('');
    setAiProviderConfig((current) => current ? { ...current, [key]: value } : current);
  }

  async function persistAiProviderConfig() {
    if (!aiProviderConfig) return;
    setError('');
    setAiProviderMessage('');
    try {
      const saved = await saveGlobalAiProviderConfig(aiProviderConfig);
      aiProviderConfigDirtyRef.current = false;
      await refresh();
      setAiProviderConfig(saved);
      setAiProviderMessage('AI 接口已保存。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function testAiProvider() {
    if (!aiProviderConfig || aiProviderTesting) return;
    setError('');
    setAiProviderMessage('正在测试连接...');
    setAiProviderTesting(true);
    try {
      await testGlobalAiProviderConfig(aiProviderConfig);
      setAiProviderMessage('连接测试成功。');
    } catch (err) {
      setAiProviderMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiProviderTesting(false);
    }
  }

  function updateEmbeddingProviderConfig(key: keyof EmbeddingProviderConfig, value: string | number) {
    setEmbeddingMessage('');
    setEmbeddingProviderConfig((current) => current ? { ...current, [key]: value } : current);
  }

  async function persistEmbeddingProviderConfig() {
    if (!embeddingProviderConfig) return;
    setError('');
    setEmbeddingMessage('');
    try {
      const saved = await saveGlobalEmbeddingProviderConfig(embeddingProviderConfig);
      await refresh();
      setEmbeddingProviderConfig(saved);
      setEmbeddingMessage('Embedding 接口已保存。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function testEmbeddingProvider() {
    if (!embeddingProviderConfig || embeddingTesting) return;
    setError('');
    setEmbeddingMessage('正在测试 Embedding...');
    setEmbeddingTesting(true);
    try {
      await testGlobalEmbeddingProviderConfig(embeddingProviderConfig);
      setEmbeddingMessage('Embedding 测试成功。');
    } catch (err) {
      setEmbeddingMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEmbeddingTesting(false);
    }
  }

  async function rebuildRuleEmbeddingIndex() {
    setError('');
    setEmbeddingMessage('正在重建规则向量索引...');
    try {
      const result = await reindexRuleEmbeddings();
      setEmbeddingMessage(`规则向量索引已重建：indexed ${result.indexed}，skipped ${result.skipped}。`);
    } catch (err) {
      setEmbeddingMessage('');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function fetchResourceChanges() {
    if (resourceChangeLoading) return;
    setError('');
    setResourceChangeLoading(true);
    try {
      const result = await listCharacterResourceChanges(roomId);
      setResourceChanges(result.changes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResourceChangeLoading(false);
    }
  }

  async function rollbackChange(changeId: string, adminId: string) {
    setError('');
    try {
      const result = await rollbackCharacterResourceChange(roomId, changeId, adminId);
      setResourceChanges((current) => current.map((change) => change.id === changeId ? result.change : change));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadCampaignMemory() {
    setError('');
    setMemoryMessage('加载中...');
    setMemoryLoading(true);
    try {
      const [sRes, qRes, nRes, lRes] = await Promise.all([
        listSessionSummaries(roomId),
        listQuests(roomId),
        listNpcs(roomId),
        listLocations(roomId)
      ]);
      setSummaries(sRes.summaries);
      setQuests(qRes.quests);
      setNpcs(nRes.npcs);
      setLocations(lRes.locations);
      setMemoryMessage('');
    } catch (err) {
      setMemoryMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryLoading(false);
    }
  }

  async function doTriggerSummary() {
    setError('');
    setMemoryMessage('正在生成摘要...');
    setMemoryLoading(true);
    try {
      await triggerSessionSummary(roomId);
      await loadCampaignMemory();
      setMemoryMessage('摘要已生成。');
    } catch (err) {
      setMemoryMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryLoading(false);
    }
  }

  async function doUpdateQuest() {
    if (!questDraft.title.trim()) return;
    setError('');
    setMemoryMessage('');
    try {
      await updateQuest(roomId, questDraft);
      await loadCampaignMemory();
      setQuestDraft({ title: '', status: 'active', description: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doUpdateNpc() {
    if (!npcDraft.name.trim()) return;
    setError('');
    setMemoryMessage('');
    try {
      await updateNpc(roomId, npcDraft);
      await loadCampaignMemory();
      setNpcDraft({ name: '', role: '', attitude: 'unknown', notes: '', location: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doUpdateLocation() {
    if (!locationDraft.name.trim()) return;
    setError('');
    setMemoryMessage('');
    try {
      await updateLocation(roomId, locationDraft);
      await loadCampaignMemory();
      setLocationDraft({ name: '', description: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadPresetTemplatesData() {
    setError('');
    try {
      const [ts, at] = await Promise.all([listPresetTemplates(), getActivePresetType()]);
      setPresetTemplates(ts.templates);
      setActivePresetType(at.presetType);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function applyTemplate(presetType: PresetType) {
    setError('');
    setTemplateApplying(presetType);
    try {
      const result = await applyPresetTemplate(presetType);
      setState((current) => current ? { ...current, presets: result.presets } : current);
      setActivePresetType(presetType);
      // Auto-edit the newly created preset
      setPresetDraft({ ...result.preset, blocks: result.preset.blocks.map((block) => ({ ...block })) });
      setExpandedPresetBlockKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTemplateApplying(null);
    }
  }

  async function loadPromptPreview() {
    setError('');
    try {
      const preview = await previewAiPrompt(roomId);
      setPromptPreview(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function activePreset(): PromptPreset | null {
    return state?.presets.find((preset) => preset.isActive) ?? state?.presets[0] ?? null;
  }

  function presetBlockKey(block: PromptBlock, index: number): string {
    return block.id ?? `new-${index}`;
  }

  function startEditingPreset(preset: PromptPreset) {
    setPresetDraft({ ...preset, blocks: preset.blocks.map((block) => ({ ...block })) });
    setExpandedPresetBlockKey(null);
  }

  function togglePresetBlock(block: PromptBlock, index: number) {
    const key = presetBlockKey(block, index);
    setExpandedPresetBlockKey((current) => current === key ? null : key);
  }

  function updatePresetBlock(index: number, patch: Partial<PromptBlock>) {
    setPresetDraft((current) => current ? {
      ...current,
      blocks: current.blocks.map((block, blockIndex) => blockIndex === index ? { ...block, ...patch } : block)
    } : current);
  }

  function addPresetBlock() {
    setPresetDraft((current) => {
      if (!current) return current;
      const nextIndex = current.blocks.length;
      setExpandedPresetBlockKey(`new-${nextIndex}`);
      return {
        ...current,
        blocks: [...current.blocks, { name: '新增提示词块', role: 'system', position: 'before_actions', enabled: true, orderIndex: 100, content: '新的约束内容。' }]
      };
    });
  }

  async function persistPresetDraft() {
    if (!presetDraft) return;
    setError('');
    try {
      const result = await savePreset(presetDraft);
      setState((current) => current ? { ...current, presets: result.presets } : current);
      setPresetDraft(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function updateNarrativeLengthDraft(key: keyof NarrativeLengthLimits, value: string) {
    setNarrativeLengthMessage('');
    const parsed = Number(value);
    setNarrativeLengthDraft((current) => ({
      ...current,
      [key]: Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
    }));
  }

  async function saveNarrativeLengthLimits() {
    const preset = activePreset();
    if (!preset) {
      setError('当前没有可保存的 Prompt 预设。');
      return;
    }
    const limits = narrativeLengthDraft;
    if (limits.objectiveMax <= 0 || limits.publicMax <= 0 || limits.privateMax <= 0) {
      setNarrativeLengthMessage('');
      setError('剧情长度硬上限必须大于 0。');
      return;
    }
    setError('');
    setNarrativeLengthSaving(true);
    setNarrativeLengthMessage('');
    try {
      const nextPreset = upsertNarrativeLengthBlock(preset, limits);
      const result = await savePreset(nextPreset);
      setState((current) => current ? { ...current, presets: result.presets } : current);
      setPresetDraft((current) => current && current.id === nextPreset.id ? { ...nextPreset, blocks: nextPreset.blocks.map((block) => ({ ...block })) } : current);
      setNarrativeLengthMessage('剧情长度硬上限已保存，并会进入最终 AI prompt。');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNarrativeLengthSaving(false);
    }
  }

  async function usePreset(presetId: string) {
    setError('');
    try {
      const result = await activatePreset(presetId);
      setState((current) => current ? { ...current, presets: result.presets } : current);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addWorldBook() {
    setError('');
    try {
      const result = await createWorldBook({ name: worldBookName, description: '用于按关键词注入世界设定和隐藏知识。', enabled: true });
      setState((current) => current ? { ...current, worldBooks: result.worldBooks } : current);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadDbSources() {
    setError('');
    setDbMessage('加载中...');
    setDbLoading(true);
    try {
      const result = await listDbSources();
      setDbSources(result.sources);
      const tablePluginSources = result.sources.filter((source) => source.sourceType === 'table_plugin');
      const sheetsEntries = await Promise.all(tablePluginSources.map(async (source) => {
        const sheets = await listDbSourceSheets(source.id);
        return [source.id, sheets.sheets] as const;
      }));
      setDbSheetsBySource(Object.fromEntries(sheetsEntries));
      await loadRoomPluginDatabase();
      setDbMessage('');
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDbLoading(false);
    }
  }

  async function loadRoomPluginDatabase() {
    const [bindingsResult, sheetsResult] = await Promise.all([
      listRoomDbSourceBindings(roomId),
      listRoomDbSheets(roomId)
    ]);
    setDbRoomBindings(bindingsResult.bindings);
    setDbRoomSheets(sheetsResult.sheets);
    if (sheetsResult.sheets.length > 0 && !sheetsResult.sheets.some((sheet) => sheet.id === dbSelectedSheetId)) {
      setDbSelectedSheetId(sheetsResult.sheets[0].id);
    }
    const rowEntries = await Promise.all(sheetsResult.sheets.map(async (sheet) => {
      const rows = await listRoomDbRows(roomId, sheet.id);
      return [sheet.id, rows.rows] as const;
    }));
    setDbRowsBySheet(Object.fromEntries(rowEntries));
  }

  async function toggleRoomDbSource(sourceId: string, enabled: boolean) {
    setError('');
    setDbMessage('保存房间数据库绑定...');
    try {
      const existingById = new Map(dbRoomBindings.map((binding) => [binding.sourceId, binding]));
      const nextBindings = dbSources
        .filter((source) => source.sourceType === 'table_plugin')
        .map((source, index) => ({
          sourceId: source.id,
          enabled: source.id === sourceId ? enabled : existingById.get(source.id)?.enabled ?? false,
          orderIndex: existingById.get(source.id)?.orderIndex ?? index
        }))
        .filter((binding) => binding.enabled);
      await putRoomDbSourceBindings(roomId, nextBindings);
      await loadRoomPluginDatabase();
      setDbMessage('房间数据库绑定已保存。');
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveRoomDbRow() {
    if (!dbSelectedSheetId || !dbRowKey.trim()) return;
    setError('');
    setDbMessage('保存数据行...');
    try {
      const data = JSON.parse(dbRowJson) as unknown;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('数据行必须是 JSON 对象。');
      }
      await putRoomDbRow(roomId, dbSelectedSheetId, dbRowKey.trim(), data as Record<string, unknown>);
      await loadRoomPluginDatabase();
      setDbMessage('数据行已保存。');
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doCheckDbUpdates(sourceId: string) {
    setError('');
    setDbMessage('');
    try {
      const result = await checkDbSourceUpdates(sourceId);
      if (result.hasUpdate) {
        setDbMessage(`发现更新！新哈希：${result.newHash?.substring(0, 12)}... 条目数：${result.newEntryCount ?? '?'}`);
      } else {
        setDbMessage('未发现更新。');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doUpdateDbSource(sourceId: string) {
    setError('');
    setDbMessage('更新中...');
    try {
      await updateDbSource(sourceId);
      setDbMessage('已更新。');
      await loadDbSources();
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doDeleteDbSource(sourceId: string) {
    setError('');
    setDbMessage('删除中...');
    try {
      await deleteDbSource(sourceId);
      setDbMessage('已删除。');
      await loadDbSources();
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addWorldEntry() {
    const book = state?.worldBooks[0];
    if (!book) {
      setError('请先创建世界书。');
      return;
    }
    setError('');
    try {
      const result = await createWorldBookEntry(book.id, entryDraft);
      setState((current) => current ? { ...current, worldBookEntries: result.entries } : current);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!state || activeTab !== 'overview') return;
    const node = adminLogScrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [activeTab, activeLogTab, state?.logs.length]);

  useEffect(() => {
    if (!state || activeTab !== 'characterResources') return;
    void fetchResourceChanges();
  }, [activeTab, roomId]);

  if (!state) return <main className="shell"><p>加载中...</p></main>;
  const playerNameById = new Map(state.players.map((player) => [player.id, player.name]));
  const playerUrl = (token: string) => `${window.location.origin}/player/${token}`;
  const readiness = state.turnReadiness;
  const missingActorNames = readiness.missingActorIds.map((id) => playerNameById.get(id) ?? id);
  const readinessLabel = readiness.requiredActorIds.length > 0
    ? `${readiness.completedActorIds.length} / ${readiness.requiredActorIds.length} 已完成`
    : '暂无必需行动者';
  const actorsComplete = readiness.requiredActorIds.length > 0 && readiness.missingActorIds.length === 0;
  const readinessHint = readiness.ready
    ? '提示：所有必需玩家已完成，可以生成 AI 回合提示词。'
    : readiness.roomStatus === 'waiting_for_interaction' || readiness.status === 'waiting_for_interaction'
      ? '提示：本回合正在等待玩家回应互动请求。目标玩家回应后，系统会回到可继续结算状态。'
      : actorsComplete
        ? `提示：玩家行动已完成，但房间/回合状态尚未进入“等待主持人结算”（房间：${roomStatusLabel(readiness.roomStatus ?? state.room.status)}，回合：${roomStatusLabel(readiness.status)}）。请检查状态异常，不要让玩家重复提交行动。`
        : '提示：所有必需玩家提交、跳过或被管理员排除后，才能生成提示词。';
  const actionsByPlayerId = new Map<string, typeof state.actions>();
  for (const action of state.actions) {
    const existing = actionsByPlayerId.get(action.playerId) ?? [];
    actionsByPlayerId.set(action.playerId, [...existing, action]);
  }
  const actionPlayerIds = Array.from(new Set([
    ...state.players.map((player) => player.id),
    ...state.actions.map((action) => action.playerId)
  ]));
  const actionGroups = actionPlayerIds.map((playerId) => ({
    playerId,
    playerName: playerNameById.get(playerId) ?? playerId,
    actions: actionsByPlayerId.get(playerId) ?? []
  }));
  const activeInteractions = state.interactions.filter((interaction) => interaction.status !== 'resolved');
  const privateLogsByPlayer = state.players.map((player) => ({
    player,
    logs: state.logs.filter((log) => log.visibilityScope === 'private' && log.playerId === player.id)
  })).filter((group) => group.logs.length > 0);
  const objectiveLogs = state.logs.filter((log) => log.visibilityScope === 'objective' || log.visibilityScope === 'admin');
  const publicLogs = state.logs.filter((log) => log.visibilityScope === 'public');
  const selectedPrivateLogGroup = activeLogTab.startsWith('player:')
    ? privateLogsByPlayer.find((group) => group.player.id === activeLogTab.slice('player:'.length))
    : undefined;
  const characters = state.characters ?? [];
  const characterByPlayerId = new Map(characters.map((character) => [character.playerId, character]));
  const resourceChangesNewestFirst = [...resourceChanges].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activePresetPackage = state?.presetPackages.find((presetPackage) => presetPackage.id === state.globalPresetPackageId) ?? null;
  const activePresetPackageBlocks = promptPackageBlocks(activePresetPackage);
  const enabledPresetPackageBlocks = activePresetPackageBlocks.filter((block) => block.enabled);
  const disabledPresetPackageBlocks = activePresetPackageBlocks.filter((block) => !block.enabled);
  const selectedDbSheet = dbRoomSheets.find((sheet) => sheet.id === dbSelectedSheetId) ?? dbRoomSheets[0];
  const selectedDbRows = selectedDbSheet ? dbRowsBySheet[selectedDbSheet.id] ?? [] : [];
  const actionSummary = (actions: typeof state.actions): string => {
    if (actions.length === 0) return '未提交';
    const latestAction = actions[actions.length - 1];
    const text = latestAction?.text.trim() ?? '';
    const clipped = text.length > 42 ? `${text.slice(0, 42)}...` : text;
    return `${actions.length} 条行动 · 最新：${clipped || '已提交'}`;
  };
  const interactionStatusText = (status: string): string => {
    switch (status) {
      case 'pending_target': return '等待目标玩家回应';
      case 'ready_for_ai': return '已回应，等待主持人继续结算';
      default: return status;
    }
  };
  const formatChangeValue = (value: unknown): string => {
    if (value === undefined) return '未记录';
    if (value === null) return 'null';
    return typeof value === 'string' ? value : JSON.stringify(value);
  };

  return (
    <main className="shell">
      <div className="page-header">
        <h1>{state.room.name}</h1>
        <p className="muted">主持人控制台 · 第 {state.room.currentTurn} 回合 · {roomStatusLabel(state.room.status)}</p>
      </div>
      <nav className="tabs" aria-label="管理页功能区">
        {adminTabs.map((tab) => (
          <button
            className={`tab-button${activeTab === tab.id ? ' active' : ''}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {error ? <p role="alert">{error}</p> : null}

      <section role="tabpanel" hidden={activeTab !== 'overview'}>
        <div className="grid">
          <aside className="card">
            <h2>玩家</h2>
            {state.players.map((player) => (
              <details className="subcard player-link-row" key={player.id}>
                <summary>
                  <strong>{player.name}</strong>
                  <span className="muted">玩家链接</span>
                </summary>
                <a href={playerUrl(player.token)} target="_blank" rel="noreferrer">{playerUrl(player.token)}</a>
              </details>
            ))}
            <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
            <div className="button-row">
              <button onClick={createPlayer}>创建玩家链接</button>
            </div>
            {lastLink ? <p className="muted">最近创建：<a href={lastLink}>{lastLink}</a></p> : null}
            <h2>行动</h2>
            {actionGroups.length > 0 ? (
              <div className="action-player-list">
                {actionGroups.map((group) => (
                  <details className="subcard action-player-group" key={group.playerId}>
                    <summary>
                      <strong>{group.playerName}</strong>
                      <span className="muted action-summary-text">{actionSummary(group.actions)}</span>
                    </summary>
                    {group.actions.length > 0 ? group.actions.map((action) => (
                      <div className="action-entry" key={action.id}>
                        <p>行动详情：{action.text}</p>
                        <p className="muted">
                      {actionTypeLabel(action.actionType)} · {actionVisibilityLabel(action.visibility)} · {actionStatusLabel(action.status)}
                          {action.isHiddenRoll ? ' · 隐藏骰点' : ''}
                          {action.submittedAt ? ` · 提交时间 ${formatIsoDateTime(action.submittedAt)}` : ''}
                        </p>
                      </div>
                    )) : <p className="muted">暂无行动。</p>}
                  </details>
                ))}
              </div>
            ) : <p className="muted">暂无玩家行动。</p>}
            {activeInteractions.length > 0 ? (
              <>
                <h2>互动回应</h2>
                <div className="action-player-list">
                  {activeInteractions.map((interaction) => {
                    const sourceName = playerNameById.get(interaction.sourcePlayerId) ?? interaction.sourcePlayerId;
                    const targetName = playerNameById.get(interaction.targetPlayerId) ?? interaction.targetPlayerId;
                    return (
                      <div className="subcard action-entry" key={interaction.id}>
                        <p><strong>{interactionStatusText(interaction.status)}</strong></p>
                        <p className="muted">来源：{sourceName} · 目标：{targetName}</p>
                        <p>请求：{interaction.prompt}</p>
                        {interaction.targetResponse ? <p>回应：{interaction.targetResponse}</p> : null}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
            <p className="muted">等待玩家行动：{readinessLabel}</p>
            {missingActorNames.length > 0 ? <p className="muted">未提交：{missingActorNames.join(', ')}</p> : null}
            <div className="button-row">
              <button onClick={advance} disabled={aiTurnBusy || !readiness.ready}>{aiTurnBusy ? '处理中...' : '生成 AI 回合提示词'}</button>
            </div>
            <p className="muted">{readinessHint}</p>
            <div className="subcard">
              <h3>AI 输出长度</h3>
              <p className="muted">
                客观剧情最多 {narrativeLengthDraft.objectiveMax} 字 · 公开剧情最多 {narrativeLengthDraft.publicMax} 字 · 私人剧情每名玩家最多 {narrativeLengthDraft.privateMax} 字
              </p>
              <button type="button" onClick={() => setActiveTab('presets')}>调整 AI 输出长度</button>
            </div>
            {aiTurnMessage ? <p>{aiTurnMessage}</p> : null}
            <h2>AI 错误</h2>
            {state.aiGenerations.filter((gen) => gen.error).map((gen) => <p key={gen.id}>{gen.error}</p>)}
          </aside>
          <section className="card admin-log-panel">
            <div className="inline-tab-row" role="tablist" aria-label="DM 日志类型">
              <button className={activeLogTab === 'objective' ? 'active' : ''} onClick={() => setActiveLogTab('objective')} type="button">客观剧情</button>
              <button className={activeLogTab === 'public' ? 'active' : ''} onClick={() => setActiveLogTab('public')} type="button">公开剧情</button>
              {privateLogsByPlayer.map(({ player }) => (
                <button
                  className={activeLogTab === `player:${player.id}` ? 'active' : ''}
                  key={player.id}
                  onClick={() => setActiveLogTab(`player:${player.id}`)}
                  type="button"
                >
                  {player.name}
                </button>
              ))}
            </div>
            <div className="admin-log-scroll" ref={adminLogScrollRef}>
              {activeLogTab === 'objective' ? (
                <LogList title="客观剧情" logs={objectiveLogs.length > 0 ? objectiveLogs : publicLogs} />
              ) : activeLogTab === 'public' ? (
                <LogList title="公开剧情" logs={publicLogs} />
              ) : selectedPrivateLogGroup ? (
                <LogList title={`${selectedPrivateLogGroup.player.name} 的私人剧情`} logs={selectedPrivateLogGroup.logs} />
              ) : <p className="muted">暂无私人剧情。</p>}
            </div>
          </section>
        </div>
        {aiTurnPreview ? (
          <div className="card ai-turn-debug-panel">
            <h2>AI-DM 回合调试</h2>
            <p className="muted">先检查上下文和提示词，再发送给模型；模型返回后只生成待确认内容，最终确认后才会写入系统并推进回合。</p>
            <div className="context-section-list">
              {aiTurnPreview.contextSections.map((section) => (
                <details key={section.title}>
                  <summary>{section.title}</summary>
                  <pre>{section.content}</pre>
                </details>
              ))}
            </div>
            <label>可编辑提示词
              <textarea
                value={aiTurnPromptDraft}
                onChange={(event) => setAiTurnPromptDraft(event.target.value)}
                rows={16}
              />
            </label>
            <div className="button-row">
              <button onClick={sendCurrentAiTurnPrompt} disabled={aiTurnBusy || !aiTurnPromptDraft.trim()}>
                {aiTurnBusy ? '发送中...' : '发送给 AI'}
              </button>
            </div>
            {aiTurnResult ? (
              <div className="subcard">
                <h3>AI 回复</h3>
                <p>{aiTurnResult.responseText}</p>
                {aiTurnResult.applied ? (
                  <p className="muted">{appliedAiResultMessage(aiTurnResult)}</p>
                ) : (
                  <p className="muted">尚未写入系统。请确认下面列出的客观剧情、公开剧情、私人剧情、骰点请求和状态变更。</p>
                )}
                {aiTurnResult.warnings?.length ? (
                  <>
                    <h3>长度警告</h3>
                    <ul>{aiTurnResult.warnings.map((item) => <li key={item}>{item}</li>)}</ul>
                  </>
                ) : null}
                <h3>待确认内容</h3>
                {(() => {
                  const raw = isJsonRecord(aiTurnResult.raw) ? aiTurnResult.raw : {};
                  const privateUpdates = isJsonRecord(raw.privateUpdatesByPlayer) ? raw.privateUpdatesByPlayer : {};
                  const privateEntries = Object.entries(privateUpdates);
                  const suggestedChanges = readJsonArray(raw.suggestedStateChanges);
                  const resourceChanges = readJsonArray(raw.characterResourceChanges);
                  const diceRequests = readJsonArray(raw.diceRequests);
                  const ruleResults = readJsonArray(raw.ruleResults);
                  const interactionRequests = readJsonArray(raw.interactionRequests);
                  return (
                    <div className="context-section-list">
                      <details open>
                        <summary>客观剧情</summary>
                        {renderTextValue(raw.objectiveLog, '本次没有客观剧情。')}
                      </details>
                      <details open>
                        <summary>公开剧情</summary>
                        {renderTextValue(raw.publicLog, '本次没有公开剧情。')}
                      </details>
                      <details open>
                        <summary>私人剧情</summary>
                        {privateEntries.length > 0 ? (
                          <div className="context-section-list">
                            {privateEntries.map(([playerId, content]) => (
                              <details key={playerId} open>
                                <summary>{playerNameById.get(playerId) ? `${playerNameById.get(playerId)} (${playerId})` : playerId}</summary>
                                {renderTextValue(content, '本玩家没有私人剧情。')}
                              </details>
                            ))}
                          </div>
                        ) : (
                          <p className="muted">本次没有私人剧情。</p>
                        )}
                      </details>
                      <details open>
                        <summary>系统骰点请求</summary>
                        {renderJsonArraySection(diceRequests, '本次没有系统骰点请求。')}
                      </details>
                      <details>
                        <summary>规则结果</summary>
                        {renderJsonArraySection(ruleResults, '本次没有规则结果。')}
                      </details>
                      <details>
                        <summary>互动请求</summary>
                        {renderJsonArraySection(interactionRequests, '本次没有互动请求。')}
                      </details>
                      <details open>
                        <summary>建议状态变更</summary>
                        {suggestedChanges.length > 0 ? (
                          <div className="context-section-list">
                            {suggestedChanges.map((change, index) => (
                              <label key={index}>
                                <input
                                  type="checkbox"
                                  checked={confirmedSuggestedChangeIndexes.has(index)}
                                  disabled={aiTurnResult.applied}
                                  onChange={(event) => toggleConfirmedSuggestedChange(index, event.target.checked)}
                                />
                                确认应用建议状态变更 #{index + 1}
                                {renderJsonValue(change)}
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="muted">本次没有建议状态变更。</p>
                        )}
                      </details>
                      <details open>
                        <summary>角色资源变更</summary>
                        {resourceChanges.length > 0 ? (
                          <div className="context-section-list">
                            {resourceChanges.map((change, index) => (
                              <label key={index}>
                                <input
                                  type="checkbox"
                                  checked={confirmedResourceChangeIndexes.has(index)}
                                  disabled={aiTurnResult.applied}
                                  onChange={(event) => toggleConfirmedResourceChange(index, event.target.checked)}
                                />
                                确认应用角色资源变更 #{index + 1}
                                {renderJsonValue(change)}
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="muted">本次没有角色资源变更。</p>
                        )}
                      </details>
                      <details>
                        <summary>原始 JSON</summary>
                        {renderJsonValue(aiTurnResult.raw)}
                      </details>
                    </div>
                  );
                })()}
                {aiTurnResult.resourceErrors?.length ? (
                  <>
                    <h3>状态更新错误</h3>
                    <ul>{aiTurnResult.resourceErrors.map((item) => <li key={item}>{item}</li>)}</ul>
                  </>
                ) : null}
                {!aiTurnResult.applied ? (
                  <div className="button-row">
                    <button onClick={applyCurrentAiTurnResult} disabled={aiTurnBusy}>
                      {aiTurnBusy ? '应用中...' : '最终确认并应用'}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'aiProvider'}>
        {aiProviderConfig ? (
          <>
            <h2>AI 接口</h2>
            <p className="muted">只配置模型服务连接，不包含 prompt、规则或约束内容。</p>
            <div className="form-grid">
              <label>服务类型
                <select value={aiProviderConfig.provider} onChange={(event) => updateAiProviderConfig('provider', event.target.value)}>
                  <option value="mock">本地模拟</option>
                  <option value="openai-compatible">OpenAI 兼容接口</option>
                </select>
              </label>
              <label>API 地址<input value={aiProviderConfig.baseUrl} onChange={(event) => updateAiProviderConfig('baseUrl', event.target.value)} /></label>
              <label>API 密钥<input type="password" value={aiProviderConfig.apiKey} onChange={(event) => updateAiProviderConfig('apiKey', event.target.value)} /></label>
              <label>模型<input value={aiProviderConfig.model} onChange={(event) => updateAiProviderConfig('model', event.target.value)} /></label>
            </div>
            <div className="button-row">
              <button onClick={persistAiProviderConfig}>保存 AI 接口</button>
              <button onClick={testAiProvider} disabled={aiProviderTesting}>{aiProviderTesting ? '测试中...' : '测试连接'}</button>
            </div>
            {aiProviderMessage ? <p>{aiProviderMessage}</p> : null}
            {embeddingProviderConfig ? (
              <div className="subcard">
                <h3>Embedding 接口</h3>
                <p className="muted">用于 5e 规则检索与规则向量索引。</p>
                <div className="form-grid">
                  <label>服务类型
                    <select value={embeddingProviderConfig.provider} onChange={(event) => updateEmbeddingProviderConfig('provider', event.target.value)}>
                      <option value="mock">本地模拟</option>
                      <option value="openai-compatible">OpenAI 兼容接口</option>
                    </select>
                  </label>
                  <label>API 地址<input value={embeddingProviderConfig.baseUrl} onChange={(event) => updateEmbeddingProviderConfig('baseUrl', event.target.value)} /></label>
                  <label>API 密钥<input type="password" value={embeddingProviderConfig.apiKey} onChange={(event) => updateEmbeddingProviderConfig('apiKey', event.target.value)} /></label>
                  <label>模型<input value={embeddingProviderConfig.model} onChange={(event) => updateEmbeddingProviderConfig('model', event.target.value)} /></label>
                  <label>向量维度<input type="number" value={embeddingProviderConfig.dimensions} onChange={(event) => updateEmbeddingProviderConfig('dimensions', Number(event.target.value))} /></label>
                </div>
                <div className="button-row">
                  <button onClick={persistEmbeddingProviderConfig}>保存 Embedding 接口</button>
                  <button onClick={testEmbeddingProvider} disabled={embeddingTesting}>{embeddingTesting ? '测试中...' : '测试 Embedding'}</button>
                  <button onClick={rebuildRuleEmbeddingIndex}>重建规则向量索引</button>
                </div>
                {embeddingMessage ? <p>{embeddingMessage}</p> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section role="tabpanel" hidden={activeTab !== 'characterResources'}>
        <div className="admin-character-resource-layout">
          <section className="card">
            <h2>玩家角色与当前状态</h2>
            <p className="muted">展示所有玩家的角色卡、HP、法术位、货币和状态。</p>
            <div className="admin-character-list">
              {state.players.map((player) => {
                const character = characterByPlayerId.get(player.id) ?? null;
                const resources = character?.resources;
                return (
                  <div className="subcard admin-character-resource-card" key={player.id}>
                    <h3>{player.name}</h3>
                    <CharacterCard character={character} />
                    {resources ? (
                      <div className="current-resource-grid">
                        <div>
                          <strong>HP</strong>
                          <p>{resources.hitPoints.current} / {resources.hitPoints.max}{resources.hitPoints.temp > 0 ? `（临时 ${resources.hitPoints.temp}）` : ''}</p>
                        </div>
                        <div>
                          <strong>生命骰</strong>
                          <p>{resources.hitDice.remaining} / {resources.hitDice.total} {resources.hitDice.die}</p>
                        </div>
                        <div>
                          <strong>法术位</strong>
                          {Object.keys(resources.spellSlots).length > 0
                            ? Object.entries(resources.spellSlots).map(([level, slots]) => <p key={level}>{level}: {slots.total - slots.used} / {slots.total}</p>)
                            : <p>无</p>}
                        </div>
                        <div>
                          <strong>货币</strong>
                          <p>{resources.currency.gp} gp · {resources.currency.sp} sp · {resources.currency.cp} cp</p>
                        </div>
                        <div>
                          <strong>状态</strong>
                          <p>{resources.conditions.length ? resources.conditions.join('、') : '无'}</p>
                        </div>
                      </div>
                    ) : <p className="muted">暂无资源状态。</p>}
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card">
            {resourceChangesNewestFirst.length > 0 ? (
              <div className="changes-list">
                {resourceChangesNewestFirst.map((change) => (
                  <div className="subcard" key={change.id}>
                    <strong>{change.path}</strong>
                    <p>{formatChangeValue(change.before)} → {formatChangeValue(change.after)}</p>
                    <p className="muted">{change.characterId} · {change.reason} · {actorTypeLabel(change.actorType)} · {formatIsoDateTime(change.createdAt)}</p>
                    {!change.revertedAt ? (
                      <button onClick={() => rollbackChange(change.id, 'admin-1')}>回滚</button>
                    ) : (
                      <p className="muted">已于 {formatIsoDateTime(change.revertedAt)} 回滚</p>
                    )}
                  </div>
                ))}
              </div>
            ) : <p className="muted">暂无状态变更记录。</p>}
          </section>
        </div>
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'campaignMemory'}>
        <h2>战役记忆</h2>
        <p className="muted">管理摘要、任务、NPC 与探索地点的战局记忆。</p>
            <div className="subcard">
              <h3>摘要与档案</h3>
              <div className="button-row">
                <button onClick={loadCampaignMemory} disabled={memoryLoading}>{memoryLoading ? '加载中...' : '加载记忆'}</button>
                <button onClick={doTriggerSummary} disabled={memoryLoading}>生成摘要</button>
              </div>
              {memoryMessage ? <p>{memoryMessage}</p> : null}

              {summaries.length > 0 ? (
                <div style={{ marginTop: '12px' }}>
                  <strong>最近摘要</strong>
                  {summaries.map((s) => (
                    <div className="subcard" key={s.id}>
                      <p className="muted">回合 {s.turnStart}-{s.turnEnd} · {formatIsoDateTime(s.createdAt)}</p>
                      <p>{s.summary}</p>
                      {(() => {
                        const suggestedQuests = parseJsonArrayText(s.questUpdatesJson);
                        const suggestedNpcs = parseJsonArrayText(s.npcUpdatesJson);
                        const suggestedLocations = parseJsonArrayText(s.locationUpdatesJson);
                        const suggestedCharacters = parseJsonArrayText(s.characterUpdatesJson);
                        const hasSuggestions = suggestedQuests.length > 0 || suggestedNpcs.length > 0 || suggestedLocations.length > 0 || suggestedCharacters.length > 0;
                        return hasSuggestions ? (
                          <details>
                            <summary>摘要建议（不会自动写入长期记忆）</summary>
                            {suggestedQuests.length > 0 ? (
                              <>
                                <strong>任务建议</strong>
                                {renderJsonValue(suggestedQuests)}
                              </>
                            ) : null}
                            {suggestedNpcs.length > 0 ? (
                              <>
                                <strong>NPC 建议</strong>
                                {renderJsonValue(suggestedNpcs)}
                              </>
                            ) : null}
                            {suggestedLocations.length > 0 ? (
                              <>
                                <strong>地点建议</strong>
                                {renderJsonValue(suggestedLocations)}
                              </>
                            ) : null}
                            {suggestedCharacters.length > 0 ? (
                              <>
                                <strong>角色建议</strong>
                                {renderJsonValue(suggestedCharacters)}
                              </>
                            ) : null}
                          </details>
                        ) : null;
                      })()}
                    </div>
                  ))}
                </div>
              ) : null}

              <div style={{ marginTop: '12px' }}>
                <strong>任务</strong>
                {quests.map((q) => (
                  <div className="subcard" key={q.id}>
                    <strong>{q.title}</strong> <span className="muted">[{questStatusLabel(q.status)}]</span>
                    <p>{q.description}</p>
                  </div>
                ))}
                <label>标题<input value={questDraft.title} onChange={(e) => setQuestDraft({ ...questDraft, title: e.target.value })} placeholder="新任务" /></label>
                <label>状态
                  <select value={questDraft.status} onChange={(e) => setQuestDraft({ ...questDraft, status: e.target.value as CampaignQuest['status'] })}>
                    <option value="active">待推进</option>
                    <option value="in_progress">进行中</option>
                    <option value="completed">已完成</option>
                    <option value="failed">失败</option>
                  </select>
                </label>
                <label>描述<input value={questDraft.description} onChange={(e) => setQuestDraft({ ...questDraft, description: e.target.value })} /></label>
                <button onClick={doUpdateQuest}>保存任务</button>
              </div>

              <div style={{ marginTop: '12px' }}>
                <strong>NPC</strong>
                {npcs.map((n) => (
                  <div className="subcard" key={n.id}>
                    <strong>{n.name}</strong> <span className="muted">({n.role}，{npcAttitudeLabel(n.attitude)})</span>
                    <p>{n.notes} [{n.location}]</p>
                  </div>
                ))}
                <label>名称<input value={npcDraft.name} onChange={(e) => setNpcDraft({ ...npcDraft, name: e.target.value })} placeholder="NPC 名称" /></label>
                <label>角色<input value={npcDraft.role} onChange={(e) => setNpcDraft({ ...npcDraft, role: e.target.value })} placeholder="商人/守卫/盗贼" /></label>
                <label>态度
                  <select value={npcDraft.attitude} onChange={(e) => setNpcDraft({ ...npcDraft, attitude: e.target.value as CampaignNpc['attitude'] })}>
                    <option value="friendly">友好</option>
                    <option value="neutral">中立</option>
                    <option value="hostile">敌对</option>
                    <option value="unknown">未知</option>
                  </select>
                </label>
                <label>备注<input value={npcDraft.notes} onChange={(e) => setNpcDraft({ ...npcDraft, notes: e.target.value })} /></label>
                <label>位置<input value={npcDraft.location} onChange={(e) => setNpcDraft({ ...npcDraft, location: e.target.value })} /></label>
                <button onClick={doUpdateNpc}>保存 NPC</button>
              </div>

              <div style={{ marginTop: '12px' }}>
                <strong>探索地点</strong>
                {locations.map((l) => (
                  <div className="subcard" key={l.id}>
                    <strong>{l.name}</strong>
                    <p>{l.description}</p>
                  </div>
                ))}
                <label>名称<input value={locationDraft.name} onChange={(e) => setLocationDraft({ ...locationDraft, name: e.target.value })} placeholder="地点名称" /></label>
                <label>描述<input value={locationDraft.description} onChange={(e) => setLocationDraft({ ...locationDraft, description: e.target.value })} /></label>
                <button onClick={doUpdateLocation}>保存地点</button>
              </div>
            </div>
      </section>

      <section role="tabpanel" hidden={activeTab !== 'resources'}>
        <div className="card">
          <h2>剧本 / 世界书</h2>
          <p className="muted">这里管理实际进入 AI 上下文的剧本卡和资源世界书。旧“世界书”页已隐藏，避免和当前生效链路混用。</p>
        </div>
        <ResourceImportPanel
          scriptCards={state.scriptCards}
          resourceWorldBooks={state.resourceWorldBooks}
          presetPackages={state.presetPackages}
          onImported={refresh}
          setError={setError}
        />
        <GlobalResourceConfigPanel
          scriptCards={state.scriptCards}
          resourceWorldBooks={state.resourceWorldBooks}
          presetPackages={state.presetPackages}
          globalScriptCardId={state.globalScriptCardId}
          globalWorldBookBindings={state.globalWorldBookBindings}
          globalPresetPackageId={state.globalPresetPackageId}
          onChanged={refresh}
          setError={setError}
        />
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'database'}>
          <h2>数据库插件</h2>
          <p className="muted">数据库插件只提供结构化表数据，不会作为世界书或 prompt 预设导入。停用只影响当前房间；永久删除会移除整个数据源。</p>

          <div className="subcard">
            <h4>已接入数据源</h4>
            <div className="button-row">
              <button onClick={loadDbSources} disabled={dbLoading}>{dbLoading ? '加载中...' : '刷新列表'}</button>
            </div>
            {dbMessage ? <p>{dbMessage}</p> : null}
            {dbSources.length === 0 ? (
              <p className="muted">暂无已接入的数据源。</p>
            ) : (
              dbSources.map((source) => (
                <div className="subcard" key={source.id}>
                  <strong>{source.name}</strong>
                  <p className="muted">
                    类型：{dbSourceTypeLabel(source.sourceType)} · 版本：{source.version || '--'} · 哈希：{source.fileHash.substring(0, 12)}... · {source.sourceType === 'table_plugin' ? '表数量' : '条目数'}：{source.entryCount} · 大小：{formatFileSize(source.fileSize)}
                    {source.lastCheckedAt ? ` · 上次检查：${formatIsoDateTime(source.lastCheckedAt)}` : ''}
                  </p>
                  {source.sourceType === 'table_plugin' ? (
                    <div className="button-row">
                      <button
                        onClick={() => toggleRoomDbSource(source.id, !dbRoomBindings.some((binding) => binding.sourceId === source.id && binding.enabled))}
                      >
                        {dbRoomBindings.some((binding) => binding.sourceId === source.id && binding.enabled) ? '仅停用当前房间' : '启用到当前房间'}
                      </button>
                    </div>
                  ) : null}
                  {source.sourceType === 'table_plugin' ? (
                    <div className="resource-grid">
                      {(dbSheetsBySource[source.id] ?? []).map((sheet) => (
                        <div className="subcard" key={sheet.id}>
                          <strong>{sheet.name}</strong>
                          <p className="muted">{sheet.tableName || sheet.uid} · {sheet.exportEnabled ? '默认注入' : '不默认注入'}</p>
                          {sheet.note ? <p>{sheet.note}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="button-row">
                    <button onClick={() => doCheckDbUpdates(source.id)}>检查更新</button>
                    <button onClick={() => doUpdateDbSource(source.id)}>更新源文件</button>
                    <button onClick={() => {
                      if (window.confirm(`永久删除数据源“${source.name}”？这不是停用当前房间。`)) void doDeleteDbSource(source.id);
                    }}>永久删除数据源</button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="subcard">
            <h4>当前房间插件数据库</h4>
            {dbRoomSheets.length === 0 ? (
              <p className="muted">尚未为此房间启用数据库插件。</p>
            ) : (
              <>
                <label>数据表
                  <select value={selectedDbSheet?.id ?? ''} onChange={(event) => setDbSelectedSheetId(event.target.value)}>
                    {dbRoomSheets.map((sheet) => (
                      <option key={sheet.id} value={sheet.id}>{sheet.name} / {sheet.tableName || sheet.uid}</option>
                    ))}
                  </select>
                </label>
                {selectedDbSheet ? (
                  <div className="subcard">
                    <strong>{selectedDbSheet.name}</strong>
                    <p className="muted">{selectedDbSheet.tableName || selectedDbSheet.uid}</p>
                    {selectedDbSheet.note ? <p>{selectedDbSheet.note}</p> : null}
                    <div className="form-grid">
                      <label>行 Key<input value={dbRowKey} onChange={(event) => setDbRowKey(event.target.value)} placeholder="row_id 或唯一键" /></label>
                      <label>行数据 JSON<textarea value={dbRowJson} onChange={(event) => setDbRowJson(event.target.value)} rows={5} /></label>
                    </div>
                    <div className="button-row">
                      <button onClick={saveRoomDbRow}>保存数据行</button>
                    </div>
                    {selectedDbRows.length === 0 ? (
                      <p className="muted">此表暂无数据行。</p>
                    ) : (
                      <div className="resource-grid">
                        {selectedDbRows.map((row) => (
                          <div className="subcard" key={row.id}>
                            <strong>{row.rowKey}</strong>
                            <pre>{JSON.stringify(row.data, null, 2)}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'presets'}>
        <h2>Prompt 配置</h2>
        <p className="muted">最终请求优先使用“资源配置”中绑定的预设包。下面先展示当前真正生效的预设包；旧原生预设仅作为高级配置保留。</p>
        <div className="button-row">
          <button onClick={loadPromptPreview}>预览 AI 请求</button>
        </div>
        <PromptPreviewPanel preview={promptPreview} />

        <div className="subcard" style={{ marginTop: '16px' }}>
          <h3>AI 输出剧情长度</h3>
          <p className="muted">这里控制 AI 返回的客观剧情、公开剧情、私人剧情硬上限。保存后会写入当前启用预设，并注入最终 AI prompt。</p>
          <div className="form-grid">
            <label>客观剧情最多字数
              <input type="number" min={0} value={narrativeLengthDraft.objectiveMax} onChange={(event) => updateNarrativeLengthDraft('objectiveMax', event.target.value)} />
            </label>
            <label>公开剧情最多字数
              <input type="number" min={0} value={narrativeLengthDraft.publicMax} onChange={(event) => updateNarrativeLengthDraft('publicMax', event.target.value)} />
            </label>
            <label>私人剧情最多字数/玩家
              <input type="number" min={0} value={narrativeLengthDraft.privateMax} onChange={(event) => updateNarrativeLengthDraft('privateMax', event.target.value)} />
            </label>
          </div>
          <div className="button-row">
            <button onClick={saveNarrativeLengthLimits} disabled={narrativeLengthSaving}>
              {narrativeLengthSaving ? '保存中...' : '保存剧情长度硬上限'}
            </button>
          </div>
          {narrativeLengthMessage ? <p className="form-success">{narrativeLengthMessage}</p> : null}
        </div>

        <div className="subcard" style={{ marginTop: '16px' }}>
          <h3>当前生效预设包</h3>
          {activePresetPackage ? (
            <>
              <p><strong>{activePresetPackage.name}</strong></p>
              <p className="muted">启用块：{enabledPresetPackageBlocks.length} · 禁用块：{disabledPresetPackageBlocks.length}</p>
              <details open>
                <summary>启用并进入最终 prompt 的块</summary>
                {enabledPresetPackageBlocks.length ? enabledPresetPackageBlocks.map((block, index) => (
                  <div className="subcard" key={`${block.identifier}-enabled-${index}`}>
                    <strong>{block.name}</strong>
                    <p className="muted">{promptRoleLabel(block.role)} · ID: {block.identifier}</p>
                    <pre>{promptPackageBlockContent(block)}</pre>
                  </div>
                )) : <p className="muted">没有启用块。</p>}
              </details>
              <details>
                <summary>已导入但禁用的原始块</summary>
                {disabledPresetPackageBlocks.length ? disabledPresetPackageBlocks.map((block, index) => (
                  <div className="subcard" key={`${block.identifier}-disabled-${index}`}>
                    <strong>{block.name}</strong>
                    <p className="muted">{promptRoleLabel(block.role)} · ID: {block.identifier}</p>
                    <pre>{promptPackageBlockContent(block)}</pre>
                  </div>
                )) : <p className="muted">没有禁用块。</p>}
              </details>
            </>
          ) : (
            <p className="muted">当前没有绑定资源预设包，最终请求会回退到旧原生预设。</p>
          )}
        </div>

        <div className="subcard" style={{ marginTop: '16px' }}>
          <h3>高级：旧原生预设模板</h3>
          <p className="muted">这部分是旧 prompt 系统。存在资源预设包时，它不是最终 prompt 的主要来源。</p>
          {activePresetType ? (
            <p>当前激活模板类型：<strong>{presetTypeLabel(activePresetType)}</strong></p>
          ) : (
            <p className="muted">未使用预设模板（使用默认预设）。</p>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', marginTop: '12px' }}>
            {presetTemplates.length === 0 ? (
              <p className="muted">点击"加载模板"按钮查看可用预设模板。</p>
            ) : (
              presetTemplates.map((template) => (
                <div
                  className={`subcard${activePresetType === template.type ? '' : ''}`}
                  key={template.type}
                  style={activePresetType === template.type ? { border: '2px solid #ffd700' } : undefined}
                >
                  <h4>{template.name}{activePresetType === template.type ? ' (当前激活)' : ''}</h4>
                  <p className="muted">{template.description}</p>
                  <p>模块数量：{template.blockCount}</p>
                  <div className="button-row">
                    <button
                      onClick={() => applyTemplate(template.type)}
                      disabled={templateApplying === template.type}
                    >
                      {templateApplying === template.type ? '应用中...' : '应用此模板'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          {presetTemplates.length === 0 ? (
            <div className="button-row" style={{ marginTop: '8px' }}>
              <button onClick={loadPresetTemplatesData}>加载模板</button>
            </div>
          ) : null}
        </div>

        {state.presets.map((preset) => (
          <div className="subcard" key={preset.id}>
            <h3>{preset.name}{preset.isActive ? '（当前启用）' : ''}</h3>
            <p className="muted">{preset.description || '暂无描述。'}</p>
            <p>提示词块：{preset.blocks.length}{preset.presetType ? ` · 类型：${presetTypeLabel(preset.presetType)}` : ''}{preset.isTemplate ? '（模板）' : ''}</p>
            <div className="button-row">
              <button onClick={() => startEditingPreset(preset)}>编辑预设</button>
              {!preset.isActive ? <button onClick={() => usePreset(preset.id)}>启用预设</button> : null}
            </div>
          </div>
        ))}
        {!presetDraft && activePreset() ? (
          <div className="button-row">
            <button onClick={() => startEditingPreset(activePreset()!)}>编辑当前预设</button>
          </div>
        ) : null}
        {presetDraft ? (
          <div className="preset-editor">
            <label>预设名称<input value={presetDraft.name} onChange={(event) => setPresetDraft({ ...presetDraft, name: event.target.value })} /></label>
            <label>预设描述<textarea value={presetDraft.description} onChange={(event) => setPresetDraft({ ...presetDraft, description: event.target.value })} /></label>
            <label className="check-row"><input type="checkbox" checked={presetDraft.isActive} onChange={(event) => setPresetDraft({ ...presetDraft, isActive: event.target.checked })} /> 设为启用预设</label>
            {presetDraft.blocks.map((block, index) => {
              const blockKey = presetBlockKey(block, index);
              const expanded = expandedPresetBlockKey === blockKey;
              return (
                <div className="subcard collapsible-card" key={blockKey}>
                  <button className="collapsible-header" type="button" onClick={() => togglePresetBlock(block, index)}>
                    <span>{expanded ? '收起' : '展开'} · {block.name || '未命名提示词块'}</span>
                    <span className="meta-row">
                      {promptBlockPositionLabel(block.position)} · {promptRoleLabel(block.role)} · {block.enabled ? '启用' : '停用'} · 排序 {block.orderIndex}
                      {block.category ? ` · ${moduleCategoryLabel(block.category)}` : ''}
                      {block.sceneType ? ` · 场景：${sceneTypeLabel(block.sceneType)}` : ''}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="collapsible-body">
                      <label>块名称<input value={block.name} onChange={(event) => updatePresetBlock(index, { name: event.target.value })} /></label>
                      <label>注入位置
                        <select value={block.position} onChange={(event) => updatePresetBlock(index, { position: event.target.value as PromptBlock['position'] })}>
                          <option value="before_world">世界信息前</option>
                          <option value="after_world">世界信息后</option>
                          <option value="before_actions">行动前</option>
                          <option value="after_actions">行动后</option>
                          <option value="final">最终输出前</option>
                        </select>
                      </label>
                      <label>排序<input type="number" value={block.orderIndex} onChange={(event) => updatePresetBlock(index, { orderIndex: Number(event.target.value) })} /></label>
                      <label className="check-row"><input type="checkbox" checked={block.enabled} onChange={(event) => updatePresetBlock(index, { enabled: event.target.checked })} /> 启用此块</label>
                      <textarea value={block.content} onChange={(event) => updatePresetBlock(index, { content: event.target.value })} />
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div className="button-row">
              <button onClick={addPresetBlock}>新增提示词块</button>
              <button onClick={persistPresetDraft}>保存预设</button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'worldBooks'}>
        <h2>世界书</h2>
        <p className="muted">全局原生世界书会实时参与所有房间的 AI 上下文构建。</p>
        <label>世界书名称<input value={worldBookName} onChange={(event) => setWorldBookName(event.target.value)} /></label>
        <div className="button-row">
          <button onClick={addWorldBook}>创建世界书</button>
        </div>
        {state.worldBooks.map((book) => <p key={book.id}>{book.name} · {book.enabled ? '启用' : '停用'}</p>)}
        <h3>世界书条目</h3>
        <label>条目标题<input value={entryDraft.title} onChange={(event) => setEntryDraft({ ...entryDraft, title: event.target.value })} /></label>
        <label>关键词（用逗号分隔）<input value={entryDraft.keys.join(', ')} onChange={(event) => setEntryDraft({ ...entryDraft, keys: event.target.value.split(',').map((key) => key.trim()).filter(Boolean) })} /></label>
        <label>优先级<input type="number" value={entryDraft.priority} onChange={(event) => setEntryDraft({ ...entryDraft, priority: Number(event.target.value) })} /></label>
        <label className="check-row"><input type="checkbox" checked={entryDraft.constant} onChange={(event) => setEntryDraft({ ...entryDraft, constant: event.target.checked })} /> 常驻条目</label>
        <label>条目内容<textarea value={entryDraft.content} onChange={(event) => setEntryDraft({ ...entryDraft, content: event.target.value })} /></label>
        <div className="button-row">
          <button onClick={addWorldEntry}>添加世界书条目</button>
        </div>
        {state.worldBookEntries.map((entry) => (
          <div className="log-entry" key={entry.id}>
            <strong>{entry.title}</strong>
            <p className="muted">关键词：{entry.keys.join(', ') || '常驻'} · 优先级：{entry.priority}</p>
            <p>{entry.content}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
