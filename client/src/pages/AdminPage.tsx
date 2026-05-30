import { useEffect, useRef, useState } from 'react';
import { activatePreset, addPlayer, adminDiceRoll, applyPresetTemplate, checkDbSourceUpdates, combatAttack, combatNextTurn, createWorldBook, createWorldBookEntry, deleteDbSource, getActivePresetType, getAdminState, getCombatState, getDiceLogs, getGlobalAiProviderConfig, getGlobalEmbeddingProviderConfig, importFromUrl, importJsDatabase, listCharacterResourceChanges, listDbSources, listLocations, listNpcs, listPresetTemplates, listQuests, listSessionSummaries, previewAiPrompt, processTurn, reindexRuleEmbeddings, rollbackCharacterResourceChange, rollCombatInitiative, saveGlobalAiProviderConfig, saveGlobalEmbeddingProviderConfig, savePreset, startCombat, subscribeRoom, testGlobalAiProviderConfig, testGlobalEmbeddingProviderConfig, triggerSessionSummary, updateDbSource, updateLocation, updateNpc, updateQuest } from '../api';
import { LogList } from '../components/LogList';
import { PromptPreviewPanel } from '../components/PromptPreviewPanel';
import { ResourceImportPanel } from '../components/ResourceImportPanel';
import { GlobalResourceConfigPanel } from '../components/RoomResourceBindingsPanel';
import type { AdminState, AiProviderConfig, CampaignLocation, CampaignNpc, CampaignQuest, CharacterResourceChange, CombatState, DieType, DiceRollResult, EmbeddingProviderConfig, PresetTemplateMeta, PresetType, PromptBlock, PromptPreset, PromptPreviewResponse, RemoteDbSource, SessionSummary, WorldBookEntry } from '../types';

type AdminTab = 'overview' | 'aiProvider' | 'diceCombat' | 'characterResources' | 'campaignMemory' | 'resources' | 'database' | 'presets' | 'worldBooks';

const adminTabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'aiProvider', label: 'AI 接口' },
  { id: 'diceCombat', label: '检定战斗' },
  { id: 'characterResources', label: '角色资源' },
  { id: 'campaignMemory', label: '战役记忆' },
  { id: 'resources', label: '资源配置' },
  { id: 'database', label: '数据库' },
  { id: 'presets', label: '预设' },
  { id: 'worldBooks', label: '世界书' }
];

