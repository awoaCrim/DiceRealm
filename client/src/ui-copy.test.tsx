// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from './pages/HomePage';
import { CharacterCard } from './components/CharacterCard';
import { TurnPanel } from './components/TurnPanel';
import { LogList } from './components/LogList';
import type { AdminState, AiProviderConfig, GlobalResourceWorldBookBinding, ResourceWorldBook, ScriptCard } from './types';
import { AdminPage } from './pages/AdminPage';
import { ResourceImportPanel } from './components/ResourceImportPanel';
import { GlobalResourceConfigPanel } from './components/RoomResourceBindingsPanel';
import { PromptPreviewPanel } from './components/PromptPreviewPanel';
import { PlayerPage } from './pages/PlayerPage';
import * as api from './api';

vi.mock('./api', () => ({
  createRoom: vi.fn(),
  getAdminState: vi.fn(async (): Promise<AdminState> => ({
    room: {
      id: 'room-1',
      name: '测试房间',
      systemPrompt: '测试系统提示',
      worldInfo: '测试世界',
      currentTurn: 1,
      status: 'waiting_for_actions',
      aiConfig: {
        coreRules: '核心约束',
        playerAgencyRules: '玩家自主权',
        visibilityRules: '信息隔离',
        interactionRules: '玩家互动',
        outputFormatRules: '输出格式',
        styleRules: '叙事风格'
      },
      createdAt: '2026-05-27T00:00:00.000Z'
    },
    players: [],
    turns: [],
    actions: [],
    interactions: [],
    logs: [],
    aiGenerations: [],
    turnReadiness: {
      turnId: 'turn-1',
      status: 'ready_to_resolve',
      requiredActorIds: [],
      submittedActorIds: [],
      skippedActorIds: [],
      excludedActorIds: [],
      completedActorIds: [],
      missingActorIds: [],
      ready: true
    },
    globalConfig: {
      aiConfig: {
        coreRules: '核心约束',
        playerAgencyRules: '玩家自主权',
        visibilityRules: '信息隔离',
        interactionRules: '玩家互动',
        outputFormatRules: '输出格式',
        styleRules: '叙事风格'
      },
      aiProviderConfig: {
        provider: 'mock',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini'
      },
      embeddingProviderConfig: {
        provider: 'mock',
        baseUrl: 'https://embedding.example/v1',
        apiKey: '',
        model: 'text-embedding-3-small',
        dimensions: 1536
      },
      activeScriptCardId: 'script-1',
      activePresetPackageId: null,
      globalWorldBookBindings: [],
      presets: [],
      worldBooks: [],
      worldBookEntries: [],
      scriptCards: [],
      resourceWorldBooks: [],
      resourceWorldBookEntries: [],
      presetPackages: []
    },
    presets: [{
      id: 'preset-1',
      roomId: 'room-1',
      name: '默认强约束预设',
      description: '测试预设',
      isActive: true,
      blocks: [
        {
          id: 'block-core',
          name: '核心规则',
          role: 'system',
          position: 'before_world',
          enabled: true,
          orderIndex: 10,
          content: '核心规则内容'
        },
        {
          id: 'block-output',
          name: '输出格式规则',
          role: 'system',
          position: 'final',
          enabled: true,
          orderIndex: 100,
          content: '输出格式内容'
        }
      ],
      createdAt: '2026-05-27T00:00:00.000Z',
      updatedAt: '2026-05-27T00:00:00.000Z'
    }],
    worldBooks: [],
    worldBookEntries: [],
    scriptCards: [
      {
        id: 'script-1',
        name: '旧剧本卡',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        visibilityNotes: '',
        sourceType: 'sillytavern_character',
        rawJson: {},
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z'
      },
      {
        id: 'script-2',
        name: '新剧本卡',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        visibilityNotes: '',
        sourceType: 'sillytavern_character',
        rawJson: {},
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z'
      }
    ],
    resourceWorldBooks: [],
    resourceWorldBookEntries: [],
    presetPackages: [],
    globalScriptCardId: 'script-1',
    globalWorldBookBindings: [],
    globalPresetPackageId: null,
    roomScriptBinding: null,
    roomWorldBookBindings: [],
    roomPresetBinding: null
  })),
  addPlayer: vi.fn(),
  processTurn: vi.fn(),
  createAiTurnPreview: vi.fn(async () => ({
    previewId: 'preview-1',
    roomId: 'room-1',
    turnId: 'turn-1',
    flatPrompt: '## Character Status\nFighter HP 12/12\n\nOriginal prompt',
    messages: [{ role: 'user', content: '## Character Status\nFighter HP 12/12\n\nOriginal prompt' }],
    contextSections: [{ title: 'Character Status', content: 'Fighter HP 12/12' }],
    warnings: []
  })),
  sendAiTurnPreview: vi.fn(async () => ({
    responseText: 'AI narration result',
    suggestedStateChanges: [{ type: 'dice_request', reason: 'attack roll' }],
    raw: { publicLog: 'AI narration result', privateUpdatesByPlayer: {}, ruleResults: [], interactionRequests: [] }
  })),
  getGlobalAiProviderConfig: vi.fn(async () => ({
    provider: 'mock',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  })),
  getGlobalEmbeddingProviderConfig: vi.fn(async () => ({
    provider: 'mock',
    baseUrl: 'https://embedding.example/v1',
    apiKey: '',
    model: 'text-embedding-3-small',
    dimensions: 1536
  })),
  saveGlobalEmbeddingProviderConfig: vi.fn(async (config) => config),
  testGlobalEmbeddingProviderConfig: vi.fn(async () => ({ ok: true })),
  reindexRuleEmbeddings: vi.fn(async () => ({ indexed: 1, skipped: 0 })),
  previewRuleRetrieval: vi.fn(async () => ({ matches: [] })),
  saveGlobalAiProviderConfig: vi.fn(async (config) => config),
  testGlobalAiProviderConfig: vi.fn(async () => ({ ok: true })),
  previewAiPrompt: vi.fn(async () => ({
    mode: 'native',
    prompt: '核心约束\n输出格式',
    messages: [],
    slots: [],
    worldBookMatches: [],
    ruleMatches: [],
    promptBlocks: [],
    warnings: []
  })),
  importSillyTavernScriptCard: vi.fn(),
  importSillyTavernWorldBook: vi.fn(),
  importSillyTavernPresetPackage: vi.fn(),
  getApprovedCatalogs: vi.fn(async () => ({ ruleEntries: [], characterOptions: [], resourceRules: [] })),
  createResourceImportJob: vi.fn(),
  listResourceImportDrafts: vi.fn(async () => ({ drafts: [] })),
  listResourceImportJobs: vi.fn(async () => ({ jobs: [] })),
  reviewResourceImportDraft: vi.fn(),
  putGlobalScriptCard: vi.fn(),
  clearGlobalScriptCard: vi.fn(),
  putGlobalResourceWorldBookBindings: vi.fn(),
  putGlobalPresetPackage: vi.fn(),
  clearGlobalPresetPackage: vi.fn(),
  savePreset: vi.fn(async () => ({ preset: null, presets: [] })),
  activatePreset: vi.fn(async () => ({ preset: null, presets: [] })),
  listPresetTemplates: vi.fn(async () => ({ templates: [] })),
  applyPresetTemplate: vi.fn(async () => ({ preset: null, presets: [] })),
  getActivePresetType: vi.fn(async () => ({ presetType: null })),
  createWorldBook: vi.fn(async () => ({ worldBook: null, worldBooks: [] })),
  createWorldBookEntry: vi.fn(async () => ({ entry: null, entries: [] })),
  getPlayerState: vi.fn(async () => ({
    room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
    player: { id: 'player-1', name: '测试玩家' },
    character: null,
    publicLogs: [],
    privateLogs: [],
    pendingInteractions: [],
    submittedPlayers: [],
    waitingPlayers: [],
    ruleSummaries: []
  })),
  submitAction: vi.fn(async (_token: string, _text: string, _actionType?: string, _isHiddenRoll?: boolean) => ({ ok: true })),
  respondToInteraction: vi.fn(async () => ({ ok: true })),
  subscribeRoom: vi.fn(() => () => {}),
  getCharacterBuilderOptions: vi.fn(async () => ({
    options: { species: [], classes: [], backgrounds: [], skills: [], equipment: [], spells: [], languages: [], proficiencies: [] }
  })),
  auditCharacterBuilderDraft: vi.fn(async () => ({
    draft: {
      name: '新英雄',
      concept: '',
      species: '',
      className: '',
      background: '',
      abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      skills: [],
      equipment: [],
      spells: [],
      personality: '',
      ideal: '',
      bond: '',
      flaw: '',
      notes: ''
    },
    audit: { valid: false, issues: [] }
  })),
  saveCharacterBuilderDraft: vi.fn(async () => ({ character: null })),
  confirmCharacterBuilderDraft: vi.fn(async () => ({ character: null })),
  restCharacter: vi.fn(async () => ({ resources: { hitPoints: { current: 12, max: 12, temp: 0 }, hitDice: { total: 5, remaining: 4, die: 'd8' }, spellSlots: {}, ammo: [], consumables: [], currency: { gp: 0, sp: 0, cp: 0 }, conditions: [] } })),
  listCharacterResourceChanges: vi.fn(async () => ({ changes: [] })),
  rollbackCharacterResourceChange: vi.fn(async () => ({ change: { id: 'ch-1', revertedAt: '2026-05-30T01:00:00.000Z' } })),
  adminDiceRoll: vi.fn(async () => ({ values: [15], modifier: 3, total: 18, success: true })),
  startCombat: vi.fn(async () => ({
    id: 'combat-1',
    roomId: 'room-1',
    participants: [
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false },
      { id: 'c-2', name: '哥布林', hp: 7, maxHp: 7, ac: 15, initiative: 18, isNpc: true }
    ],
    currentTurnIndex: 0,
    round: 1,
    status: 'active'
  })),
  rollCombatInitiative: vi.fn(async () => ({
    id: 'combat-1',
    roomId: 'room-1',
    participants: [
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false },
      { id: 'c-2', name: '哥布林', hp: 7, maxHp: 7, ac: 15, initiative: 18, isNpc: true }
    ],
    currentTurnIndex: 0,
    round: 1,
    status: 'active'
  })),
  combatAttack: vi.fn(async () => ({ hit: true, attackRoll: { values: [12], modifier: 5, total: 17 }, damage: { dice: '1d8', bonus: 3, total: 8 }, newHp: 4 })),
  combatNextTurn: vi.fn(async () => ({
    id: 'combat-1',
    roomId: 'room-1',
    participants: [
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false },
      { id: 'c-2', name: '哥布林', hp: 7, maxHp: 7, ac: 15, initiative: 18, isNpc: true }
    ],
    currentTurnIndex: 1,
    round: 2,
    status: 'active'
  })),
  getCombatState: vi.fn(async () => ({
    id: 'combat-1',
    roomId: 'room-1',
    participants: [
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false },
      { id: 'c-2', name: '哥布林', hp: 7, maxHp: 7, ac: 15, initiative: 18, isNpc: true }
    ],
    currentTurnIndex: 0,
    round: 1,
    status: 'active'
  })),
  getDiceLogs: vi.fn(async () => ({ logs: [
    { id: 'log-1', roomId: 'room-1', playerName: '洛林', die: 'd20', values: [15], modifier: 5, total: 20, reason: '攻击检定', success: true, createdAt: '2026-05-30T00:00:00.000Z' },
    { id: 'log-2', roomId: 'room-1', playerName: 'DM', die: 'd4', values: [2], modifier: 2, total: 4, reason: '匕首伤害', success: undefined, createdAt: '2026-05-30T00:01:00.000Z' }
  ] })),
  listSessionSummaries: vi.fn(async () => ({ summaries: [] })),
  triggerSessionSummary: vi.fn(async () => ({ summary: { id: 's-1', roomId: 'room-1', turnStart: 1, turnEnd: 5, summary: '队伍击败地精。', questUpdatesJson: '[]', npcUpdatesJson: '[]', locationUpdatesJson: '[]', characterUpdatesJson: '[]', createdAt: '2026-05-30T00:00:00.000Z' } })),
  listQuests: vi.fn(async () => ({ quests: [] })),
  updateQuest: vi.fn(async () => ({ quest: { id: 'q-1', roomId: 'room-1', title: '调查矿井', status: 'in_progress', description: '', updatedAt: '2026-05-30T00:00:00.000Z' } })),
  listNpcs: vi.fn(async () => ({ npcs: [] })),
  updateNpc: vi.fn(async () => ({ npc: { id: 'n-1', roomId: 'room-1', name: '格拉克', role: '地精首领', attitude: 'hostile', notes: '', location: '', updatedAt: '2026-05-30T00:00:00.000Z' } })),
  listLocations: vi.fn(async () => ({ locations: [] })),
  updateLocation: vi.fn(async () => ({ location: { id: 'l-1', roomId: 'room-1', name: '废弃矿井', description: '', notes: '', updatedAt: '2026-05-30T00:00:00.000Z' } })),
  // DB Management Center mocks
  importFromUrl: vi.fn(async () => ({ source: { id: 'src-1', url: '', name: 'World A', sourceType: 'world_book', version: '', fileHash: 'abc123', fileSize: 100, entryCount: 5, lastCheckedAt: '', createdAt: '' }, sourceType: 'world_book', worldBook: { name: 'World A', id: 'wb-1' }, draftsCount: 0 })),
  importJsDatabase: vi.fn(async () => ({ source: { id: 'src-2', url: '', name: 'JS World', sourceType: 'world_book', version: '', fileHash: 'ghi789', fileSize: 50, entryCount: 3, lastCheckedAt: '', createdAt: '' }, sourceType: 'world_book', worldBook: { name: 'JS World', id: 'wb-2' }, preview: { entryTypes: [{ type: 'world_book_entries', count: 3 }] }, draftsCount: 0 })),
  listDbSources: vi.fn(async () => ({ sources: [] })),
  checkDbSourceUpdates: vi.fn(async () => ({ hasUpdate: false })),
  updateDbSource: vi.fn(async () => ({ source: { id: 'src-1', url: '', name: 'World A', sourceType: 'world_book', version: '', fileHash: 'newhash', fileSize: 100, entryCount: 5, lastCheckedAt: '', createdAt: '' }, sourceType: 'world_book', worldBook: { name: 'World A', id: 'wb-1' }, draftsCount: 0 })),
  deleteDbSource: vi.fn(async () => ({ ok: true as const }))
}));