export function AdminPage({ roomId }: { roomId: string }) {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [state, setState] = useState<AdminState | null>(null);
  const [playerName, setPlayerName] = useState('新英雄');
  const [lastLink, setLastLink] = useState('');
  const [error, setError] = useState('');
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderConfig | null>(null);
  const aiProviderConfigDirtyRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const [aiProviderMessage, setAiProviderMessage] = useState('');
  const [aiProviderTesting, setAiProviderTesting] = useState(false);
  const [embeddingProviderConfig, setEmbeddingProviderConfig] = useState<EmbeddingProviderConfig | null>(null);
  const [embeddingMessage, setEmbeddingMessage] = useState('');
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreviewResponse | null>(null);
  const [presetDraft, setPresetDraft] = useState<PromptPreset | null>(null);
  const [expandedPresetBlockKey, setExpandedPresetBlockKey] = useState<string | null>(null);
  const [presetTemplates, setPresetTemplates] = useState<PresetTemplateMeta[]>([]);
  const [activePresetType, setActivePresetType] = useState<PresetType | null>(null);
  const [templateApplying, setTemplateApplying] = useState<PresetType | null>(null);
  const [resourceChanges, setResourceChanges] = useState<CharacterResourceChange[]>([]);
  const [resourceChangeCharId, setResourceChangeCharId] = useState('');
  const [resourceChangeLoading, setResourceChangeLoading] = useState(false);
  const [resourceChangeMessage, setResourceChangeMessage] = useState('');

  // Dice state
  const [diceDie, setDiceDie] = useState<DieType>('d20');
  const [diceModifier, setDiceModifier] = useState(0);
  const [diceDc, setDiceDc] = useState<number | undefined>(undefined);
  const [diceReason, setDiceReason] = useState('');
  const [diceResult, setDiceResult] = useState<DiceRollResult | null>(null);
  const [diceRolling, setDiceRolling] = useState(false);

  // Combat state
  const [combatState, setCombatState] = useState<CombatState | null>(null);
  const [combatParticipants, setCombatParticipants] = useState('哥布林 7 15 2');
  const [combatAttackerId, setCombatAttackerId] = useState('');
  const [combatTargetId, setCombatTargetId] = useState('');
  const [combatAttackBonus, setCombatAttackBonus] = useState(5);
  const [combatDamageDice, setCombatDamageDice] = useState('1d8');
  const [combatDamageBonus, setCombatDamageBonus] = useState(3);
  const [combatBusy, setCombatBusy] = useState(false);

  const [worldBookName, setWorldBookName] = useState('主世界书');
  const [entryDraft, setEntryDraft] = useState<Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>>({
    title: '烛堡密门',
    keys: ['烛堡', '密门'],
    secondaryKeys: [],
    content: '当玩家提到烛堡或密门时，提醒 AI-DM：密门只会对持有银钥匙的人显现。',
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
  const [dbUrl, setDbUrl] = useState('');
  const [dbImportName, setDbImportName] = useState('');
  const [dbJsCode, setDbJsCode] = useState('');
  const [dbJsName, setDbJsName] = useState('');
  const [dbMessage, setDbMessage] = useState('');
  const [dbLoading, setDbLoading] = useState(false);
  const [dbPreview, setDbPreview] = useState<{ entryTypes: Array<{ type: string; count: number }> } | null>(null);

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
    setError('');
    setAiProviderMessage('');
    setAiProviderTesting(false);
    setEmbeddingMessage('');
    setEmbeddingTesting(false);
    setPresetDraft(null);
    setExpandedPresetBlockKey(null);
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
    try {
      await processTurn(roomId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
    if (!resourceChangeCharId.trim()) {
      setResourceChangeMessage('请先输入角色 ID。');
      return;
    }
    setError('');
    setResourceChangeLoading(true);
    setResourceChangeMessage('');
    try {
      const result = await listCharacterResourceChanges(roomId, { characterId: resourceChangeCharId.trim() });
      setResourceChanges(result.changes);
      setResourceChangeMessage(`查询到 ${result.changes.length} 条变更记录。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResourceChangeLoading(false);
    }
  }

  async function rollbackChange(changeId: string, adminId: string) {
    setError('');
    setResourceChangeMessage('');
    try {
      const result = await rollbackCharacterResourceChange(roomId, changeId, adminId);
      setResourceChanges((current) => current.map((change) => change.id === changeId ? result.change : change));
      setResourceChangeMessage('回滚成功。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function rollDice() {
    setError('');
    setDiceResult(null);
    setDiceRolling(true);
    try {
      const result = await adminDiceRoll(roomId, {
        die: diceDie,
        modifier: diceModifier,
        dc: diceDc,
        reason: diceReason.trim() || undefined
      });
      setDiceResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiceRolling(false);
    }
  }

  async function quickAbilityRoll(ability: string, mod: number, dc?: number) {
    setError('');
    setDiceResult(null);
    setDiceRolling(true);
    try {
      const result = await adminDiceRoll(roomId, {
        die: 'd20',
        modifier: mod,
        dc,
        reason: `${ability}属性检定`
      });
      setDiceResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiceRolling(false);
    }
  }

  async function quickSocialRoll(label: string, dc: number) {
    setError('');
    setDiceResult(null);
    setDiceRolling(true);
    try {
      const result = await adminDiceRoll(roomId, {
        die: 'd20',
        modifier: 0,
        dc,
        reason: `${label}检定`
      });
      setDiceResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiceRolling(false);
    }
  }

  async function doStartCombat() {
    setError('');
    setCombatBusy(true);
    try {
      const lines = combatParticipants.split('\n').filter(line => line.trim());
      const participants = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        const name = parts[0];
        const hp = Number(parts[1]) || 0;
        const ac = parts[2] ? Number(parts[2]) : undefined;
        const initiativeModifier = parts[3] ? Number(parts[3]) : undefined;
        return { name, hp, ac, initiativeModifier };
      });
      const state = await startCombat(roomId, { participants });
      setCombatState(state as unknown as CombatState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCombatBusy(false);
    }
  }

  async function doRollInitiative() {
    if (!combatState) return;
    setError('');
    setCombatBusy(true);
    try {
      const state = await rollCombatInitiative(roomId, combatState.id);
      setCombatState(state as unknown as CombatState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCombatBusy(false);
    }
  }

  async function doCombatAttack() {
    if (!combatState) return;
    setError('');
    setCombatBusy(true);
    try {
      const result = await combatAttack(roomId, {
        combatId: combatState.id,
        attackerId: combatAttackerId || combatState.participants[combatState.currentTurnIndex]?.id || '',
        targetId: combatTargetId || combatState.participants[(combatState.currentTurnIndex + 1) % combatState.participants.length]?.id || '',
        attackBonus: combatAttackBonus,
        damageDice: combatDamageDice,
        damageBonus: combatDamageBonus
      });
      if (result.newHp !== undefined) {
        setCombatState(prev => prev ? {
          ...prev,
          participants: prev.participants.map(p =>
            p.id === combatTargetId ? { ...p, hp: result.newHp! } : p
          )
        } : prev);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCombatBusy(false);
    }
  }

  async function doNextTurn() {
    if (!combatState) return;
    setError('');
    setCombatBusy(true);
    try {
      const state = await combatNextTurn(roomId, combatState.id);
      setCombatState(state as unknown as CombatState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCombatBusy(false);
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
      setDbMessage('');
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDbLoading(false);
    }
  }

  async function doImportFromUrl() {
    if (!dbUrl.trim()) return;
    setError('');
    setDbMessage('导入中...');
    setDbLoading(true);
    try {
      const result = await importFromUrl(dbUrl.trim(), dbImportName.trim() || undefined);
      setDbMessage(`已导入：${result.sourceType} · ${result.source.name}`);
      setDbUrl('');
      setDbImportName('');
      setDbPreview(null);
      await loadDbSources();
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDbLoading(false);
    }
  }

  async function doImportFromJs() {
    if (!dbJsCode.trim() || !dbJsName.trim()) return;
    setError('');
    setDbMessage('导入中...');
    setDbLoading(true);
    try {
      const result = await importJsDatabase(dbJsCode.trim(), dbJsName.trim());
      setDbMessage(`已导入：${result.sourceType} · ${result.source.name}`);
      setDbJsCode('');
      setDbJsName('');
      setDbPreview(null);
      await loadDbSources();
    } catch (err) {
      setDbMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDbLoading(false);
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

  if (!state) return <main className="shell"><p>加载中...</p></main>;

  return (
    <main className="shell">
      <div className="page-header">
        <h1>{state.room.name}</h1>
        <p className="muted">主持人控制台 · 第 {state.room.currentTurn} 回合 · {state.room.status}</p>
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
            {state.players.map((player) => <p key={player.id}>{player.name}</p>)}
            <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
            <div className="button-row">
              <button onClick={createPlayer}>创建玩家链接</button>
            </div>
            {lastLink ? <p><a href={lastLink}>{lastLink}</a></p> : null}
            <h2>行动</h2>
            {state.actions.map((action) => <p key={action.id}>{action.playerId}: {action.text}</p>)}
            <div className="button-row">
              <button onClick={advance}>处理本回合</button>
            </div>
            <h2>AI 错误</h2>
            {state.aiGenerations.filter((gen) => gen.error).map((gen) => <p key={gen.id}>{gen.error}</p>)}
          </aside>
          <LogList title="全部日志" logs={state.logs} />
        </div>
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'aiProvider'}>
        {aiProviderConfig ? (
          <>
            <h2>AI 接口</h2>
            <p className="muted">只配置模型服务连接，不包含 prompt、规则或约束内容。</p>
            <div className="form-grid">
              <label>Provider
                <select value={aiProviderConfig.provider} onChange={(event) => updateAiProviderConfig('provider', event.target.value)}>
                  <option value="mock">mock</option>
                  <option value="openai-compatible">openai-compatible</option>
                </select>
              </label>
              <label>API Base URL<input value={aiProviderConfig.baseUrl} onChange={(event) => updateAiProviderConfig('baseUrl', event.target.value)} /></label>
              <label>API Key<input type="password" value={aiProviderConfig.apiKey} onChange={(event) => updateAiProviderConfig('apiKey', event.target.value)} /></label>
              <label>Model<input value={aiProviderConfig.model} onChange={(event) => updateAiProviderConfig('model', event.target.value)} /></label>
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
                  <label>Provider
                    <select value={embeddingProviderConfig.provider} onChange={(event) => updateEmbeddingProviderConfig('provider', event.target.value)}>
                      <option value="mock">mock</option>
                      <option value="openai-compatible">openai-compatible</option>
                    </select>
                  </label>
                  <label>Base URL<input value={embeddingProviderConfig.baseUrl} onChange={(event) => updateEmbeddingProviderConfig('baseUrl', event.target.value)} /></label>
                  <label>API Key<input type="password" value={embeddingProviderConfig.apiKey} onChange={(event) => updateEmbeddingProviderConfig('apiKey', event.target.value)} /></label>
                  <label>Model<input value={embeddingProviderConfig.model} onChange={(event) => updateEmbeddingProviderConfig('model', event.target.value)} /></label>
                  <label>Dimensions<input type="number" value={embeddingProviderConfig.dimensions} onChange={(event) => updateEmbeddingProviderConfig('dimensions', Number(event.target.value))} /></label>
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

      <section className="card" role="tabpanel" hidden={activeTab !== 'diceCombat'}>
        <h2>检定与战斗</h2>
        <p className="muted">集中处理 DM 掷骰、快速检定、先攻和战斗中的 HP 调整。</p>
            <div className="subcard">
              <h3>骰点</h3>
              <p className="muted">DM 手动掷骰，结果会广播给所有玩家。</p>
              <div className="form-grid">
                <label>骰子类型
                  <select value={diceDie} onChange={(event) => setDiceDie(event.target.value as DieType)}>
                    <option value="d4">d4</option>
                    <option value="d6">d6</option>
                    <option value="d8">d8</option>
                    <option value="d10">d10</option>
                    <option value="d12">d12</option>
                    <option value="d20">d20</option>
                  </select>
                </label>
                <label>调整值<input type="number" value={diceModifier} onChange={(event) => setDiceModifier(Number(event.target.value))} /></label>
                <label>DC<input type="number" value={diceDc ?? ''} onChange={(event) => setDiceDc(event.target.value ? Number(event.target.value) : undefined)} /></label>
                <label>原因<input value={diceReason} onChange={(event) => setDiceReason(event.target.value)} placeholder="攻击检定" /></label>
              </div>
              <div className="button-row">
                <button onClick={rollDice} disabled={diceRolling}>{diceRolling ? '掷骰中...' : '掷骰'}</button>
              </div>
              {diceResult ? (
                <p>结果: {diceDie} [{diceResult.values.join(', ')}] + {diceResult.modifier} = {diceResult.total}{diceResult.success !== undefined ? (diceResult.success ? ' (成功)' : ' (失败)') : ''}</p>
              ) : null}
            </div>
            <div className="subcard">
              <h3>快速检定</h3>
              <p className="muted">属性检定（无熟练加值，调整值0，DC 10）：</p>
              <div className="button-row" style={{ flexWrap: 'wrap', gap: '4px' }}>
                <button onClick={() => quickAbilityRoll('STR', 0, 10)} disabled={diceRolling}>STR</button>
                <button onClick={() => quickAbilityRoll('DEX', 0, 10)} disabled={diceRolling}>DEX</button>
                <button onClick={() => quickAbilityRoll('CON', 0, 10)} disabled={diceRolling}>CON</button>
                <button onClick={() => quickAbilityRoll('INT', 0, 10)} disabled={diceRolling}>INT</button>
                <button onClick={() => quickAbilityRoll('WIS', 0, 10)} disabled={diceRolling}>WIS</button>
                <button onClick={() => quickAbilityRoll('CHA', 0, 10)} disabled={diceRolling}>CHA</button>
              </div>
              <p className="muted" style={{ marginTop: '8px' }}>社交行动（无调整值）：</p>
              <div className="button-row" style={{ flexWrap: 'wrap', gap: '4px' }}>
                <button onClick={() => quickSocialRoll('说服', 15)} disabled={diceRolling}>说服 DC15</button>
                <button onClick={() => quickSocialRoll('欺骗', 15)} disabled={diceRolling}>欺骗 DC15</button>
                <button onClick={() => quickSocialRoll('威吓', 17)} disabled={diceRolling}>威吓 DC17</button>
                <button onClick={() => quickSocialRoll('洞察', 12)} disabled={diceRolling}>洞察 DC12</button>
                <button onClick={() => quickSocialRoll('交易', 15)} disabled={diceRolling}>交易 DC15</button>
              </div>
            </div>
            <div className="subcard">
              <h3>战斗</h3>
              <p className="muted">管理战斗先攻顺序、攻击判定和 NPC HP。</p>
              <label>参战者 (每行: name hp ac initMod)<textarea value={combatParticipants} onChange={(event) => setCombatParticipants(event.target.value)} rows={3} /></label>
              <div className="button-row">
                <button onClick={doStartCombat} disabled={combatBusy}>开始战斗</button>
                <button onClick={doRollInitiative} disabled={!combatState || combatBusy}>掷先攻</button>
                <button onClick={doNextTurn} disabled={!combatState || combatBusy}>下一回合</button>
              </div>
              {combatState ? (
                <div className="subcard" style={{ marginTop: '8px' }}>
                  <p><strong>第 {combatState.round} 回合 · 当前行动者：{combatState.participants[combatState.currentTurnIndex]?.name ?? '--'}</strong></p>
                  {combatState.participants
                    .slice()
                    .sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity))
                    .map((p) => (
                      <div className="subcard" key={p.id} style={{ margin: '4px 0', border: p.id === combatState.participants[combatState.currentTurnIndex]?.id ? '2px solid #ffd700' : undefined }}>
                        <strong>{p.name}{p.isNpc ? ' (NPC)' : ''}</strong>
                        <p>先攻: {p.initiative ?? '--'} · AC: {p.ac}</p>
                        <div className="hp-bar-bg">
                          <div className="hp-bar-fill" style={{
                            width: `${Math.min(100, Math.round(p.hp / p.maxHp * 100))}%`,
                            background: p.hp > p.maxHp / 2 ? '#79bd74' : p.hp > 0 ? '#dfa34b' : '#de6f62'
                          }} />
                        </div>
                        <p className="muted">HP: {p.hp}/{p.maxHp}</p>
                      </div>
                    ))}
                  <div className="form-grid">
                    <label>攻击者 ID<input value={combatAttackerId} onChange={(event) => setCombatAttackerId(event.target.value)} placeholder={combatState.participants[combatState.currentTurnIndex]?.id ?? ''} /></label>
                    <label>目标 ID<input value={combatTargetId} onChange={(event) => setCombatTargetId(event.target.value)} placeholder={combatState.participants[(combatState.currentTurnIndex + 1) % combatState.participants.length]?.id ?? ''} /></label>
                    <label>攻击加值<input type="number" value={combatAttackBonus} onChange={(event) => setCombatAttackBonus(Number(event.target.value))} /></label>
                    <label>伤害骰<input value={combatDamageDice} onChange={(event) => setCombatDamageDice(event.target.value)} /></label>
                    <label>伤害加值<input type="number" value={combatDamageBonus} onChange={(event) => setCombatDamageBonus(Number(event.target.value))} /></label>
                  </div>
                  <div className="button-row">
                    <button onClick={doCombatAttack} disabled={!combatState || combatBusy}>攻击</button>
                  </div>
                </div>
              ) : null}
            </div>
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'characterResources'}>
        <h2>角色资源</h2>
        <p className="muted">查询并回滚角色 HP、法术位、货币等资源变更。</p>
            <div className="subcard">
              <h3>角色资源变更</h3>
              <p className="muted">查询角色的资源变更历史并支持回滚操作。</p>
              <label>角色 ID<input value={resourceChangeCharId} onChange={(event) => setResourceChangeCharId(event.target.value)} placeholder="char-1" /></label>
              <div className="button-row">
                <button onClick={fetchResourceChanges} disabled={resourceChangeLoading}>{resourceChangeLoading ? '查询中...' : '查询变更'}</button>
              </div>
              {resourceChangeMessage ? <p>{resourceChangeMessage}</p> : null}
              {resourceChanges.length > 0 ? (
                <div className="changes-list">
                  {resourceChanges.map((change) => (
                    <div className="subcard" key={change.id}>
                      <strong>{change.path}</strong>
                      <p>{String(change.before)} → {String(change.after)}</p>
                      <p className="muted">{change.reason} · {change.actorType} · {change.createdAt}</p>
                      {!change.revertedAt ? (
                        <button onClick={() => rollbackChange(change.id, 'admin-1')}>回滚</button>
                      ) : (
                        <p className="muted">已于 {change.revertedAt} 回滚</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
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
                      <p className="muted">回合 {s.turnStart}-{s.turnEnd} · {s.createdAt}</p>
                      <p>{s.summary}</p>
                    </div>
                  ))}
                </div>
              ) : null}

              <div style={{ marginTop: '12px' }}>
                <strong>任务</strong>
                {quests.map((q) => (
                  <div className="subcard" key={q.id}>
                    <strong>{q.title}</strong> <span className="muted">[{q.status}]</span>
                    <p>{q.description}</p>
                  </div>
                ))}
                <label>标题<input value={questDraft.title} onChange={(e) => setQuestDraft({ ...questDraft, title: e.target.value })} placeholder="新任务" /></label>
                <label>状态
                  <select value={questDraft.status} onChange={(e) => setQuestDraft({ ...questDraft, status: e.target.value as CampaignQuest['status'] })}>
                    <option value="active">active</option>
                    <option value="in_progress">in_progress</option>
                    <option value="completed">completed</option>
                    <option value="failed">failed</option>
                  </select>
                </label>
                <label>描述<input value={questDraft.description} onChange={(e) => setQuestDraft({ ...questDraft, description: e.target.value })} /></label>
                <button onClick={doUpdateQuest}>保存任务</button>
              </div>

              <div style={{ marginTop: '12px' }}>
                <strong>NPC</strong>
                {npcs.map((n) => (
                  <div className="subcard" key={n.id}>
                    <strong>{n.name}</strong> <span className="muted">({n.role}, {n.attitude})</span>
                    <p>{n.notes} [{n.location}]</p>
                  </div>
                ))}
                <label>名称<input value={npcDraft.name} onChange={(e) => setNpcDraft({ ...npcDraft, name: e.target.value })} placeholder="NPC 名称" /></label>
                <label>角色<input value={npcDraft.role} onChange={(e) => setNpcDraft({ ...npcDraft, role: e.target.value })} placeholder="商人/守卫/盗贼" /></label>
                <label>态度
                  <select value={npcDraft.attitude} onChange={(e) => setNpcDraft({ ...npcDraft, attitude: e.target.value as CampaignNpc['attitude'] })}>
                    <option value="friendly">friendly</option>
                    <option value="neutral">neutral</option>
                    <option value="hostile">hostile</option>
                    <option value="unknown">unknown</option>
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
          <h2>数据库管理</h2>
          <p className="muted">从远程 URL 或 JS 代码导入结构化数据，支持增量更新检测。</p>

          <div className="subcard">
            <h4>从 URL 导入</h4>
            <label>URL<input value={dbUrl} onChange={(event) => setDbUrl(event.target.value)} placeholder="https://example.com/world-book.json" /></label>
            <label>名称（可选）<input value={dbImportName} onChange={(event) => setDbImportName(event.target.value)} placeholder="默认从 URL 提取" /></label>
            <div className="button-row">
              <button onClick={doImportFromUrl} disabled={dbLoading}>{dbLoading ? '导入中...' : '从 URL 导入'}</button>
            </div>
          </div>

          <div className="subcard">
            <h4>从 JS 代码导入</h4>
            <label>名称<input value={dbJsName} onChange={(event) => setDbJsName(event.target.value)} placeholder="数据源名称" /></label>
            <label>JS 代码<textarea value={dbJsCode} onChange={(event) => setDbJsCode(event.target.value)} rows={4} placeholder="module.exports = { entries: [...] };" /></label>
            <div className="button-row">
              <button onClick={doImportFromJs} disabled={dbLoading}>{dbLoading ? '导入中...' : '从 JS 代码导入'}</button>
            </div>
          </div>

          {dbPreview ? (
            <div className="subcard">
              <h4>导入预览</h4>
              {dbPreview.entryTypes.map((et, index) => (
                <p key={index}>{et.type}: {et.count} 条</p>
              ))}
            </div>
          ) : null}

          <div className="subcard">
            <h4>已导入源</h4>
            <div className="button-row">
              <button onClick={loadDbSources} disabled={dbLoading}>{dbLoading ? '加载中...' : '刷新列表'}</button>
            </div>
            {dbMessage ? <p>{dbMessage}</p> : null}
            {dbSources.length === 0 ? (
              <p className="muted">暂无已导入的数据源。</p>
            ) : (
              dbSources.map((source) => (
                <div className="subcard" key={source.id}>
                  <strong>{source.name}</strong>
                  <p className="muted">
                    类型：{source.sourceType} · 版本：{source.version || '--'} · 哈希：{source.fileHash.substring(0, 12)}... · 条目数：{source.entryCount} · 大小：{source.fileSize} bytes
                    {source.lastCheckedAt ? ` · 上次检查：${source.lastCheckedAt}` : ''}
                  </p>
                  <div className="button-row">
                    <button onClick={() => doCheckDbUpdates(source.id)}>检查更新</button>
                    <button onClick={() => doUpdateDbSource(source.id)}>更新</button>
                    <button onClick={() => doDeleteDbSource(source.id)}>删除</button>
                  </div>
                </div>
              ))
            )}
          </div>
      </section>

      <section className="card" role="tabpanel" hidden={activeTab !== 'presets'}>
        <h2>预设管理</h2>
        <p className="muted">全局提示词预设会实时影响所有房间，可启用、排序并决定注入位置。</p>
        <div className="button-row">
          <button onClick={loadPromptPreview}>预览 AI 请求</button>
        </div>
        <PromptPreviewPanel preview={promptPreview} />

        <div className="subcard" style={{ marginTop: '16px' }}>
          <h3>预设模板</h3>
          <p className="muted">选择一个预设模板快速配置 AI-DM 行为风格。应用后会创建新的全局预设并自动启用。</p>
          {activePresetType ? (
            <p>当前激活模板类型：<strong>{activePresetType}</strong></p>
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
            <p>提示词块：{preset.blocks.length}{preset.presetType ? ` · 类型：${preset.presetType}` : ''}{preset.isTemplate ? ' (模板)' : ''}</p>
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
                      {block.position} · {block.role} · {block.enabled ? '启用' : '停用'} · 排序 {block.orderIndex}
                      {block.category ? ` · ${block.category}` : ''}
                      {block.sceneType ? ` · 场景: ${block.sceneType}` : ''}
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