function resourceWorldBook(id: string, name: string): ResourceWorldBook {
  return {
    id,
    name,
    sourceType: 'sillytavern_world_book',
    rawJson: {},
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z'
  };
}

function globalWorldBookBinding(worldBookId: string, enabled: boolean, orderIndex: number): GlobalResourceWorldBookBinding {
  return {
    worldBookId,
    enabled,
    orderIndex,
    createdAt: '2026-05-27T00:00:00.000Z'
  };
}

describe('中文界面文案', () => {
  it('首页使用中文创建房间文案', () => {
    render(<HomePage />);

    expect(screen.getByText('创建本地多人跑团房间，并为每位玩家隔离可见信息。')).toBeInTheDocument();
    expect(screen.getByText('所有房间都会实时使用当前全局配置。')).toBeInTheDocument();
    expect(screen.getByText('房间名称')).toBeInTheDocument();
    expect(screen.queryByText('世界信息')).not.toBeInTheDocument();
    expect(screen.queryByText('AI-DM 指令')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建房间' })).toBeInTheDocument();
  });

  it('公共组件使用中文空状态和回合文案', () => {
    render(
      <>
        <CharacterCard character={null} />
        <TurnPanel currentTurn={2} status="waiting_for_actions" submittedPlayers={[]} waitingPlayers={[]} />
        <LogList title="公开日志" logs={[]} />
      </>
    );

    expect(screen.getByText('角色卡')).toBeInTheDocument();
    expect(screen.getByText('暂无角色。')).toBeInTheDocument();
    expect(screen.getByText('第 2 回合')).toBeInTheDocument();
    expect(screen.getByText('状态：')).toBeInTheDocument();
    expect(screen.getByText('已提交')).toBeInTheDocument();
    expect(screen.getByText('暂无玩家提交。')).toBeInTheDocument();
    expect(screen.getByText('等待中')).toBeInTheDocument();
    expect(screen.getByText('所有玩家都已提交。')).toBeInTheDocument();
    expect(screen.getByText('暂无记录。')).toBeInTheDocument();
  });

  it('AI prompt 预览展示 5e 规则命中', () => {
    render(<PromptPreviewPanel preview={{
      mode: 'native',
      prompt: '规则 prompt',
      messages: [],
      slots: [],
      worldBookMatches: [],
      ruleMatches: [{ entryId: 'rule-1', title: '攻击检定', category: 'combat', score: 1, reasons: ['keyword'], summary: '攻击时掷 d20 对抗 AC。' }],
      promptBlocks: [],
      warnings: []
    }} />);

    expect(screen.getByText('5e 规则命中')).toBeInTheDocument();
    expect(screen.getByText('攻击检定')).toBeInTheDocument();
    expect(screen.getByText('攻击时掷 d20 对抗 AC。')).toBeInTheDocument();
  });

  it('玩家页展示本轮规则摘要', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: null,
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: [{ entryId: 'rule-1', title: '攻击检定', summary: '攻击时掷 d20 对抗 AC。', reason: '参考规则', createdAt: '2026-05-30T00:00:00.000Z' }]
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('本轮规则摘要')).toBeInTheDocument();
    expect(screen.getByText('攻击检定')).toBeInTheDocument();
    expect(screen.getByText('攻击时掷 d20 对抗 AC。')).toBeInTheDocument();
  });

  it('玩家页展示行动类型选择器和隐藏骰点开关', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: null,
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: []
    });
    const user = userEvent.setup();

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('行动类型')).toBeInTheDocument();
    const select = screen.getByLabelText('行动类型') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    await user.selectOptions(select, 'exploration');
    expect(screen.getByText('具体行动')).toBeInTheDocument();
    expect(screen.getByText('潜行')).toBeInTheDocument();
    expect(screen.getByText('开锁')).toBeInTheDocument();
    expect(screen.getByText('隐藏骰点（仅玩家本人可见）')).toBeInTheDocument();

    // Switch to social
    await user.selectOptions(select, 'social');
    expect(screen.getByText('说服')).toBeInTheDocument();
    expect(screen.getByText('交易')).toBeInTheDocument();

    // Select a specific social action and see DC hint
    await user.selectOptions(screen.getByLabelText('具体行动') as HTMLSelectElement, 'persuade');
    expect(screen.getByText('预计 DC: DC 15 (魅力)')).toBeInTheDocument();
  });

  it('玩家没有确认角色时展示角色创建向导', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: {
        id: 'char-1',
        playerId: 'player-1',
        sheet: {
          name: '新英雄',
          species: '',
          className: '',
          level: 1,
          abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
          hitPoints: { current: 10, max: 10 },
          armorClass: 10,
          proficiencyBonus: 2,
          skills: [],
          equipment: [],
          spells: [],
          languages: [],
          proficiencies: [],
          privateNotes: '',
          builderDraft: {
            name: '新英雄',
            concept: '',
            species: '',
            className: '',
            background: '',
            abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
            skills: [],
            equipment: [],
            spells: [],
            languages: [],
            proficiencies: [],
            personality: '',
            ideal: '',
            bond: '',
            flaw: '',
            notes: ''
          }
        },
        draftSource: 'manual' as const,
        confirmed: false,
        updatedAt: '2026-05-30T00:00:00.000Z'
      },
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: []
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByRole('button', { name: '创建角色' })).toBeInTheDocument();
    expect(screen.getByText('尚未确认角色。使用分步向导创建角色，草稿可随时保存。')).toBeInTheDocument();
    expect(screen.queryByText('暂无角色。')).not.toBeInTheDocument();
  });

  it('管理员页通过标签页展示各功能区文案', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    expect(await screen.findByRole('button', { name: '总览' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI 接口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检定战斗' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '角色资源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '战役记忆' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '资源配置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '数据库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预设' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '世界书' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI 约束' })).not.toBeInTheDocument();

    expect(screen.getByText('玩家')).toBeInTheDocument();
    expect(screen.getByText('全部日志')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'AI 接口' }));
    expect(screen.getByRole('heading', { name: 'AI 接口' })).toBeInTheDocument();
    expect(screen.getByText('只配置模型服务连接，不包含 prompt、规则或约束内容。')).toBeInTheDocument();
    expect(screen.getAllByText('Provider')[0]).toBeInTheDocument();
    expect(screen.getByText('API Base URL')).toBeInTheDocument();
    expect(screen.getAllByText('API Key')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Model')[0]).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存 AI 接口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '资源配置' }));
    expect(screen.getByText('全局资源库 / 导入')).toBeInTheDocument();
    expect(screen.getByText('全局资源配置')).toBeInTheDocument();
    expect(screen.queryByText('房间资源绑定')).not.toBeInTheDocument();
    expect(screen.getByText('导入 ST 角色卡为剧本卡')).toBeInTheDocument();
    expect(screen.getByText('ST 兼容预设包')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '预设' }));
    expect(screen.getByText('预设管理')).toBeInTheDocument();
    expect(screen.getByText('默认强约束预设（当前启用）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览 AI 请求' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '世界书' }));
    expect(screen.getByRole('heading', { name: '世界书' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建世界书' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加世界书条目' })).toBeInTheDocument();
  });

  it('总览页先生成可编辑 AI 回合提示词，再发送给 AI', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createAiTurnPreview).mockClear();
    vi.mocked(api.sendAiTurnPreview).mockClear();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '生成 AI 回合提示词' }));

    expect(await screen.findByText('AI-DM 回合调试')).toBeInTheDocument();
    expect(api.createAiTurnPreview).toHaveBeenCalledWith('room-1');
    const promptBox = screen.getByLabelText('可编辑提示词');
    expect((promptBox as HTMLTextAreaElement).value).toContain('Fighter HP 12/12');

    await user.type(promptBox, '\nDM extra note');
    await user.click(screen.getByRole('button', { name: '发送给 AI' }));

    await waitFor(() => expect(api.sendAiTurnPreview).toHaveBeenCalledWith(
      'room-1',
      'preview-1',
      expect.stringContaining('DM extra note')
    ));
    expect(await screen.findByText('AI narration result')).toBeInTheDocument();
    expect(screen.getByText(/attack roll/)).toBeInTheDocument();
    expect(screen.getByText('AI 已返回结果；建议变更仅展示，不会自动写入角色卡或战局。')).toBeInTheDocument();
  });

  it('总览页在回合未就绪时禁用生成提示词并显示缺席玩家', async () => {
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      players: [
        { id: 'player-1', roomId: 'room-1', name: '阿瑞', token: 't1', isConnected: true, createdAt: '2026-05-27T00:00:00.000Z' },
        { id: 'player-2', roomId: 'room-1', name: '波', token: 't2', isConnected: true, createdAt: '2026-05-27T00:01:00.000Z' }
      ],
      turnReadiness: {
        turnId: 'turn-1',
        status: 'open',
        requiredActorIds: ['player-1', 'player-2'],
        submittedActorIds: ['player-1'],
        skippedActorIds: [],
        excludedActorIds: [],
        completedActorIds: ['player-1'],
        missingActorIds: ['player-2'],
        ready: false
      }
    });

    render(<AdminPage roomId="room-1" />);

    expect(await screen.findByText('等待玩家行动：1 / 2 已完成')).toBeInTheDocument();
    expect(screen.getByText('未提交：波')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成 AI 回合提示词' })).toBeDisabled();
    expect(screen.getByText('提示：所有必需玩家提交、跳过或被管理员排除后，才能生成提示词。')).toBeInTheDocument();
  });

  it('资源配置标签页展示资源导入与审核入口', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '资源配置' }));

    expect(await screen.findByText('资源导入与审核')).toBeInTheDocument();
    expect(screen.getByText('导入 PHB、世界书或规则数据库抽取 JSON；只有批准后的草稿会进入稳定目录。')).toBeInTheDocument();
  });

  it('管理页切换标签页不会清空未保存的全局主剧本卡选择', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '资源配置' }));
    const scriptSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;

    await user.selectOptions(scriptSelect, 'script-2');
    await user.click(screen.getByRole('button', { name: 'AI 接口' }));
    await user.click(screen.getByRole('button', { name: '资源配置' }));

    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('script-2');
  });

  it('预设提示词块可以折叠展开，新增块自动展开', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await screen.findByRole('button', { name: '预设' });
    await user.click(screen.getByRole('button', { name: '预设' }));
    await user.click(screen.getByRole('button', { name: '编辑预设' }));

    expect(screen.getByRole('button', { name: /核心规则/ })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('核心规则内容')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /核心规则/ }));
    expect(screen.getByDisplayValue('核心规则内容')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /输出格式规则/ }));
    expect(screen.getByDisplayValue('输出格式内容')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('核心规则内容')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /输出格式规则/ }));
    expect(screen.queryByDisplayValue('输出格式内容')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新增提示词块' }));
    expect(screen.getByDisplayValue('新的约束内容。')).toBeInTheDocument();
  });

  it('非总览标签页操作失败时显示统一错误提示', async () => {
    const user = userEvent.setup();
    vi.mocked(api.testGlobalAiProviderConfig).mockRejectedValueOnce(new Error('连接失败'));
    vi.mocked(api.previewAiPrompt).mockRejectedValueOnce(new Error('预览失败'));
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: 'AI 接口' }));
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('连接失败');

    await user.click(screen.getByRole('button', { name: '预设' }));
    await user.click(screen.getByRole('button', { name: '预览 AI 请求' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('预览失败');
  });

  it('AI 接口页展示 Embedding 配置和规则向量索引操作', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveGlobalEmbeddingProviderConfig).mockClear();
    vi.mocked(api.testGlobalEmbeddingProviderConfig).mockClear();
    vi.mocked(api.reindexRuleEmbeddings).mockClear();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: 'AI 接口' }));

    const embeddingCard = screen.getByRole('heading', { name: 'Embedding 接口' }).closest('.subcard') as HTMLElement;
    expect(embeddingCard).toBeInTheDocument();
    expect(within(embeddingCard).getByText('Provider')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('Base URL')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('API Key')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('Model')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('Dimensions')).toBeInTheDocument();
    expect(within(embeddingCard).getByRole('button', { name: '保存 Embedding 接口' })).toBeInTheDocument();
    expect(within(embeddingCard).getByRole('button', { name: '测试 Embedding' })).toBeInTheDocument();
    expect(within(embeddingCard).getByRole('button', { name: '重建规则向量索引' })).toBeInTheDocument();

    await user.click(within(embeddingCard).getByRole('button', { name: '保存 Embedding 接口' }));
    await waitFor(() => expect(api.saveGlobalEmbeddingProviderConfig).toHaveBeenCalledWith({
      provider: 'mock',
      baseUrl: 'https://embedding.example/v1',
      apiKey: '',
      model: 'text-embedding-3-small',
      dimensions: 1536
    }));
    expect(await screen.findByText('Embedding 接口已保存。')).toBeInTheDocument();

    let resolveEmbeddingTest: (() => void) | undefined;
    vi.mocked(api.testGlobalEmbeddingProviderConfig).mockImplementationOnce(() => new Promise((resolve) => {
      resolveEmbeddingTest = () => resolve({ ok: true });
    }));
    await user.click(within(embeddingCard).getByRole('button', { name: '测试 Embedding' }));
    expect(within(embeddingCard).getByRole('button', { name: '测试中...' })).toBeDisabled();
    resolveEmbeddingTest?.();
    await waitFor(() => expect(api.testGlobalEmbeddingProviderConfig).toHaveBeenCalled());
    expect(await screen.findByText('Embedding 测试成功。')).toBeInTheDocument();

    await user.click(within(embeddingCard).getByRole('button', { name: '重建规则向量索引' }));
    await waitFor(() => expect(api.reindexRuleEmbeddings).toHaveBeenCalled());
    expect(await screen.findByText('规则向量索引已重建：indexed 1，skipped 0。')).toBeInTheDocument();
  });

  it('AI 接口页能保存并测试 provider 配置', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveGlobalAiProviderConfig).mockClear();
    vi.mocked(api.testGlobalAiProviderConfig).mockClear();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: 'AI 接口' }));
    await user.selectOptions(screen.getAllByLabelText('Provider')[0], 'openai-compatible');
    await user.clear(screen.getByLabelText('API Base URL'));
    await user.type(screen.getByLabelText('API Base URL'), 'https://example.test/v1');
    await user.type(screen.getAllByLabelText('API Key')[0], 'test-key');
    await user.clear(screen.getAllByLabelText('Model')[0]);
    await user.type(screen.getAllByLabelText('Model')[0], 'test-model');

    const expectedConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'test-model'
    };

    await user.click(screen.getByRole('button', { name: '保存 AI 接口' }));
    await waitFor(() => expect(api.saveGlobalAiProviderConfig).toHaveBeenCalledWith(expectedConfig));
    expect(await screen.findByText('AI 接口已保存。')).toBeInTheDocument();

    let resolveTestConnection: (() => void) | undefined;
    vi.mocked(api.testGlobalAiProviderConfig).mockImplementationOnce(() => new Promise((resolve) => {
      resolveTestConnection = () => resolve({ ok: true });
    }));
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    expect(screen.getByText('正在测试连接...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试中...' })).toBeDisabled();
    resolveTestConnection?.();
    await waitFor(() => expect(api.testGlobalAiProviderConfig).toHaveBeenCalledWith(expectedConfig));
    expect(await screen.findByText('连接测试成功。')).toBeInTheDocument();
  });

  it('AI 接口保存后不会被旧刷新覆盖', async () => {
    const user = userEvent.setup();
    let roomUpdate: (() => void) | undefined;
    let resolveStaleProvider: ((config: AiProviderConfig) => void) | undefined;
    const staleProviderPromise = new Promise<AiProviderConfig>((resolve) => {
      resolveStaleProvider = resolve;
    });
    const savedConfig: AiProviderConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://saved.example/v1',
      apiKey: 'saved-key',
      model: 'saved-model'
    };

    vi.mocked(api.subscribeRoom).mockImplementationOnce((_roomId, onUpdate) => {
      roomUpdate = onUpdate;
      return vi.fn();
    });
    vi.mocked(api.saveGlobalAiProviderConfig).mockResolvedValueOnce(savedConfig);

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: 'AI 接口' }));
    expect(screen.getAllByLabelText('Provider')[0]).toHaveValue('mock');
    expect(screen.getByLabelText('API Base URL')).toHaveValue('https://api.openai.com/v1');
    expect(screen.getAllByLabelText('Model')[0]).toHaveValue('gpt-4o-mini');

    vi.mocked(api.getGlobalAiProviderConfig).mockImplementationOnce(() => staleProviderPromise);
    roomUpdate?.();

    await user.selectOptions(screen.getAllByLabelText('Provider')[0], 'openai-compatible');
    await user.clear(screen.getByLabelText('API Base URL'));
    await user.type(screen.getByLabelText('API Base URL'), savedConfig.baseUrl);
    await user.type(screen.getAllByLabelText('API Key')[0], savedConfig.apiKey);
    await user.clear(screen.getAllByLabelText('Model')[0]);
    await user.type(screen.getAllByLabelText('Model')[0], savedConfig.model);
    await user.click(screen.getByRole('button', { name: '保存 AI 接口' }));

    expect(await screen.findByText('AI 接口已保存。')).toBeInTheDocument();

    resolveStaleProvider?.({
      provider: 'mock',
      baseUrl: 'https://stale.example/v1',
      apiKey: 'stale-key',
      model: 'stale-model'
    });

    await waitFor(() => expect(screen.getByLabelText('API Base URL')).toHaveValue(savedConfig.baseUrl));
    expect(screen.getAllByLabelText('Provider')[0]).toHaveValue(savedConfig.provider);
    expect(screen.getAllByLabelText('API Key')[0]).toHaveValue(savedConfig.apiKey);
    expect(screen.getAllByLabelText('Model')[0]).toHaveValue(savedConfig.model);
  });

  it('角色卡文件导入结束后清空文件输入以支持重试', async () => {
    const user = userEvent.setup();
    vi.mocked(api.importSillyTavernScriptCard).mockResolvedValueOnce({
      scriptCard: {
        id: 'script-1',
        name: '导入角色',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        visibilityNotes: '',
        sourceType: 'sillytavern_character',
        rawJson: {},
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z'
      },
      importedWorldBook: null,
      warnings: []
    });
    const onImported = vi.fn(async () => {});

    const { container } = render(<ResourceImportPanel scriptCards={[]} resourceWorldBooks={[]} presetPackages={[]} onImported={onImported} setError={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([JSON.stringify({ name: '导入角色' })], 'card.json', { type: 'application/json' });

    await user.upload(input, file);

    await waitFor(() => expect(api.importSillyTavernScriptCard).toHaveBeenCalledWith({ name: '导入角色' }));
    expect(onImported).toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('未保存的全局主剧本卡选择不会被父级旧配置刷新覆盖，保存后调用全局配置 API', async () => {
    const user = userEvent.setup();
    vi.mocked(api.putGlobalScriptCard).mockResolvedValueOnce({} as Awaited<ReturnType<typeof api.putGlobalScriptCard>>);
    const onChanged = vi.fn(async () => {});
    const scriptCards: ScriptCard[] = [
      {
        id: 'script-1',
        name: '旧剧本卡',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        visibilityNotes: '',
        sourceType: 'sillytavern_character',
        rawJson: {},
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z'
      },
      {
        id: 'script-2',
        name: '新剧本卡',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        visibilityNotes: '',
        sourceType: 'sillytavern_character',
        rawJson: {},
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z'
      }
    ];
    const props = {
      scriptCards,
      resourceWorldBooks: [],
      presetPackages: [],
      globalScriptCardId: 'script-1',
      globalWorldBookBindings: [],
      globalPresetPackageId: null,
      onChanged,
      setError: vi.fn()
    };

    const { rerender } = render(<GlobalResourceConfigPanel {...props} />);
    const scriptSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;

    await user.selectOptions(scriptSelect, 'script-2');
    rerender(<GlobalResourceConfigPanel {...props} />);

    expect(scriptSelect.value).toBe('script-2');

    await user.click(screen.getByRole('button', { name: '绑定主剧本卡' }));

    await waitFor(() => expect(api.putGlobalScriptCard).toHaveBeenCalledWith('script-2'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('保存全局世界书绑定会保留 disabled binding 并维持原 orderIndex', async () => {
    const user = userEvent.setup();
    vi.mocked(api.putGlobalResourceWorldBookBindings).mockClear();
    vi.mocked(api.putGlobalResourceWorldBookBindings).mockResolvedValueOnce({ bindings: [] });
    const onChanged = vi.fn(async () => {});
    const props = {
      scriptCards: [],
      resourceWorldBooks: [resourceWorldBook('world-1', '启用世界书'), resourceWorldBook('world-2', '停用世界书')],
      presetPackages: [],
      globalScriptCardId: null,
      globalWorldBookBindings: [globalWorldBookBinding('world-1', true, 10), globalWorldBookBinding('world-2', false, 20)],
      globalPresetPackageId: null,
      onChanged,
      setError: vi.fn()
    };

    render(<GlobalResourceConfigPanel {...props} />);

    await user.click(screen.getByRole('checkbox', { name: '启用世界书' }));
    await user.click(screen.getByRole('button', { name: '保存世界书绑定' }));

    await waitFor(() => expect(api.putGlobalResourceWorldBookBindings).toHaveBeenCalledWith([
      expect.objectContaining({ worldBookId: 'world-1', enabled: false, orderIndex: 10 }),
      expect.objectContaining({ worldBookId: 'world-2', enabled: false, orderIndex: 20 })
    ]));
    expect(onChanged).toHaveBeenCalled();
  });

  it('新增勾选的全局世界书绑定会追加到最大 orderIndex 后', async () => {
    const user = userEvent.setup();
    vi.mocked(api.putGlobalResourceWorldBookBindings).mockClear();
    vi.mocked(api.putGlobalResourceWorldBookBindings).mockResolvedValueOnce({ bindings: [] });
    const props = {
      scriptCards: [],
      resourceWorldBooks: [resourceWorldBook('world-1', '旧世界书'), resourceWorldBook('world-3', '新增世界书')],
      presetPackages: [],
      globalScriptCardId: null,
      globalWorldBookBindings: [globalWorldBookBinding('world-1', true, 5)],
      globalPresetPackageId: null,
      onChanged: vi.fn(async () => {}),
      setError: vi.fn()
    };

    render(<GlobalResourceConfigPanel {...props} />);

    await user.click(screen.getByRole('checkbox', { name: '新增世界书' }));
    await user.click(screen.getByRole('button', { name: '保存世界书绑定' }));

    await waitFor(() => expect(api.putGlobalResourceWorldBookBindings).toHaveBeenCalledWith([
      expect.objectContaining({ worldBookId: 'world-1', enabled: true, orderIndex: 5 }),
      { worldBookId: 'world-3', enabled: true, orderIndex: 6 }
    ]));
  });

  it('玩家资源面板在确认角色且有 resources 时展示', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: {
        id: 'char-1',
        playerId: 'player-1',
        sheet: {
          name: '洛林',
          species: '人类',
          className: '战士',
          level: 3,
          abilityScores: { str: 16, dex: 13, con: 15, int: 10, wis: 12, cha: 8 },
          hitPoints: { current: 28, max: 28 },
          armorClass: 18,
          proficiencyBonus: 2,
          skills: ['运动', '察觉'],
          equipment: ['长剑', '盾牌'],
          spells: [],
          privateNotes: ''
        },
        draftSource: 'ai',
        confirmed: true,
        updatedAt: '2026-05-30T00:00:00.000Z'
      },
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: [],
      resources: {
        hitPoints: { current: 28, max: 28, temp: 0 },
        hitDice: { total: 3, remaining: 3, die: 'd10' },
        spellSlots: {},
        ammo: [],
        consumables: [],
        currency: { gp: 15, sp: 3, cp: 7 },
        conditions: []
      }
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('角色资源')).toBeInTheDocument();
    expect(screen.getByText(/HP/)).toBeInTheDocument();
    expect(screen.getByText('短休')).toBeInTheDocument();
    expect(screen.getByText('长休')).toBeInTheDocument();
  });

  it('管理员台资源变更列表展示并支持回滚', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listCharacterResourceChanges).mockResolvedValueOnce({
      changes: [{
        id: 'ch-1',
        characterId: 'char-1',
        path: 'hitPoints.current',
        before: 10,
        after: 12,
        reason: '短休恢复',
        actorType: 'player',
        actorId: 'p1',
        createdAt: '2026-05-30T00:00:00.000Z',
        revertedAt: null,
        revertedBy: null
      }]
    });

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '角色资源' }));
    expect(screen.getByText('角色资源变更')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('char-1'), 'char-1');
    await user.click(screen.getByRole('button', { name: '查询变更' }));

    expect(await screen.findByText('hitPoints.current')).toBeInTheDocument();
    expect(screen.getByText(/10.*→.*12/)).toBeInTheDocument();
    expect(screen.getByText(/短休恢复/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回滚' })).toBeInTheDocument();
  });

  it('父级刷新不会覆盖未保存的全局世界书选择', async () => {
    const user = userEvent.setup();
    const props = {
      scriptCards: [],
      resourceWorldBooks: [resourceWorldBook('world-1', '旧世界书'), resourceWorldBook('world-2', '待启用世界书')],
      presetPackages: [],
      globalScriptCardId: null,
      globalWorldBookBindings: [globalWorldBookBinding('world-1', true, 1)],
      globalPresetPackageId: null,
      onChanged: vi.fn(async () => {}),
      setError: vi.fn()
    };

    const { rerender } = render(<GlobalResourceConfigPanel {...props} />);

    await user.click(screen.getByRole('checkbox', { name: '待启用世界书' }));
    rerender(<GlobalResourceConfigPanel {...props} />);

    expect(screen.getByRole('checkbox', { name: '待启用世界书' })).toBeChecked();
  });

  it('战斗面板在玩家页展示先攻顺序和骰点日志', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: null,
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: [],
      combatState: {
        id: 'combat-1',
        roomId: 'room-1',
        participants: [
          { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false },
          { id: 'c-2', name: '哥布林', hp: 7, maxHp: 7, ac: 15, initiative: 18, isNpc: true }
        ],
        currentTurnIndex: 0,
        round: 1,
        status: 'active'
      },
      recentDiceLogs: [
        { id: 'log-1', roomId: 'room-1', playerName: '洛林', die: 'd20', values: [15], modifier: 5, total: 20, reason: '攻击检定', success: true, createdAt: '2026-05-30T00:00:00.000Z' },
        { id: 'log-2', roomId: 'room-1', playerName: 'DM', die: 'd4', values: [2], modifier: 2, total: 4, reason: '匕首伤害', success: undefined, createdAt: '2026-05-30T00:01:00.000Z' }
      ]
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByRole('heading', { name: '战斗' })).toBeInTheDocument();
    expect(screen.getByText(/第 1 回合 .* 当前行动者/)).toBeInTheDocument();
    // Initiative order list (both participant names appear in combat cards)
    expect(screen.getByText(/哥布林/)).toBeInTheDocument();
    const lorinMatches = screen.getAllByText(/洛林/);
    expect(lorinMatches.length).toBeGreaterThanOrEqual(2);
    // HP bars
    expect(screen.getByText('HP: 7/7')).toBeInTheDocument();
    expect(screen.getByText('HP: 28/28')).toBeInTheDocument();
    // Dice logs
    expect(screen.getByText('最近骰点')).toBeInTheDocument();
    expect(screen.getByText(/攻击检定/)).toBeInTheDocument();
    expect(screen.getByText(/匕首伤害/)).toBeInTheDocument();
  });

  it('管理台展示骰点和战斗操作', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '检定战斗' }));

    // 骰点 子区域
    expect(screen.getByText('骰点')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '掷骰' })).toBeInTheDocument();

    // Select die type and roll
    const dieSelect = screen.getAllByLabelText('骰子类型')[0] as HTMLSelectElement;
    expect(dieSelect).toBeInTheDocument();
    await user.selectOptions(dieSelect, 'd6');
    await user.type(screen.getByLabelText('调整值'), '2');
    await user.type(screen.getByLabelText('DC'), '10');
    await user.type(screen.getByLabelText('原因'), '技能检定');
    await user.click(screen.getByRole('button', { name: '掷骰' }));

    await waitFor(() => expect(api.adminDiceRoll).toHaveBeenCalledWith('room-1', {
      die: 'd6',
      modifier: 2,
      dc: 10,
      reason: '技能检定'
    }));
    expect(await screen.findByText(/d6.*15.*\+ 3 = 18.*成功/)).toBeInTheDocument();

    // 战斗 子区域 (basic buttons always visible)
    expect(screen.getByText('战斗')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始战斗' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '掷先攻' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一回合' })).toBeInTheDocument();

    // Start combat
    const combatTextarea = screen.getByLabelText('参战者 (每行: name hp ac initMod)');
    await user.clear(combatTextarea);
    await user.type(combatTextarea, '哥布林 7 15 2');
    vi.mocked(api.startCombat).mockResolvedValueOnce({
      id: 'combat-1',
      roomId: 'room-1',
      participants: [
        { id: 'c-1', name: '哥布林', hp: 7, maxHp: 7, ac: 15, initiative: null, isNpc: true }
      ],
      currentTurnIndex: 0,
      round: 1,
      status: 'active'
    });
    await user.click(screen.getByRole('button', { name: '开始战斗' }));
    await waitFor(() => expect(api.startCombat).toHaveBeenCalled());
    expect(api.startCombat).toHaveBeenCalledWith('room-1', {
      participants: [{ name: '哥布林', hp: 7, ac: 15, initiativeModifier: 2 }]
    });

    // Attack button visible after combat starts
    expect(screen.getByRole('button', { name: '攻击' })).toBeInTheDocument();

    // Roll initiative
    await user.click(screen.getByRole('button', { name: '掷先攻' }));
    await waitFor(() => expect(api.rollCombatInitiative).toHaveBeenCalledWith('room-1', 'combat-1'));

    // Combat state display
    expect(screen.getByText(/第 1 回合 .* 当前行动者/)).toBeInTheDocument();
    expect(screen.getByText('HP: 7/7')).toBeInTheDocument();
  });

  it('管理员台战役记忆页展示战役记忆子区域', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役记忆' }));

    expect(screen.getByRole('heading', { name: '战役记忆' })).toBeInTheDocument();
    expect(screen.getByText('管理摘要、任务、NPC 与探索地点的战局记忆。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加载记忆' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成摘要' })).toBeInTheDocument();
  });

  it('管理员台加载战役记忆后展示摘要、任务、NPC、地点并支持 CRUD', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listSessionSummaries).mockResolvedValueOnce({
      summaries: [{
        id: 's-1', roomId: 'room-1', turnStart: 1, turnEnd: 5,
        summary: '队伍进入废弃矿井，击败了一群地精。',
        questUpdatesJson: '[]', npcUpdatesJson: '[]', locationUpdatesJson: '[]', characterUpdatesJson: '[]',
        createdAt: '2026-05-30T00:00:00.000Z'
      }]
    });
    vi.mocked(api.listQuests).mockResolvedValueOnce({
      quests: [{ id: 'q-1', roomId: 'room-1', title: '调查矿井', status: 'in_progress', description: '矿工被困。', updatedAt: '2026-05-30T00:00:00.000Z' }]
    });
    vi.mocked(api.listNpcs).mockResolvedValueOnce({
      npcs: [{ id: 'n-1', roomId: 'room-1', name: '格拉克', role: '地精首领', attitude: 'hostile', notes: '被击败逃跑。', location: '矿井入口', updatedAt: '2026-05-30T00:00:00.000Z' }]
    });
    vi.mocked(api.listLocations).mockResolvedValueOnce({
      locations: [{ id: 'l-1', roomId: 'room-1', name: '废弃矿井', description: '地精占据的矿井。', notes: '', updatedAt: '2026-05-30T00:00:00.000Z' }]
    });

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役记忆' }));
    await user.click(screen.getByRole('button', { name: '加载记忆' }));

    expect(await screen.findByText('队伍进入废弃矿井，击败了一群地精。')).toBeInTheDocument();
    expect(screen.getByText('调查矿井')).toBeInTheDocument();
    expect(screen.getByText(/\[in_progress\]/)).toBeInTheDocument();
    expect(screen.getByText('格拉克')).toBeInTheDocument();
    expect(screen.getByText('废弃矿井')).toBeInTheDocument();

    // CRUD: save quest
    const questTitleInput = screen.getByPlaceholderText('新任务');
    await user.type(questTitleInput, '救援矿工');
    await user.click(screen.getByRole('button', { name: '保存任务' }));
    await waitFor(() => expect(api.updateQuest).toHaveBeenCalled());

    // CRUD: save NPC
    const npcNameInput = screen.getByPlaceholderText('NPC 名称');
    await user.type(npcNameInput, '老法师');
    await user.click(screen.getByRole('button', { name: '保存 NPC' }));
    await waitFor(() => expect(api.updateNpc).toHaveBeenCalled());

    // CRUD: save location
    const locNameInput = screen.getByPlaceholderText('地点名称');
    await user.type(locNameInput, '幽暗森林');
    await user.click(screen.getByRole('button', { name: '保存地点' }));
    await waitFor(() => expect(api.updateLocation).toHaveBeenCalled());
  });

  it('玩家页展示冒险日志含最近摘要、任务和已知 NPC', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 6, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: null,
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: [],
      campaignSummary: {
        id: 's-1', roomId: 'room-1', turnStart: 1, turnEnd: 5,
        summary: '队伍击败地精，发现秘密通道。',
        questUpdatesJson: '[]', npcUpdatesJson: '[]', locationUpdatesJson: '[]', characterUpdatesJson: '[]',
        createdAt: '2026-05-30T00:00:00.000Z'
      },
      quests: [
        { id: 'q-1', roomId: 'room-1', title: '调查矿井', status: 'in_progress', description: '矿工被困在矿井深处。', updatedAt: '2026-05-30T00:00:00.000Z' }
      ],
      npcs: [
        { id: 'n-1', roomId: 'room-1', name: '格拉克', role: '地精首领', attitude: 'hostile', notes: '被击败后逃跑。', location: '矿井入口', updatedAt: '2026-05-30T00:00:00.000Z' }
      ]
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('冒险日志')).toBeInTheDocument();
    expect(screen.getByText('最近进展')).toBeInTheDocument();
    expect(screen.getByText('队伍击败地精，发现秘密通道。')).toBeInTheDocument();
    expect(screen.getByText('任务')).toBeInTheDocument();
    expect(screen.getByText('调查矿井')).toBeInTheDocument();
    expect(screen.getByText(/\[in_progress\]/)).toBeInTheDocument();
    expect(screen.getByText('已知 NPC')).toBeInTheDocument();
    expect(screen.getByText('格拉克')).toBeInTheDocument();
  });

  it('管理台检定战斗页展示快速检定按钮', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '检定战斗' }));

    expect(screen.getByText('快速检定')).toBeInTheDocument();
    expect(screen.getByText('属性检定（无熟练加值，调整值0，DC 10）：')).toBeInTheDocument();
    // Ability buttons
    expect(screen.getByRole('button', { name: 'STR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DEX' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CON' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'INT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'WIS' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CHA' })).toBeInTheDocument();
    // Social action buttons
    expect(screen.getByText('社交行动（无调整值）：')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '说服 DC15' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '欺骗 DC15' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '威吓 DC17' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '洞察 DC12' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '交易 DC15' })).toBeInTheDocument();

    // Quick roll should call adminDiceRoll
    vi.mocked(api.adminDiceRoll).mockClear();
    await user.click(screen.getByRole('button', { name: 'STR' }));
    await waitFor(() => expect(api.adminDiceRoll).toHaveBeenCalledWith('room-1', {
      die: 'd20',
      modifier: 0,
      dc: 10,
      reason: 'STR属性检定'
    }));
  });

  it('数据库标签页展示数据库管理子区域', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '数据库' }));

    expect(screen.getByRole('heading', { name: '数据库管理' })).toBeInTheDocument();
    expect(screen.getByText('从远程 URL 或 JS 代码导入结构化数据，支持增量更新检测。')).toBeInTheDocument();

    // URL import section
    expect(screen.getByRole('heading', { name: '从 URL 导入' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '从 URL 导入' })).toBeInTheDocument();

    // JS import section
    expect(screen.getByRole('heading', { name: '从 JS 代码导入' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '从 JS 代码导入' })).toBeInTheDocument();

    // Source list section
    expect(screen.getByRole('heading', { name: '已导入源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新列表' })).toBeInTheDocument();
  });
});
