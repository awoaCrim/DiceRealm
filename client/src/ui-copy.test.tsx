// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './pages/HomePage';
import { CharacterCard } from './components/CharacterCard';
import { TurnPanel } from './components/TurnPanel';
import { LogList } from './components/LogList';
import type { AdminState, AiProviderConfig, CharacterRecord, GlobalResourceWorldBookBinding, PlayerTurnSuggestion, ResourceWorldBook, ScriptCard } from './types';
import { AdminPage } from './pages/AdminPage';
import { ResourceImportPanel } from './components/ResourceImportPanel';
import { GlobalResourceConfigPanel } from './components/RoomResourceBindingsPanel';
import { PromptPreviewPanel } from './components/PromptPreviewPanel';
import { PlayerPage } from './pages/PlayerPage';
import * as api from './api';

vi.mock('./api', () => ({
  createRoom: vi.fn(),
  listRooms: vi.fn(async () => ({
    rooms: [{
      id: 'room-1',
      name: '烛堡之门',
      currentTurn: 2,
      status: 'waiting_for_actions',
      playerCount: 2,
      expectedPlayerCount: 4,
      createdAt: '2026-05-30T00:00:00.000Z',
      adminUrl: '/admin/room-1'
    }]
  })),
  deleteRoom: vi.fn(async () => ({ ok: true as const, roomId: 'room-1' })),
  adminSkipPlayerTurn: vi.fn(async () => ({ ok: true as const })),
  getAdminState: vi.fn(async (): Promise<AdminState> => ({
    room: {
      id: 'room-1',
      name: '测试房间',
      systemPrompt: '测试系统提示',
      worldInfo: '测试世界',
      currentTurn: 1,
      status: 'waiting_for_actions',
      expectedPlayerCount: 4,
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
    characters: [],
    turnReadiness: {
      turnId: 'turn-1',
      roomStatus: 'ready_to_resolve',
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
  updateRoomExpectedPlayerCount: vi.fn(async () => ({ room: null })),
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
    raw: {
      objectiveLog: 'DM objective note',
      publicLog: 'AI narration result',
      privateUpdatesByPlayer: { 'player-1': 'Private clue' },
      ruleResults: [],
      interactionRequests: [],
      diceRequests: [{ type: 'skillCheck', reason: 'attack roll' }],
      suggestedStateChanges: [{ type: 'dice_request', reason: 'attack roll' }],
      characterResourceChanges: [{
        characterId: 'char-1',
        path: 'hitPoints.current',
        before: 12,
        after: 10,
        reason: 'damage',
        ruleRefs: []
      }]
    },
    applied: false,
    warnings: ['publicLog 长度 320/300，超过上限。'],
    resolutionRunId: 'resolution-1',
    seed: 'room-1:turn-1:preview-1',
    resolutionEvents: [{
      id: 'event-1',
      roomId: 'room-1',
      turnId: 'turn-1',
      eventType: 'DICE_ROLLED',
      visibilityScope: 'public',
      playerId: null,
      actorId: 'char-1',
      payload: { total: 17, reason: 'attack roll' },
      causalityId: 'diceRequests[0]',
      createdAt: '2026-06-03T00:00:00.000Z'
    }]
  })),
  applyAiTurnPreview: vi.fn(async () => ({
    responseText: 'AI narration result',
    suggestedStateChanges: [{ type: 'dice_request', reason: 'attack roll' }],
    raw: {
      objectiveLog: 'DM objective note',
      publicLog: 'AI narration result',
      privateUpdatesByPlayer: { 'player-1': 'Private clue' },
      ruleResults: [],
      interactionRequests: [],
      diceRequests: [{ type: 'skillCheck', reason: 'attack roll' }],
      suggestedStateChanges: [{ type: 'dice_request', reason: 'attack roll' }],
      characterResourceChanges: [{
        characterId: 'char-1',
        path: 'hitPoints.current',
        before: 12,
        after: 10,
        reason: 'damage',
        ruleRefs: []
      }]
    },
    applied: true,
    warnings: ['publicLog 长度 320/300，超过上限。'],
    resolutionRunId: 'resolution-1',
    seed: 'room-1:turn-1:preview-1',
    resolutionEvents: [{
      id: 'event-1',
      roomId: 'room-1',
      turnId: 'turn-1',
      eventType: 'DICE_ROLLED',
      visibilityScope: 'public',
      playerId: null,
      actorId: 'char-1',
      payload: { total: 17, reason: 'attack roll' },
      causalityId: 'diceRequests[0]',
      createdAt: '2026-06-03T00:00:00.000Z'
    }]
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
  generatePlayerTurnSuggestions: vi.fn(async () => ({ suggestions: [], status: 'ready' as const })),
  submitAction: vi.fn(async (_token: string, _text: string, _actionType?: string, _isHiddenRoll?: boolean) => ({ ok: true })),
  respondToInteraction: vi.fn(async () => ({ ok: true })),
  subscribeRoom: vi.fn(() => () => {}),
  getCharacterBuilderOptions: vi.fn(async () => ({
    options: { species: [], subSpecies: [], classes: [], backgrounds: [], skills: [], equipment: [], spells: [], languages: [], proficiencies: [] }
  })),
  auditCharacterBuilderDraft: vi.fn(async () => ({
    draft: {
      name: '新英雄',
      concept: '',
      species: '',
      subSpecies: '',
      className: '',
      classDetail: '',
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
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false, healthLabel: 'healthy' },
      { id: 'c-2', name: '哥布林', hp: null, maxHp: null, ac: null, initiative: 18, isNpc: true, healthLabel: 'healthy' }
    ],
    currentTurnIndex: 0,
    round: 1,
    status: 'active'
  })),
  rollCombatInitiative: vi.fn(async () => ({
    id: 'combat-1',
    roomId: 'room-1',
    participants: [
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false, healthLabel: 'healthy' },
      { id: 'c-2', name: '哥布林', hp: null, maxHp: null, ac: null, initiative: 18, isNpc: true, healthLabel: 'healthy' }
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
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false, healthLabel: 'healthy' },
      { id: 'c-2', name: '哥布林', hp: null, maxHp: null, ac: null, initiative: 18, isNpc: true, healthLabel: 'healthy' }
    ],
    currentTurnIndex: 1,
    round: 2,
    status: 'active'
  })),
  getCombatState: vi.fn(async () => ({
    id: 'combat-1',
    roomId: 'room-1',
    participants: [
      { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false, healthLabel: 'healthy' },
      { id: 'c-2', name: '哥布林', hp: null, maxHp: null, ac: null, initiative: 18, isNpc: true, healthLabel: 'healthy' }
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
  listDbSources: vi.fn(async () => ({ sources: [] })),
  listDbSourceSheets: vi.fn(async () => ({ sheets: [] })),
  listRoomDbSourceBindings: vi.fn(async () => ({ bindings: [] })),
  putRoomDbSourceBindings: vi.fn(async () => ({ bindings: [] })),
  listRoomDbSheets: vi.fn(async () => ({ sheets: [] })),
  listRoomDbRows: vi.fn(async () => ({ rows: [] })),
  putRoomDbRow: vi.fn(async () => ({ row: {} })),
  checkDbSourceUpdates: vi.fn(async () => ({ hasUpdate: false })),
  updateDbSource: vi.fn(async () => ({ source: { id: 'src-1', url: '', name: 'World A', sourceType: 'world_book', version: '', fileHash: 'newhash', fileSize: 100, entryCount: 5, lastCheckedAt: '', createdAt: '' }, sourceType: 'world_book', worldBook: { name: 'World A', id: 'wb-1' }, draftsCount: 0 })),
  deleteDbSource: vi.fn(async () => ({ ok: true as const }))
}));

function confirmedCharacter(overrides: Partial<CharacterRecord> = {}): CharacterRecord {
  const base: CharacterRecord = {
    id: 'char-1',
    playerId: 'player-1',
    draftSource: 'manual',
    confirmed: true,
    updatedAt: '2026-05-30T00:00:00.000Z',
    sheet: {
      name: '洛林',
      species: '人类',
      className: '战士',
      level: 1,
      abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      hitPoints: { current: 12, max: 12 },
      armorClass: 16,
      proficiencyBonus: 2,
      skills: [],
      equipment: [],
      spells: [],
      languages: ['通用语'],
      proficiencies: ['长剑熟练'],
      privateNotes: ''
    }
  };
  return {
    ...base,
    ...overrides,
    sheet: {
      ...base.sheet,
      ...(overrides.sheet ?? {})
    }
  };
}

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

beforeEach(() => {
  vi.mocked(api.getPlayerState).mockReset();
  vi.mocked(api.getPlayerState).mockImplementation(async () => ({
    room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
    player: { id: 'player-1', name: '测试玩家' },
    character: null,
    publicLogs: [],
    privateLogs: [],
    pendingInteractions: [],
    submittedPlayers: [],
    waitingPlayers: [],
    ruleSummaries: []
  }));
  vi.mocked(api.generatePlayerTurnSuggestions).mockReset();
  vi.mocked(api.generatePlayerTurnSuggestions).mockImplementation(async () => ({ suggestions: [], status: 'ready' as const }));
  vi.mocked(api.submitAction).mockReset();
  vi.mocked(api.submitAction).mockImplementation(async () => ({ ok: true }));
  vi.mocked(api.respondToInteraction).mockReset();
  vi.mocked(api.respondToInteraction).mockImplementation(async () => ({ ok: true }));
  vi.mocked(api.subscribeRoom).mockReset();
  vi.mocked(api.subscribeRoom).mockImplementation(() => () => {});
});

describe('中文界面文案', () => {
  it('首页使用中文创建房间文案并展示已有房间', async () => {
    render(<HomePage />);

    expect(screen.getByText('创建本地多人跑团房间，并为每位玩家隔离可见信息。')).toBeInTheDocument();
    expect(screen.getByText('所有房间都会实时使用当前全局配置。')).toBeInTheDocument();
    expect(screen.getByText('房间名称')).toBeInTheDocument();
    expect(screen.getByText('预期玩家人数')).toBeInTheDocument();
    expect(screen.getByText('少于 4 名真实玩家时，系统会自动补足友好同伴 NPC。')).toBeInTheDocument();
    expect(screen.queryByText('世界信息')).not.toBeInTheDocument();
    expect(screen.queryByText('AI-DM 指令')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建房间' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '已有房间' })).toBeInTheDocument();
    expect(screen.getByText('烛堡之门')).toBeInTheDocument();
    expect(screen.getByText(/第 2 回合/)).toBeInTheDocument();
    expect(screen.getByText(/等待玩家行动/)).toBeInTheDocument();
    expect(screen.getByText(/玩家 2\/4/)).toBeInTheDocument();
    expect(screen.getByText(/创建时间 2026-05-30 00:00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '进入房间' })).toHaveAttribute('href', '/admin/room-1');
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
  });

  it('首页可以删除已有房间', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    vi.mocked(api.listRooms).mockClear();
    vi.mocked(api.listRooms)
      .mockResolvedValueOnce({
        rooms: [{
          id: 'room-1',
          name: '烛堡之门',
          currentTurn: 2,
          status: 'waiting_for_actions',
          playerCount: 2,
          expectedPlayerCount: 4,
          createdAt: '2026-05-30T00:00:00.000Z',
          adminUrl: '/admin/room-1'
        }]
      })
      .mockResolvedValueOnce({ rooms: [] });
    render(<HomePage />);

    await screen.findByText('烛堡之门');
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(api.deleteRoom).toHaveBeenCalledWith('room-1'));
    await waitFor(() => expect(api.listRooms).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('烛堡之门')).not.toBeInTheDocument();
  });

  it('公共组件使用中文空状态和回合文案', () => {
    render(
      <>
        <CharacterCard character={null} />
        <TurnPanel currentTurn={2} status="waiting_for_actions" submittedPlayers={[]} waitingPlayers={[]} />
        <TurnPanel currentTurn={3} status="open" submittedPlayers={[]} waitingPlayers={['阿瑞']} />
        <LogList title="公开日志" logs={[{
          id: 'log-short-time',
          roomId: 'room-1',
          turnId: 'turn-1',
          visibilityScope: 'public',
          playerId: null,
          title: '开场',
          content: '队伍抵达路口。镇长说：“别靠近矿道。”\n\n🎲 系统骰点：\n地精伏击射击 — 掷出 13 + 4 = 17，AC 11，命中。\n\n（观察林线 — 掷出 6 + 0 = 6，DC 15，失败。）',
          createdAt: '2026-05-30T00:00:00.000Z'
        }]} />
      </>
    );

    expect(screen.getByText('角色卡')).toBeInTheDocument();
    expect(screen.getByText('暂无角色。')).toBeInTheDocument();
    expect(screen.getByText('第 2 回合')).toBeInTheDocument();
    expect(screen.getAllByText('状态：')).toHaveLength(2);
    expect(screen.getByText('等待行动')).toBeInTheDocument();
    expect(screen.getByText('第 3 回合')).toBeInTheDocument();
    expect(screen.getByText('等待玩家行动')).toBeInTheDocument();
    expect(screen.getAllByText('请提交本回合行动；已提交后等待其他玩家。')).toHaveLength(2);
    expect(screen.getAllByText('已提交')).toHaveLength(2);
    expect(screen.getAllByText('暂无玩家提交。')).toHaveLength(2);
    expect(screen.getAllByText('等待中')).toHaveLength(2);
    expect(screen.getByText('所有玩家都已提交。')).toBeInTheDocument();
    expect(screen.getByText('开场')).toBeInTheDocument();
    expect(screen.getByText(/队伍抵达路口/)).toBeInTheDocument();
    expect(screen.getByText('“别靠近矿道。”')).toHaveClass('log-dialogue');
    const diceBlocks = document.querySelectorAll('.log-dice-block');
    expect(diceBlocks).toHaveLength(2);
    const diceBlock = diceBlocks[0];
    expect(diceBlock).toHaveTextContent('地精伏击射击');
    expect(diceBlock).not.toHaveTextContent('🎲 系统骰点');
    expect(diceBlock).toHaveTextContent('）');
    expect(screen.getByText('13 + 4 = 17')).toHaveClass('log-roll-total');
    expect(screen.getByText('AC 11')).toHaveClass('log-roll-dc');
    expect(screen.getByText('命中')).toHaveClass('log-roll-success');
    expect(screen.getByText('6 + 0 = 6')).toHaveClass('log-roll-total');
    expect(screen.getByText('DC 15')).toHaveClass('log-roll-dc');
    expect(screen.getByText('失败')).toHaveClass('log-roll-failure');
    expect(screen.getByText('2026-05-30 00:00')).toBeInTheDocument();
    expect(screen.queryByText('暂无记录。')).not.toBeInTheDocument();
  });

  it('角色卡直接展示完整人物卡内容', () => {
    render(<CharacterCard
      character={{
        id: 'char-1',
        playerId: 'player-1',
        draftSource: 'manual',
        confirmed: true,
        updatedAt: '2026-05-30T00:00:00.000Z',
        sheet: {
          name: '洛林',
          species: '人类',
          subSpecies: '变体人类',
          className: '战士',
          classDetail: '防御战斗风格',
          level: 1,
          abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
          hitPoints: { current: 12, max: 12 },
          armorClass: 16,
          proficiencyBonus: 2,
          skills: ['运动'],
          equipment: ['长剑'],
          spells: ['光亮术'],
          languages: ['通用语'],
          proficiencies: ['盾牌熟练'],
          privateNotes: '私密备注',
          background: '士兵',
          concept: '守护同伴'
        }
      }}
      resources={{
        hitPoints: { current: 10, max: 12, temp: 2 },
        hitDice: { total: 1, remaining: 1, die: 'd10' },
        spellSlots: {},
        ammo: [{ name: '弩矢', current: 20, max: 20 }],
        consumables: [{ name: '治疗包', quantity: 1 }],
        currency: { gp: 10, sp: 2, cp: 0 },
        conditions: ['倒地']
      }}
      rules={{
        ruleset: '5e-2014',
        actionEconomy: [{ title: '动作', value: '1 / 轮', detail: '攻击、施法或使用物品。' }],
        savingThrows: [
          { key: 'str', label: '力量', modifier: '+4', proficient: true },
          { key: 'dex', label: '敏捷', modifier: '+1', proficient: false }
        ],
        skills: [
          { key: 'athletics', label: '运动', ability: '力量', modifier: '+4', proficient: true },
          { key: 'perception', label: '察觉', ability: '感知', modifier: '+1', proficient: false }
        ],
        availableActions: [{
          id: 'main-hand-weapon',
          title: '主手武器攻击',
          subtitle: '长剑',
          timing: '动作',
          tags: ['攻击 +4', '伤害 1d8+2 挥砍']
        }],
        assumptions: []
      }}
    />);

    expect(screen.getByText('洛林')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看详情' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '核心资源' })).toBeInTheDocument();
    expect(screen.getAllByText('10/12').length).toBeGreaterThan(0);
    expect(screen.getByText('状态：倒地')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '豁免' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '技能检定' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '行动资源' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '语言与熟练' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '可用行动' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '最近骰点' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '装备 / 法术 / 背包' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '临场态势' })).not.toBeInTheDocument();
    expect(screen.getByText('主手武器攻击')).toBeInTheDocument();
    expect(screen.getByText('运动')).toBeInTheDocument();
    expect(screen.getByText('语言：通用语')).toBeInTheDocument();
    expect(screen.getByText('熟练：盾牌熟练')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '私密备注' })).toBeInTheDocument();
    expect(screen.getAllByText('私密备注').length).toBeGreaterThanOrEqual(2);
  });

  it('角色卡缺少资源和规则摘要时仍展示基础信息', () => {
    render(<CharacterCard character={{
      id: 'char-basic',
      playerId: 'player-1',
      draftSource: 'manual',
      confirmed: true,
      updatedAt: '2026-05-30T00:00:00.000Z',
      sheet: {
        name: '艾瑞',
        species: '精灵',
        className: '游侠',
        level: 1,
        abilityScores: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 8 },
        hitPoints: { current: 10, max: 10 },
        armorClass: 14,
        proficiencyBonus: 2,
        skills: [],
        equipment: [],
        spells: [],
        privateNotes: ''
      }
    }} />);

    expect(screen.queryByRole('button', { name: '查看详情' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '基础信息' })).toBeInTheDocument();
    expect(screen.getAllByText((_content, element) => element?.tagName === 'P' && element.textContent === '精灵 游侠 · 1 级').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10/10').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: '豁免' })).not.toBeInTheDocument();
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

    expect(screen.getByText('本轮 AI 请求预览')).toBeInTheDocument();
    expect(screen.getByText('请求摘要')).toBeInTheDocument();
    expect(screen.getByText('原生预设')).toBeInTheDocument();
    expect(screen.getByText('0 条 AI 参考资料')).toBeInTheDocument();
    expect(screen.getByText('5e 规则命中')).toBeInTheDocument();
    expect(screen.getByText('战斗 · 匹配分 1 · 命中方式：关键词')).toBeInTheDocument();
    expect(screen.queryByText(/score/)).not.toBeInTheDocument();
    expect(screen.getByText('调试详情：上下文槽位')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '战役数据库命中' })).toBeInTheDocument();
    expect(screen.getByText('调试详情：提示词块')).toBeInTheDocument();
    expect(screen.getByText('无上下文槽位。')).toBeInTheDocument();
    expect(screen.getByText('无战役数据库命中。')).toBeInTheDocument();
    expect(screen.getByText('无提示词块。')).toBeInTheDocument();
    expect(screen.queryByText('slots')).not.toBeInTheDocument();
    expect(screen.queryByText('worldBookMatches')).not.toBeInTheDocument();
    expect(screen.queryByText('promptBlocks')).not.toBeInTheDocument();
    expect(screen.getByText('攻击检定')).toBeInTheDocument();
    expect(screen.getByText('攻击时掷 d20 对抗 AC。')).toBeInTheDocument();
  });

  it('AI prompt 预览优先展示可读提示词块标题', () => {
    render(<PromptPreviewPanel preview={{
      mode: 'sillytavern-compatible',
      prompt: 'prompt',
      messages: [],
      slots: [],
      worldBookMatches: [],
      ruleMatches: [],
      promptBlocks: [{
        identifier: 'plqGRxqxkIwGvcbkiYxIi',
        displayName: '玩家自主权',
        source: 'st-preset',
        role: 'system',
        content: '绝不代替玩家做出关键决定。'
      }],
      warnings: []
    }} />);

    expect(screen.getByText('玩家自主权')).toBeInTheDocument();
    expect(screen.getByText(/ST 预设 · 系统/)).toBeInTheDocument();
    expect(screen.getByText(/ID: plqGRxqxkIwGvcbkiYxIi/)).toBeInTheDocument();
    expect(screen.queryByText(/st-preset/)).not.toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole('button', { name: '状态' }));
    expect(await screen.findByText('本轮规则摘要')).toBeInTheDocument();
    expect(screen.getByText('攻击检定')).toBeInTheDocument();
    expect(screen.getByText('攻击时掷 d20 对抗 AC。')).toBeInTheDocument();
  });

  it('玩家状态页没有临场态势和日志时仍展示概览', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 2, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: {
        id: 'char-1',
        playerId: 'player-1',
        sheet: {
          name: '洛林',
          species: '人类',
          className: '战士',
          level: 1,
          abilityScores: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
          hitPoints: { current: 12, max: 12 },
          armorClass: 16,
          proficiencyBonus: 2,
          skills: [],
          equipment: ['长剑'],
          spells: [],
          privateNotes: ''
        },
        draftSource: 'manual',
        confirmed: true,
        updatedAt: '2026-05-30T00:00:00.000Z'
      },
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: ['测试玩家'],
      ruleSummaries: [],
      resources: {
        hitPoints: { current: 12, max: 12, temp: 0 },
        hitDice: { total: 1, remaining: 1, die: 'd10' },
        spellSlots: {},
        ammo: [],
        consumables: [],
        currency: { gp: 0, sp: 0, cp: 0 },
        conditions: []
      },
      recentDiceLogs: [],
      recentChanges: []
    });

    render(<PlayerPage token="token-1" />);

  await userEvent.click(await screen.findByRole('button', { name: '状态' }));
  expect(await screen.findByRole('heading', { name: '当前状态' })).toBeInTheDocument();
  expect(screen.getAllByText('第 2 回合').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByLabelText('玩家当前状态')).toBeInTheDocument();
  expect(screen.getByLabelText('本轮概览')).toBeInTheDocument();
  expect(screen.getByText('未提交')).toBeInTheDocument();
  expect(screen.getByText('角色资源概览')).toBeInTheDocument();
    expect(screen.getByText('12/12')).toBeInTheDocument();
    expect(screen.getByText('当前没有锁定的临场态势；剧情会按场景描述和本回合行动推进。')).toBeInTheDocument();
    expect(screen.getByText('暂无骰点记录。')).toBeInTheDocument();
    expect(screen.getByText('暂无资源变动。')).toBeInTheDocument();
    expect(screen.getByText('本轮暂无规则摘要。')).toBeInTheDocument();
  });

  it('玩家页展示行动类型选择器和隐藏骰点开关', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
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
    expect(within(select).getByRole('option', { name: '临场行动' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: '战斗行动' })).not.toBeInTheDocument();
    await user.selectOptions(select, 'observe');
    expect((screen.getByLabelText('行动类型') as HTMLSelectElement).value).toBe('observe');
    expect(screen.queryByText('具体行动')).not.toBeInTheDocument();
    expect(screen.getByText('隐藏骰点（仅玩家本人可见）')).toBeInTheDocument();

    await user.selectOptions(select, 'skip');
    expect((screen.getByLabelText('行动类型') as HTMLSelectElement).value).toBe('skip');
    expect(screen.getByPlaceholderText('跳过本回合。 可补充细节。')).toBeInTheDocument();

    await user.selectOptions(select, 'player_question');
    expect((screen.getByLabelText('行动类型') as HTMLSelectElement).value).toBe('player_question');
  });

  it('玩家页加载失败时显示错误和重新加载入口', async () => {
    vi.mocked(api.getPlayerState).mockRejectedValueOnce(new Error('Not found'));

    render(<PlayerPage token="bad-token" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Not found');
    expect(screen.getByRole('heading', { name: '无法加载玩家页面' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });

  it('玩家页未确认角色时不生成建议且禁用行动提交', async () => {
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
      turnSuggestions: [],
      turnSuggestionStatus: 'missing'
    });
    vi.mocked(api.generatePlayerTurnSuggestions).mockClear();

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('确认角色后才能提交本回合行动。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交行动' })).toBeDisabled();
    expect(api.generatePlayerTurnSuggestions).not.toHaveBeenCalled();
  });

  it('玩家页在可提交回合自动生成行动建议并点击填入草稿', async () => {
    const suggestions: PlayerTurnSuggestion[] = [
      { id: 'suggestion-1', title: '观察出口', actionText: '我观察出口附近是否有埋伏。', actionType: 'observe', hint: '先确认风险。' },
      { id: 'suggestion-2', title: '说服守卫', actionText: '我尝试说服守卫放我们通过。', actionType: 'social', hint: '用礼貌语气降低敌意。' },
      { id: 'suggestion-3', title: '准备掩护', actionText: '我准备在同伴移动时提供掩护。', actionType: 'ready', hint: '等待触发时机。' },
      { id: 'suggestion-4', title: '跟随队伍', actionText: '我跟随队伍保持警戒。', actionType: 'follow', hint: '保持阵型。' }
    ];
    let resolveSuggestions: (value: { suggestions: PlayerTurnSuggestion[]; status: 'ready' }) => void = () => {};
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: [],
      turnSuggestions: [],
      turnSuggestionStatus: 'missing'
    });
    vi.mocked(api.generatePlayerTurnSuggestions).mockClear();
    vi.mocked(api.generatePlayerTurnSuggestions).mockReturnValueOnce(new Promise((resolve) => {
      resolveSuggestions = resolve;
    }));
    vi.mocked(api.submitAction).mockClear();
    const user = userEvent.setup();

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('正在生成本轮建议...')).toBeInTheDocument();
    await waitFor(() => expect(api.generatePlayerTurnSuggestions).toHaveBeenCalledWith('token-1'));

    resolveSuggestions({ suggestions, status: 'ready' });
    const suggestionGrid = await screen.findByLabelText('本轮 AI 行动建议');
    expect(within(suggestionGrid).getAllByRole('button')).toHaveLength(4);

    const persuasionSuggestion = within(suggestionGrid).getByRole('button', { name: /说服守卫/ });
    await user.click(persuasionSuggestion);

    expect(screen.getByPlaceholderText('描述你的角色本回合想尝试做什么。')).toHaveValue('我尝试说服守卫放我们通过。');
    expect(screen.getByLabelText('行动类型')).toHaveValue('social');
    expect(screen.getByLabelText('具体行动')).toHaveValue('persuade');
    expect(persuasionSuggestion).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('已套用')).toBeInTheDocument();
    expect(screen.getByText('已套用建议：说服守卫。确认内容后点击提交行动。')).toBeInTheDocument();
    expect(api.submitAction).not.toHaveBeenCalled();
  });

  it('玩家页行动建议生成失败时仍允许自由输入、重新生成并提交', async () => {
    const suggestions: PlayerTurnSuggestion[] = [
      { id: 'suggestion-1', title: '观察出口', actionText: '我观察出口附近是否有埋伏。', actionType: 'observe', hint: '先确认风险。' },
      { id: 'suggestion-2', title: '说服守卫', actionText: '我尝试说服守卫放我们通过。', actionType: 'social', hint: '用礼貌语气降低敌意。' },
      { id: 'suggestion-3', title: '准备掩护', actionText: '我准备在同伴移动时提供掩护。', actionType: 'ready', hint: '等待触发时机。' },
      { id: 'suggestion-4', title: '跟随队伍', actionText: '我跟随队伍保持警戒。', actionType: 'follow', hint: '保持阵型。' }
    ];
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: [],
      turnSuggestions: [],
      turnSuggestionStatus: 'missing'
    });
    vi.mocked(api.generatePlayerTurnSuggestions).mockClear();
    vi.mocked(api.generatePlayerTurnSuggestions)
      .mockRejectedValueOnce(new Error('AI unavailable'))
      .mockResolvedValueOnce({ suggestions, status: 'ready' });
    vi.mocked(api.submitAction).mockClear();
    const user = userEvent.setup();

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('本轮建议生成失败，可自由输入行动。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新生成建议' }));
    expect(await screen.findByLabelText('本轮 AI 行动建议')).toBeInTheDocument();
    expect(api.generatePlayerTurnSuggestions).toHaveBeenCalledTimes(2);
    await user.type(screen.getByPlaceholderText('描述你的角色本回合想尝试做什么。'), '我检查门锁。');
    await user.click(screen.getByRole('button', { name: '提交行动' }));

    await waitFor(() => expect(api.submitAction).toHaveBeenCalledWith('token-1', '我检查门锁。', 'in_character_action', false, 'public'));
  });

  it('玩家页在服务端标记跳过后清除未提交的建议草稿', async () => {
    const suggestions: PlayerTurnSuggestion[] = [
      { id: 'suggestion-1', title: '检查工具棚', actionText: '我检查工具棚附近的脚印。', actionType: 'exploration', hint: '确认线索。' },
      { id: 'suggestion-2', title: '询问镇长', actionText: '我询问镇长昨夜细节。', actionType: 'social', hint: '补齐时间线。' },
      { id: 'suggestion-3', title: '观察入口', actionText: '我观察矿道入口。', actionType: 'observe', hint: '先看风险。' },
      { id: 'suggestion-4', title: '保持警戒', actionText: '我保持警戒等待同伴。', actionType: 'wait', hint: '谨慎推进。' }
    ];
    let roomUpdate: () => void = () => {};
    vi.mocked(api.getPlayerState)
      .mockResolvedValueOnce({
        room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
        player: { id: 'player-1', name: '测试玩家' },
        character: confirmedCharacter(),
        publicLogs: [],
        privateLogs: [],
        pendingInteractions: [],
        submittedPlayers: [],
        waitingPlayers: [],
        ruleSummaries: [],
        turnSuggestions: suggestions,
        turnSuggestionStatus: 'ready'
      })
      .mockResolvedValueOnce({
        room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'ready_to_resolve' },
        player: { id: 'player-1', name: '测试玩家' },
        character: confirmedCharacter(),
        publicLogs: [],
        privateLogs: [],
        pendingInteractions: [],
        currentAction: {
          id: 'action-skip',
          roomId: 'room-1',
          turnId: 'turn-1',
          playerId: 'player-1',
          text: '测试玩家 本回合暂不主动行动。',
          submittedAt: '2026-05-30T00:00:00.000Z',
          status: 'submitted',
          actionType: 'skip',
          visibility: 'public',
          isHiddenRoll: false
        },
        submittedPlayers: ['测试玩家'],
        waitingPlayers: [],
        ruleSummaries: [],
        turnSuggestions: [],
        turnSuggestionStatus: 'missing'
      });
    vi.mocked(api.subscribeRoom).mockImplementationOnce((_roomId, onUpdate) => {
      roomUpdate = onUpdate;
      return vi.fn();
    });
    const user = userEvent.setup();

    render(<PlayerPage token="token-1" />);

    const suggestion = await screen.findByRole('button', { name: /检查工具棚/ });
    await user.click(suggestion);
    expect(screen.getByText('已套用建议：检查工具棚。确认内容后点击提交行动。')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('描述你的角色本回合想尝试做什么。')).toHaveValue('我检查工具棚附近的脚印。');
    expect(screen.getByLabelText('具体行动')).toHaveValue('track');

    roomUpdate();

    expect(await screen.findByText('测试玩家 本回合暂不主动行动。')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('已套用建议：检查工具棚。确认内容后点击提交行动。')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('行动类型')).toHaveValue('skip');
    expect(screen.getByPlaceholderText('跳过本回合。 可补充细节。')).toHaveValue('测试玩家 本回合暂不主动行动。');
    expect(screen.getByRole('button', { name: '提交行动' })).toBeDisabled();
  });

  it('玩家页可以不输入文本直接提交跳过本回合', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      submittedPlayers: [],
      waitingPlayers: [],
      ruleSummaries: []
    });
    const user = userEvent.setup();

    render(<PlayerPage token="token-1" />);

    const select = await screen.findByLabelText('行动类型');
    await user.selectOptions(select, 'skip');
    expect(screen.getByRole('button', { name: '提交行动' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '提交行动' }));

    await waitFor(() => expect(api.submitAction).toHaveBeenCalledWith('token-1', '跳过本回合。', 'skip', false, 'public'));
    expect(await screen.findByText('行动已提交，等待 DM 处理。')).toBeInTheDocument();
  });

  it('玩家页显示本回合自己的已提交行动和替换规则', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      currentAction: {
        id: 'action-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        playerId: 'player-1',
        text: '观察道路两侧的林线。',
        submittedAt: '2026-05-30T00:00:00.000Z',
        status: 'submitted',
        actionType: 'observe',
        visibility: 'public',
        isHiddenRoll: false
      },
      submittedPlayers: ['测试玩家'],
      waitingPlayers: [],
      ruleSummaries: []
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('本回合已提交')).toBeInTheDocument();
    expect(screen.getAllByText('观察道路两侧的林线。').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByPlaceholderText('描述你的角色本回合想尝试做什么。')).toHaveValue('观察道路两侧的林线。'));
    expect(screen.getByText(/观察 · 公开 · 已提交/)).toBeInTheDocument();
    expect(screen.getByText(/提交时间 2026-05-30 00:00/)).toBeInTheDocument();
    expect(screen.getByText('可在下方修改文本后再次提交，以替换本回合行动。')).toBeInTheDocument();
  });

  it('玩家页从已提交探索行动恢复具体行动', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      currentAction: {
        id: 'action-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        playerId: 'player-1',
        text: '我检查泥地里的脚印和拖痕。',
        submittedAt: '2026-05-30T00:00:00.000Z',
        status: 'submitted',
        actionType: 'exploration',
        visibility: 'public',
        isHiddenRoll: false
      },
      submittedPlayers: ['测试玩家'],
      waitingPlayers: [],
      ruleSummaries: []
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('本回合已提交')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('行动类型')).toHaveValue('exploration'));
    await waitFor(() => expect(screen.getByLabelText('具体行动')).toHaveValue('track'));
    expect(screen.getByText('预计 DC: DC 13 (感知)')).toBeInTheDocument();
  });

  it('玩家页从已提交粉末检查行动恢复为调查', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      currentAction: {
        id: 'action-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        playerId: 'player-1',
        text: '我用调查技能检查拖痕旁蓝色粉末的质地、气味，并和岩壁比对。',
        submittedAt: '2026-05-30T00:00:00.000Z',
        status: 'submitted',
        actionType: 'exploration',
        visibility: 'public',
        isHiddenRoll: false
      },
      submittedPlayers: ['测试玩家'],
      waitingPlayers: [],
      ruleSummaries: []
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('本回合已提交')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('行动类型')).toHaveValue('exploration'));
    await waitFor(() => expect(screen.getByLabelText('具体行动')).toHaveValue('investigation'));
    expect(screen.getByText('预计 DC: DC 13 (智力)')).toBeInTheDocument();
  });


  it('玩家页在回合锁定后说明已提交行动不能修改', async () => {
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'ready_to_resolve' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [],
      currentAction: {
        id: 'action-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        playerId: 'player-1',
        text: '等待队伍决定。',
        submittedAt: '2026-05-30T00:00:00.000Z',
        status: 'submitted',
        actionType: 'wait',
        visibility: 'public',
        isHiddenRoll: false
      },
      submittedPlayers: ['测试玩家'],
      waitingPlayers: [],
      ruleSummaries: []
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('等待队伍决定。')).toBeInTheDocument();
    expect(screen.getByText('当前回合已锁定，不能再修改本次行动。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交行动' })).toBeDisabled();
  });

  it('玩家页在等待互动回应时禁用新行动并允许自定义回应', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_interaction' },
      player: { id: 'player-1', name: '测试玩家' },
      character: confirmedCharacter(),
      publicLogs: [],
      privateLogs: [],
      pendingInteractions: [{
        id: 'interaction-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        sourcePlayerId: 'player-2',
        targetPlayerId: 'player-1',
        type: 'confirm',
        prompt: '你是否接受递来的绳子？',
        targetResponse: null,
        status: 'pending_target',
        createdAt: '2026-05-30T00:00:00.000Z'
      }],
      submittedPlayers: ['其他玩家'],
      waitingPlayers: [],
      ruleSummaries: []
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('等待回应')).toBeInTheDocument();
    expect(screen.getByText('请先回应下方互动请求，本回合暂不能提交新行动。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交行动' })).toBeDisabled();
    expect(screen.getByText('你是否接受递来的绳子？')).toBeInTheDocument();

    const customResponse = screen.getByLabelText('自定义回应');
    await user.type(customResponse, '我接受，但要求对方先说明计划。');
    await user.click(screen.getByRole('button', { name: '提交回应' }));

    await waitFor(() => expect(api.respondToInteraction).toHaveBeenCalledWith(
      'token-1',
      'interaction-1',
      '我接受，但要求对方先说明计划。'
    ));
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
          subSpecies: '',
          className: '',
          classDetail: '',
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
            subSpecies: '',
            className: '',
            classDetail: '',
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

  it('管理员页在房间被删除后清空旧状态并提示返回首页', async () => {
    let triggerRoomUpdate: () => void = () => {};
    vi.mocked(api.subscribeRoom).mockImplementationOnce((_roomId, onUpdate) => {
      triggerRoomUpdate = onUpdate;
      return () => {};
    });
    render(<AdminPage roomId="room-1" />);

    expect(await screen.findByText('测试房间')).toBeInTheDocument();
    vi.mocked(api.getAdminState).mockRejectedValueOnce(new Error('Room not found'));

    act(() => {
      triggerRoomUpdate();
    });

    expect(await screen.findByRole('heading', { name: '房间不可用' })).toBeInTheDocument();
    expect(screen.getByText('Room not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
    expect(screen.queryByText('测试房间')).not.toBeInTheDocument();
  });

  it('管理员页通过左侧导航展示各功能区文案', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    expect(await screen.findByRole('button', { name: '总览' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跑团' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '战役数据库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI 主持' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '玩家与角色' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI 接口' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '角色资源' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '战役记忆' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '剧本/世界书' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '数据库插件' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prompt 配置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI 约束' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '检定战斗' })).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: '开场准备' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '本轮状态' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI 与资料' })).toBeInTheDocument();
    expect(screen.getByText(/主持人控制台 · 第 1 回合 · 等待玩家行动/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'AI 输出长度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '调整 AI 输出长度' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '跑团' }));
    expect(screen.getByText('玩家')).toBeInTheDocument();
    expect(screen.getAllByText('客观剧情').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '公开剧情' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI 接口' })).toBeInTheDocument();
    expect(screen.getByText('只配置模型服务连接，不包含 prompt、规则或战役资料。')).toBeInTheDocument();
    expect(screen.getAllByText('服务类型')[0]).toBeInTheDocument();
    expect(screen.getAllByText('API 地址')[0]).toBeInTheDocument();
    expect(screen.getAllByText('API 密钥')[0]).toBeInTheDocument();
    expect(screen.getAllByText('模型')[0]).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存 AI 接口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '战役数据库' }));
    expect(screen.getByRole('heading', { name: '战役数据库' })).toBeInTheDocument();
    expect(screen.getByText('全局资源库 / 导入')).toBeInTheDocument();
    expect(screen.getByText('全局资源配置')).toBeInTheDocument();
    expect(screen.queryByText('房间资源绑定')).not.toBeInTheDocument();
    expect(screen.getByText('导入 ST 角色卡为剧本卡')).toBeInTheDocument();
    expect(screen.getByText('ST 兼容预设包')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'AI 主持' }));
    expect(screen.getByRole('heading', { name: 'AI 主持' })).toBeInTheDocument();
    expect(screen.getByText('AI 输出剧情长度')).toBeInTheDocument();
    expect(screen.getByText('客观剧情最多字数')).toBeInTheDocument();
    expect(screen.queryByText('客观剧情最少字数')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存剧情长度硬上限' })).toBeInTheDocument();
    expect(screen.getByText('默认强约束预设（当前启用）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '调试' }));
    expect(screen.getByRole('button', { name: '预览 AI 请求' })).toBeInTheDocument();
  });

  it('管理员页提示旧房间补填预期玩家人数', async () => {
    const user = userEvent.setup();
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.getAdminState).mockClear();
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      room: { ...baseState.room, expectedPlayerCount: null }
    });
    vi.mocked(api.updateRoomExpectedPlayerCount).mockClear();

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '跑团' }));
    expect(await screen.findByRole('heading', { name: '补填预期玩家人数' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '需先设置预期人数' })).toBeDisabled();
    const input = screen.getByLabelText('预期玩家人数');
    await user.clear(input);
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: '保存预期人数' }));

    await waitFor(() => expect(api.updateRoomExpectedPlayerCount).toHaveBeenCalledWith('room-1', 3));
  });

  it('管理页行动区按玩家折叠展示行动', async () => {
    const user = userEvent.setup();
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      players: [
        { id: 'player-1', roomId: 'room-1', name: '阿瑞', token: 't1', isConnected: true, createdAt: '2026-05-27T00:00:00.000Z' },
        { id: 'player-2', roomId: 'room-1', name: '波', token: 't2', isConnected: true, createdAt: '2026-05-27T00:01:00.000Z' }
      ],
      actions: [{
        id: 'action-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        playerId: 'player-1',
        text: '调查银色门缝',
        submittedAt: '2026-05-30T00:00:00.000Z',
        status: 'submitted',
        actionType: 'exploration'
      }, {
        id: 'action-2',
        roomId: 'room-1',
        turnId: 'turn-1',
        playerId: 'player-1',
        text: '再次使用侦测魔法',
        submittedAt: '2026-05-30T00:01:00.000Z',
        status: 'submitted',
        actionType: 'narrative'
      }],
      turnReadiness: {
        ...baseState.turnReadiness,
        requiredActorIds: ['player-1', 'player-2'],
        submittedActorIds: ['player-1'],
        completedActorIds: ['player-1'],
        missingActorIds: ['player-2'],
        ready: false
      }
    });

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '跑团' }));
    expect(await screen.findByText('2 条行动 · 最新：再次使用侦测魔法')).toBeInTheDocument();
    expect(screen.getByText('未提交')).toBeInTheDocument();
    expect(screen.queryByText('1 条行动 · 调查银色门缝')).not.toBeInTheDocument();
    expect(screen.getByText('行动详情：调查银色门缝')).not.toBeVisible();
    expect(screen.getByText('行动详情：再次使用侦测魔法')).not.toBeVisible();

    await user.click(screen.getByText('2 条行动 · 最新：再次使用侦测魔法'));

    expect(screen.getByText('行动详情：调查银色门缝')).toBeVisible();
    expect(screen.getByText('行动详情：再次使用侦测魔法')).toBeVisible();
    expect(screen.getByText(/探索行动 · 公开 · 已提交/)).toBeVisible();
    expect(screen.getByText(/角色行动 · 公开 · 已提交/)).toBeVisible();
    expect(screen.getByText(/提交时间 2026-05-30 00:00/)).toBeVisible();
    expect(screen.getByText(/提交时间 2026-05-30 00:01/)).toBeVisible();
  });

  it('跑团页先生成可编辑 AI 回合提示词，再发送给 AI', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createAiTurnPreview).mockClear();
    vi.mocked(api.sendAiTurnPreview).mockClear();
    vi.mocked(api.applyAiTurnPreview).mockClear();
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      players: [{ id: 'player-1', roomId: 'room-1', name: '阿瑞', token: 't1', isConnected: true, createdAt: '2026-05-27T00:00:00.000Z' }]
    });
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '跑团' }));
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
    await waitFor(() => expect(screen.getAllByText('AI narration result').length).toBeGreaterThan(0));
    expect(screen.getByText('长度警告')).toBeInTheDocument();
    expect(screen.getByText('publicLog 长度 320/300，超过上限。')).toBeInTheDocument();
    expect(screen.getByText('待确认内容')).toBeInTheDocument();
    expect(screen.getAllByText('客观剧情').length).toBeGreaterThan(0);
    expect(screen.getAllByText('公开剧情').length).toBeGreaterThan(0);
    expect(screen.getByText('私人剧情')).toBeInTheDocument();
    expect(screen.getByText('系统结算预览')).toBeInTheDocument();
    expect(screen.getByText(/Seed: room-1:turn-1:preview-1/)).toBeInTheDocument();
    expect(screen.getAllByText(/骰点/).length).toBeGreaterThan(0);
    expect(screen.getByText(/"total": 17/)).toBeInTheDocument();
    expect(screen.getByText('系统骰点请求')).toBeInTheDocument();
    expect(screen.getByText('角色资源变更')).toBeInTheDocument();
    expect(screen.getByText('原始 JSON')).toBeInTheDocument();
    expect(screen.getByText('DM objective note')).toBeInTheDocument();
    expect(screen.getAllByText('阿瑞').length).toBeGreaterThan(0);
    expect(screen.queryByText('阿瑞 (player-1)')).not.toBeInTheDocument();
    expect(screen.getByText('Private clue')).toBeInTheDocument();
    expect(screen.getAllByText(/attack roll/).length).toBeGreaterThan(0);
    expect(screen.getByText('AI 已返回，尚未写入系统。请检查下方待确认内容，最终确认后才会应用。')).toBeInTheDocument();
    const suggestedChangeCheckbox = screen.getByRole('checkbox', { name: /确认应用建议状态变更 #1/ });
    const resourceChangeCheckbox = screen.getByRole('checkbox', { name: /确认应用角色资源变更 #1/ });
    expect(suggestedChangeCheckbox).not.toBeChecked();
    expect(resourceChangeCheckbox).toBeChecked();
    await user.click(suggestedChangeCheckbox);
    await user.click(resourceChangeCheckbox);
    expect(screen.getByText(/已取消 1 条角色资源变更/)).toBeInTheDocument();
    await user.click(resourceChangeCheckbox);
    await user.click(screen.getByRole('button', { name: '最终确认并应用' }));
    await waitFor(() => expect(api.applyAiTurnPreview).toHaveBeenCalledWith('room-1', 'preview-1', {
      confirmedSuggestedStateChangeIndexes: [0],
      confirmedCharacterResourceChangeIndexes: [0]
    }));
    expect(await screen.findByText('已应用：客观剧情、公开剧情、玩家私人剧情和已确认的可应用状态已写入系统。')).toBeInTheDocument();
  });

  it('跑团页应用 AI 更改失败时提示可重新生成或重新应用', async () => {
    const user = userEvent.setup();
    vi.mocked(api.applyAiTurnPreview).mockRejectedValueOnce(new Error('状态版本冲突'));

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '跑团' }));
    await user.click(await screen.findByRole('button', { name: '生成 AI 回合提示词' }));
    await user.click(screen.getByRole('button', { name: '发送给 AI' }));
    await waitFor(() => expect(screen.getByText('AI 已返回，尚未写入系统。请检查下方待确认内容，最终确认后才会应用。')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '最终确认并应用' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('应用 AI 更改失败：状态版本冲突。可以重新生成 AI 结果，或保留当前预览后重新应用。');
    expect(screen.getByRole('button', { name: '生成 AI 回合提示词' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '最终确认并应用' })).toBeEnabled();
  });

  it('跑团页应用含互动请求的 AI 结果后不提示已推进下一回合', async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendAiTurnPreview).mockResolvedValueOnce({
      responseText: 'AI asks for consent',
      suggestedStateChanges: [],
      raw: {
        objectiveLog: '等待玩家确认。',
        publicLog: '递出绳子，等待回应。',
        privateUpdatesByPlayer: {},
        ruleResults: [],
        interactionRequests: [{
          sourcePlayerId: 'player-1',
          targetPlayerId: 'player-2',
          type: 'confirm',
          prompt: '是否接受绳子？'
        }],
        diceRequests: [],
        suggestedStateChanges: [],
        characterResourceChanges: []
      },
      applied: false,
      warnings: []
    });
    vi.mocked(api.applyAiTurnPreview).mockResolvedValueOnce({
      responseText: 'AI asks for consent',
      suggestedStateChanges: [],
      raw: {
        objectiveLog: '等待玩家确认。',
        publicLog: '递出绳子，等待回应。',
        privateUpdatesByPlayer: {},
        ruleResults: [],
        interactionRequests: [{
          sourcePlayerId: 'player-1',
          targetPlayerId: 'player-2',
          type: 'confirm',
          prompt: '是否接受绳子？'
        }],
        diceRequests: [],
        suggestedStateChanges: [],
        characterResourceChanges: []
      },
      applied: true,
      warnings: []
    });

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '跑团' }));
    await user.click(await screen.findByRole('button', { name: '生成 AI 回合提示词' }));
    await user.click(screen.getByRole('button', { name: '发送给 AI' }));
    await waitFor(() => expect(screen.getAllByText('AI asks for consent').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: '最终确认并应用' }));

    expect(await screen.findByText('已应用：客观剧情、公开剧情、玩家私人剧情和已确认的可应用状态已写入系统；当前回合正在等待玩家回应互动请求。')).toBeInTheDocument();
    expect(screen.getByText('已写入本回合客观剧情、公开剧情和私人剧情；当前回合正在等待目标玩家回应互动请求。')).toBeInTheDocument();
    expect(screen.queryByText('已写入本回合客观剧情、公开剧情、私人剧情并推进到下一回合。')).not.toBeInTheDocument();
  });

  it('跑团页在回合未就绪时禁用生成提示词并显示缺席玩家', async () => {
    const user = userEvent.setup();
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.adminSkipPlayerTurn).mockClear();
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      players: [
        { id: 'player-1', roomId: 'room-1', name: '阿瑞', token: 't1', isConnected: true, createdAt: '2026-05-27T00:00:00.000Z' },
        { id: 'player-2', roomId: 'room-1', name: '波', token: 't2', isConnected: true, createdAt: '2026-05-27T00:01:00.000Z' }
      ],
      characters: [
        confirmedCharacter({ id: 'char-1', playerId: 'player-1', confirmed: true }),
        confirmedCharacter({ id: 'char-2', playerId: 'player-2', confirmed: true })
      ],
      turnReadiness: {
        turnId: 'turn-1',
        roomStatus: 'waiting_for_actions',
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

    await user.click(await screen.findByRole('button', { name: '跑团' }));
    expect(await screen.findByText('等待玩家行动：1 / 2 已完成')).toBeInTheDocument();
    expect(screen.getByText('未提交：波')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成 AI 回合提示词' })).toBeDisabled();
    expect(screen.getByText('提示：所有必需玩家提交、跳过或被管理员排除后，才能生成提示词。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '标记 波 跳过' }));
    await waitFor(() => expect(api.adminSkipPlayerTurn).toHaveBeenCalledWith('room-1', 'player-2', '波 本回合暂不主动行动。'));
  });

  it('跑团页不显示未确认玩家的跳过按钮', async () => {
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.adminSkipPlayerTurn).mockClear();
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      players: [
        { id: 'player-1', roomId: 'room-1', name: '阿瑞', token: 't1', isConnected: true, createdAt: '2026-05-27T00:00:00.000Z' },
        { id: 'player-2', roomId: 'room-1', name: '波', token: 't2', isConnected: true, createdAt: '2026-05-27T00:01:00.000Z' }
      ],
      characters: [
        confirmedCharacter({ id: 'char-1', playerId: 'player-1', confirmed: true }),
        confirmedCharacter({ id: 'char-2', playerId: 'player-2', confirmed: false })
      ],
      turnReadiness: {
        turnId: 'turn-1',
        roomStatus: 'waiting_for_actions',
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

    await userEvent.setup().click(await screen.findByRole('button', { name: '跑团' }));
    expect(await screen.findByText('未提交：波')).toBeInTheDocument();
    expect(screen.getByText('角色未确认 · 玩家链接')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '标记 波 跳过' })).not.toBeInTheDocument();
  });

  it('跑团页在玩家都完成但状态未同步时显示具体原因', async () => {
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      turnReadiness: {
        ...baseState.turnReadiness,
        turnId: 'turn-1',
        roomStatus: 'waiting_for_actions',
        status: 'open',
        requiredActorIds: ['player-1', 'player-2'],
        submittedActorIds: ['player-1', 'player-2'],
        skippedActorIds: [],
        excludedActorIds: [],
        completedActorIds: ['player-1', 'player-2'],
        missingActorIds: [],
        ready: false
      }
    });

    render(<AdminPage roomId="room-1" />);

    await userEvent.setup().click(await screen.findByRole('button', { name: '跑团' }));
    expect(await screen.findByText('等待玩家行动：2 / 2 已完成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成 AI 回合提示词' })).toBeDisabled();
    expect(screen.getByText(/玩家行动已完成，但房间\/回合状态尚未进入“等待主持人结算”/)).toBeInTheDocument();
    expect(screen.getByText(/房间：等待玩家行动，回合：等待玩家行动/)).toBeInTheDocument();
    expect(screen.getByText(/不要让玩家重复提交行动/)).toBeInTheDocument();
  });

  it('跑团页在等待互动回应时说明下一步而不是要求玩家重交行动', async () => {
    const baseState = await api.getAdminState('room-1');
    vi.mocked(api.getAdminState).mockResolvedValueOnce({
      ...baseState,
      room: { ...baseState.room, status: 'waiting_for_interaction' },
      players: [
        { id: 'player-1', roomId: 'room-1', name: '阿瑞', token: 't1', isConnected: true, createdAt: '2026-05-27T00:00:00.000Z' },
        { id: 'player-2', roomId: 'room-1', name: '波', token: 't2', isConnected: true, createdAt: '2026-05-27T00:01:00.000Z' }
      ],
      interactions: [{
        id: 'interaction-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        sourcePlayerId: 'player-1',
        targetPlayerId: 'player-2',
        type: 'confirm',
        prompt: '是否接受递来的绳子？',
        targetResponse: null,
        status: 'pending_target',
        createdAt: '2026-05-30T00:00:00.000Z'
      }, {
        id: 'interaction-2',
        roomId: 'room-1',
        turnId: 'turn-1',
        sourcePlayerId: 'player-2',
        targetPlayerId: 'player-1',
        type: 'reply',
        prompt: '是否愿意一起行动？',
        targetResponse: '我愿意，但先保持距离。',
        status: 'ready_for_ai',
        createdAt: '2026-05-30T00:01:00.000Z'
      }],
      turnReadiness: {
        ...baseState.turnReadiness,
        turnId: 'turn-1',
        roomStatus: 'waiting_for_interaction',
        status: 'waiting_for_interaction',
        requiredActorIds: ['player-1', 'player-2'],
        submittedActorIds: ['player-1', 'player-2'],
        skippedActorIds: [],
        excludedActorIds: [],
        completedActorIds: ['player-1', 'player-2'],
        missingActorIds: [],
        ready: false
      }
    });

    render(<AdminPage roomId="room-1" />);

    await userEvent.setup().click(await screen.findByRole('button', { name: '跑团' }));
    expect(await screen.findByText('等待玩家行动：2 / 2 已完成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成 AI 回合提示词' })).toBeDisabled();
    expect(screen.getByText('提示：本回合正在等待玩家回应互动请求。目标玩家回应后，系统会回到可继续结算状态。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '互动回应' })).toBeInTheDocument();
    expect(screen.getByText('等待目标玩家回应')).toBeInTheDocument();
    expect(screen.getByText('已回应，等待主持人继续结算')).toBeInTheDocument();
    expect(screen.getByText('来源：阿瑞 · 目标：波')).toBeInTheDocument();
    expect(screen.getByText('请求：是否接受递来的绳子？')).toBeInTheDocument();
    expect(screen.getByText('回应：我愿意，但先保持距离。')).toBeInTheDocument();
    expect(screen.queryByText(/重新提交一次行动/)).not.toBeInTheDocument();
  });

  it('资源配置标签页展示资源导入与审核入口', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役数据库' }));

    expect(await screen.findByText('资源导入与审核')).toBeInTheDocument();
    expect(screen.getByText('导入 PHB、世界书或规则数据库抽取 JSON；只有批准后的草稿会进入稳定目录。')).toBeInTheDocument();
  });

  it('管理页切换标签页不会清空未保存的全局主剧本卡选择', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役数据库' }));
    const scriptCardSection = screen.getByRole('heading', { name: '主剧本卡' }).closest('.subcard') as HTMLElement;
    const scriptSelect = within(scriptCardSection).getByRole('combobox') as HTMLSelectElement;

    await user.selectOptions(scriptSelect, 'script-2');
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '战役数据库' }));

    const restoredScriptCardSection = screen.getByRole('heading', { name: '主剧本卡' }).closest('.subcard') as HTMLElement;
    expect((within(restoredScriptCardSection).getByRole('combobox') as HTMLSelectElement).value).toBe('script-2');
  });

  it('预设提示词块可以折叠展开，新增块自动展开', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await screen.findByRole('button', { name: 'AI 主持' });
    await user.click(screen.getByRole('button', { name: 'AI 主持' }));
    await user.click(screen.getByRole('button', { name: '编辑预设' }));

    expect(screen.getByRole('button', { name: /核心规则/ })).toBeInTheDocument();
    expect(screen.getByText(/世界信息前 · 系统 · 启用 · 排序 10/)).toBeInTheDocument();
    expect(screen.getByText(/最终输出前 · 系统 · 启用 · 排序 100/)).toBeInTheDocument();
    expect(screen.queryByText(/before_world/)).not.toBeInTheDocument();
    expect(screen.queryByText(/final · system/)).not.toBeInTheDocument();
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

  it('AI 主持页用中文展示旧模板类型', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getActivePresetType).mockResolvedValueOnce({ presetType: 'rules_strict' });

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: 'AI 主持' }));
    await user.click(screen.getByRole('button', { name: '调试' }));

    expect(await screen.findByText('当前激活模板类型：')).toBeInTheDocument();
    expect(screen.getByText('规则参考')).toBeInTheDocument();
    expect(screen.queryByText('rules_strict')).not.toBeInTheDocument();
  });

  it('非总览标签页操作失败时显示统一错误提示', async () => {
    const user = userEvent.setup();
    vi.mocked(api.testGlobalAiProviderConfig).mockRejectedValueOnce(new Error('连接失败'));
    vi.mocked(api.previewAiPrompt).mockRejectedValueOnce(new Error('预览失败'));
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('连接失败');

    await user.click(screen.getByRole('button', { name: 'AI 主持' }));
    await user.click(screen.getByRole('button', { name: '调试' }));
    await user.click(screen.getByRole('button', { name: '预览 AI 请求' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('预览失败');
  });

  it('AI 接口页展示 Embedding 配置和规则向量索引操作', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveGlobalEmbeddingProviderConfig).mockClear();
    vi.mocked(api.testGlobalEmbeddingProviderConfig).mockClear();
    vi.mocked(api.reindexRuleEmbeddings).mockClear();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '设置' }));

    const embeddingCard = screen.getByRole('heading', { name: 'Embedding 接口' }).closest('.subcard') as HTMLElement;
    expect(embeddingCard).toBeInTheDocument();
    expect(within(embeddingCard).getByText('服务类型')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('API 地址')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('API 密钥')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('模型')).toBeInTheDocument();
    expect(within(embeddingCard).getByText('向量维度')).toBeInTheDocument();
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

  it('设置页能保存并测试 provider 配置', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveGlobalAiProviderConfig).mockClear();
    vi.mocked(api.testGlobalAiProviderConfig).mockClear();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.selectOptions(screen.getAllByLabelText('服务类型')[0], 'openai-compatible');
    await user.clear(screen.getAllByLabelText('API 地址')[0]);
    await user.type(screen.getAllByLabelText('API 地址')[0], 'https://example.test/v1');
    await user.type(screen.getAllByLabelText('API 密钥')[0], 'test-key');
    await user.clear(screen.getAllByLabelText('模型')[0]);
    await user.type(screen.getAllByLabelText('模型')[0], 'test-model');

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

  it('设置页保存 AI 接口后不会被旧刷新覆盖', async () => {
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

    await user.click(await screen.findByRole('button', { name: '设置' }));
    expect(screen.getAllByLabelText('服务类型')[0]).toHaveValue('mock');
    expect(screen.getAllByLabelText('API 地址')[0]).toHaveValue('https://api.openai.com/v1');
    expect(screen.getAllByLabelText('模型')[0]).toHaveValue('gpt-4o-mini');

    vi.mocked(api.getGlobalAiProviderConfig).mockImplementationOnce(() => staleProviderPromise);
    roomUpdate?.();

    await user.selectOptions(screen.getAllByLabelText('服务类型')[0], 'openai-compatible');
    await user.clear(screen.getAllByLabelText('API 地址')[0]);
    await user.type(screen.getAllByLabelText('API 地址')[0], savedConfig.baseUrl);
    await user.type(screen.getAllByLabelText('API 密钥')[0], savedConfig.apiKey);
    await user.clear(screen.getAllByLabelText('模型')[0]);
    await user.type(screen.getAllByLabelText('模型')[0], savedConfig.model);
    await user.click(screen.getByRole('button', { name: '保存 AI 接口' }));

    expect(await screen.findByText('AI 接口已保存。')).toBeInTheDocument();

    resolveStaleProvider?.({
      provider: 'mock',
      baseUrl: 'https://stale.example/v1',
      apiKey: 'stale-key',
      model: 'stale-model'
    });

    await waitFor(() => expect(screen.getAllByLabelText('API 地址')[0]).toHaveValue(savedConfig.baseUrl));
    expect(screen.getAllByLabelText('服务类型')[0]).toHaveValue(savedConfig.provider);
    expect(screen.getAllByLabelText('API 密钥')[0]).toHaveValue(savedConfig.apiKey);
    expect(screen.getAllByLabelText('模型')[0]).toHaveValue(savedConfig.model);
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
    expect(screen.getByText('无警告。')).toBeInTheDocument();
    expect(screen.queryByText('无 warnings。')).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: {
        id: 'char-1',
        playerId: 'player-1',
        sheet: {
          name: '洛林',
          species: '人类',
          subSpecies: '标准人类',
          className: '战士',
          classDetail: '防御型战士',
          level: 3,
          abilityScores: { str: 16, dex: 13, con: 15, int: 10, wis: 12, cha: 8 },
          hitPoints: { current: 28, max: 28 },
          armorClass: 18,
          proficiencyBonus: 2,
          skills: ['运动', '察觉'],
          equipment: ['长剑', '盾牌'],
          spells: ['光亮术'],
          languages: ['通用语'],
          proficiencies: ['盾牌熟练'],
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
        ammo: [{ name: '弩矢', current: 20, max: 20 }],
        consumables: [{ name: '治疗包', quantity: 1 }],
        currency: { gp: 15, sp: 3, cp: 7 },
        conditions: []
      }
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByRole('button', { name: '剧情' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '人物卡' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '背包' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '状态' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '人物卡' }));

    expect(await screen.findByText((_content, element) => element?.tagName === 'P' && Boolean(element.textContent?.includes('标准人类')))).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '完整人物卡' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看详情' })).not.toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: '核心资源' })).toBeInTheDocument();
    expect(screen.getAllByText('28/28').length).toBeGreaterThan(0);
    expect(screen.queryByText('短休')).not.toBeInTheDocument();
    expect(screen.queryByText('长休')).not.toBeInTheDocument();
    const actionEconomy = screen.getByRole('heading', { name: '行动资源' }).closest('section')!;
    expect(actionEconomy).toBeInTheDocument();
    expect(within(actionEconomy).getByText('动作')).toBeInTheDocument();
    expect(within(actionEconomy).getByText('附赠动作')).toBeInTheDocument();
    expect(within(actionEconomy).getByText('反应')).toBeInTheDocument();
    expect(within(actionEconomy).getByText('移动')).toBeInTheDocument();
    expect(within(actionEconomy).getByText('30 尺 / 轮')).toBeInTheDocument();
    expect(within(actionEconomy).getByText('物品互动')).toBeInTheDocument();
    expect(within(actionEconomy).getByText('专注')).toBeInTheDocument();
    const savingThrows = screen.getByRole('heading', { name: '豁免' }).closest('section')!;
    expect(within(savingThrows).getByText('力量')).toBeInTheDocument();
    expect(within(savingThrows).getAllByText('熟练').length).toBeGreaterThanOrEqual(2);
    const skills = screen.getByRole('heading', { name: '技能检定' }).closest('section')!;
    expect(within(skills).getByText('运动')).toBeInTheDocument();
    expect(within(skills).getByText('察觉')).toBeInTheDocument();
    expect(within(skills).getByText('+5')).toBeInTheDocument();
    expect(within(skills).getByText('+3')).toBeInTheDocument();
    const languages = screen.getByRole('heading', { name: '语言与熟练' }).closest('section')!;
    expect(within(languages).getByText('语言：通用语')).toBeInTheDocument();
    expect(within(languages).getByText('熟练：盾牌熟练')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '可用行动' })).toBeInTheDocument();
    const mainAttack = screen.getByText('主手武器攻击').closest('article')!;
    expect(mainAttack).toBeInTheDocument();
    expect(within(mainAttack).getByText('长剑')).toBeInTheDocument();
    expect(within(mainAttack).getByText('攻击 +5')).toBeInTheDocument();
    expect(within(mainAttack).getByText('伤害 1d8+3 挥砍')).toBeInTheDocument();
    expect(screen.getByText('第二风')).toBeInTheDocument();
    expect(screen.getByText('动作如潮')).toBeInTheDocument();
    expect(screen.getByText('疾走')).toBeInTheDocument();
    expect(screen.getByText('闪避')).toBeInTheDocument();
    expect(screen.getByText('擒抱')).toBeInTheDocument();
    expect(screen.getByText('借机攻击')).toBeInTheDocument();
    expect(screen.queryByText('副手武器攻击')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '背包' }));

    const backpack = (await screen.findByRole('heading', { name: '背包' })).closest('section')!;
    expect(backpack).toBeInTheDocument();
    expect(within(backpack).getByText('长剑')).toBeInTheDocument();
    expect(within(backpack).getByText('盾牌')).toBeInTheDocument();
    expect(within(backpack).getByText('光亮术')).toBeInTheDocument();
    expect(within(backpack).getByText(/弩矢: 20 \/ 20/)).toBeInTheDocument();
    expect(within(backpack).getByText(/治疗包: 1/)).toBeInTheDocument();
    expect(within(backpack).getByText(/15 gp/)).toBeInTheDocument();
    expect(within(backpack).queryByRole('heading', { name: '语言与熟练' })).not.toBeInTheDocument();
  });

  it('人物卡详情展示副手攻击和法术行动', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getPlayerState).mockResolvedValueOnce({
      room: { id: 'room-1', name: '测试房间', worldInfo: '测试世界', currentTurn: 1, status: 'waiting_for_actions' },
      player: { id: 'player-1', name: '测试玩家' },
      character: {
        id: 'char-1',
        playerId: 'player-1',
        sheet: {
          name: '艾拉',
          species: '精灵',
          className: '法师',
          level: 1,
          abilityScores: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 11 },
          hitPoints: { current: 8, max: 8 },
          armorClass: 12,
          proficiencyBonus: 2,
          skills: [],
          equipment: ['匕首', '匕首', '奥术法器'],
          spells: ['光亮术', '魔法飞弹'],
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
        hitPoints: { current: 8, max: 8, temp: 0 },
        hitDice: { total: 1, remaining: 1, die: 'd6' },
        spellSlots: { level1: { total: 2, used: 1 } },
        ammo: [],
        consumables: [],
        currency: { gp: 0, sp: 0, cp: 0 },
        conditions: []
      }
    });

    render(<PlayerPage token="token-1" />);

    await user.click(await screen.findByRole('button', { name: '人物卡' }));
    expect(screen.queryByRole('button', { name: '查看详情' })).not.toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: '可用行动' })).toBeInTheDocument();
    expect(screen.getByText('主手武器攻击')).toBeInTheDocument();
    expect(screen.getByText('副手武器攻击')).toBeInTheDocument();
    expect(screen.getByText('施放法术')).toBeInTheDocument();
    expect(screen.getByText('光亮术、魔法飞弹')).toBeInTheDocument();
    expect(screen.getByText('1 环：1 / 2')).toBeInTheDocument();
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

    await user.click(await screen.findByRole('button', { name: '玩家与角色' }));

    expect(await screen.findByText('hitPoints.current')).toBeInTheDocument();
    expect(api.listCharacterResourceChanges).toHaveBeenCalledWith('room-1');
    expect(screen.queryByRole('button', { name: '查询变更' })).not.toBeInTheDocument();
    expect(screen.getByText(/10.*→.*12/)).toBeInTheDocument();
    expect(screen.getByText(/短休恢复/)).toBeInTheDocument();
    expect(screen.getByText(/玩家 · 2026-05-30 00:00/)).toBeInTheDocument();
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

  it('临场态势面板在玩家页展示顺序参考和骰点日志', async () => {
    const user = userEvent.setup();
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
          { id: 'c-1', name: '洛林', hp: 28, maxHp: 28, ac: 18, initiative: 12, isNpc: false, healthLabel: 'healthy' },
          { id: 'c-2', name: '哥布林', hp: null, maxHp: null, ac: null, initiative: 18, isNpc: true, healthLabel: 'healthy' }
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

    await user.click(await screen.findByRole('button', { name: '状态' }));

    expect(await screen.findByRole('heading', { name: '临场态势' })).toBeInTheDocument();
    expect(screen.getByText(/第 1 轮态势 .* 当前焦点/)).toBeInTheDocument();
    // Scene order list (both participant names appear in status cards)
    expect(screen.getByText(/哥布林/)).toBeInTheDocument();
    const lorinMatches = screen.getAllByText(/洛林/);
    expect(lorinMatches.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('状态：状态良好')).toBeInTheDocument();
    expect(screen.getByText('体力参考: 28/28')).toBeInTheDocument();
    // Dice logs
    expect(screen.getByText('最近骰点')).toBeInTheDocument();
    expect(screen.getByText(/攻击检定/)).toBeInTheDocument();
    expect(screen.getByText(/匕首伤害/)).toBeInTheDocument();
    expect(screen.getByText(/洛林 · 2026-05-30 00:00/)).toBeInTheDocument();
    expect(screen.getByText(/DM · 2026-05-30 00:01/)).toBeInTheDocument();
  });

  it('管理员台战役数据库页展示记忆子区域', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役数据库' }));

    expect(screen.getByRole('heading', { name: '战役数据库' })).toBeInTheDocument();
    expect(screen.getByText('统一管理结构化资料、剧本来源、战役记忆和 AI 参考规则。世界书能力会作为资料的命中/常驻规则逐步合并进这里。')).toBeInTheDocument();
    const categorySidebar = screen.getByLabelText('战役数据库分类');
    expect(within(categorySidebar).getByRole('button', { name: /全部/ })).toBeInTheDocument();
    expect(within(categorySidebar).getByRole('button', { name: /世界设定/ })).toBeInTheDocument();
    expect(within(categorySidebar).getByRole('button', { name: /NPC/ })).toBeInTheDocument();
    expect(within(categorySidebar).getByRole('button', { name: /地点/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '资料记录' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI 参考规则' })).toBeInTheDocument();
    expect(screen.getByText('世界书不再是独立入口，而是资料记录的参考方式。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加载记忆' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成摘要' })).toBeInTheDocument();
  });

  it('管理员台加载战役记忆后展示摘要、任务、NPC、地点并支持 CRUD', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listSessionSummaries).mockResolvedValueOnce({
      summaries: [{
        id: 's-1', roomId: 'room-1', turnStart: 1, turnEnd: 5,
        summary: '队伍进入废弃矿井，击败了一群地精。',
        questUpdatesJson: JSON.stringify([{ title: '救援矿工', status: 'in_progress', description: '矿工被困。' }]),
        npcUpdatesJson: JSON.stringify([{ name: '格拉克', role: '地精首领', attitude: 'hostile', notes: '被击败逃跑。', location: '矿井入口' }]),
        locationUpdatesJson: JSON.stringify([{ name: '废弃矿井', description: '地精占据的矿井。' }]),
        characterUpdatesJson: JSON.stringify([{ characterId: 'char-1', update: '受伤但仍可行动。' }]),
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

    await user.click(await screen.findByRole('button', { name: '战役数据库' }));
    await user.click(screen.getByRole('button', { name: '加载记忆' }));

    await waitFor(() => expect(screen.getAllByText('队伍进入废弃矿井，击败了一群地精。').length).toBeGreaterThan(0));
    expect(screen.getByText('回合 1-5 纪要')).toBeInTheDocument();
    expect(screen.getAllByText('关键词：调查矿井').length).toBeGreaterThan(0);
    expect(screen.getAllByText('关键词：格拉克').length).toBeGreaterThan(0);
    expect(screen.getAllByText('关键词：废弃矿井').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AI 可建议，需 DM 审核').length).toBeGreaterThan(0);
    const npcRecord = screen.getAllByText('格拉克')
      .map((element) => element.closest('.campaign-db-record'))
      .find(Boolean) as HTMLElement;
    expect(npcRecord).toBeInTheDocument();
    await user.click(within(npcRecord).getByRole('button', { name: '查看资料' }));
    expect(screen.getByText('当前选中')).toBeInTheDocument();
    expect(screen.getByText('NPC 档案')).toBeInTheDocument();
    expect(screen.getByText('战役资料维护 / NPC')).toBeInTheDocument();
    expect(screen.getByText('NPC 资料会在剧情提到姓名时进入 AI 参考。身份、态度、位置和备注应在 NPC 维护区更新。')).toBeInTheDocument();
    expect(screen.getByText('摘要建议（不会自动写入长期记忆）')).toBeInTheDocument();
    expect(screen.getByText('任务建议')).toBeInTheDocument();
    expect(screen.getByText('NPC 建议')).toBeInTheDocument();
    expect(screen.getByText('地点建议')).toBeInTheDocument();
    expect(screen.getByText('角色建议')).toBeInTheDocument();
    expect(screen.getByText(/救援矿工/)).toBeInTheDocument();
    expect(screen.getAllByText('调查矿井').length).toBeGreaterThan(0);
    expect(screen.getByText(/\[进行中\]/)).toBeInTheDocument();
    expect(screen.getAllByText('格拉克').length).toBeGreaterThan(0);
    expect(screen.getByText(/地精首领，敌对/)).toBeInTheDocument();
    expect(screen.getAllByText('废弃矿井').length).toBeGreaterThan(0);

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

  it('管理员台可在战役数据库详情中直接编辑 NPC 资料', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateNpc).mockClear();
    vi.mocked(api.listSessionSummaries).mockResolvedValueOnce({ summaries: [] });
    vi.mocked(api.listQuests).mockResolvedValueOnce({ quests: [] });
    vi.mocked(api.listNpcs).mockResolvedValueOnce({
      npcs: [{ id: 'n-1', roomId: 'room-1', name: '格拉克', role: '地精首领', attitude: 'hostile', notes: '被击败逃跑。', location: '矿井入口', updatedAt: '2026-05-30T00:00:00.000Z' }]
    });
    vi.mocked(api.listLocations).mockResolvedValueOnce({ locations: [] });

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役数据库' }));
    await user.click(screen.getByRole('button', { name: '加载记忆' }));

    const npcRecord = (await screen.findAllByText('格拉克'))
      .map((element) => element.closest('.campaign-db-record'))
      .find(Boolean) as HTMLElement;
    const recordCard = npcRecord;
    await user.click(within(recordCard).getByRole('button', { name: '查看资料' }));

    const npcEditor = screen.getByLabelText('编辑 NPC 资料');
    expect(within(npcEditor).getByLabelText('NPC 名称')).toHaveValue('格拉克');
    expect(within(npcEditor).getByLabelText('NPC 身份')).toHaveValue('地精首领');
    await user.clear(within(npcEditor).getByLabelText('NPC 备注'));
    await user.type(within(npcEditor).getByLabelText('NPC 备注'), '暂时愿意谈判。');
    await user.click(within(npcEditor).getByRole('button', { name: '保存当前 NPC' }));

    await waitFor(() => expect(api.updateNpc).toHaveBeenCalledWith('room-1', {
      name: '格拉克',
      role: '地精首领',
      attitude: 'hostile',
      notes: '暂时愿意谈判。',
      location: '矿井入口'
    }));
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
        { id: 'n-1', roomId: 'room-1', name: '格拉克', role: '地精首领', attitude: 'hostile', location: '矿井入口', updatedAt: '2026-05-30T00:00:00.000Z' }
      ]
    });

    render(<PlayerPage token="token-1" />);

    expect(await screen.findByText('冒险日志')).toBeInTheDocument();
    expect(screen.getByText('最近进展')).toBeInTheDocument();
    expect(screen.getByText('队伍击败地精，发现秘密通道。')).toBeInTheDocument();
    expect(screen.getByText('任务')).toBeInTheDocument();
    expect(screen.getByText('调查矿井')).toBeInTheDocument();
    expect(screen.getByText(/\[进行中\]/)).toBeInTheDocument();
    expect(screen.getByText('已知 NPC')).toBeInTheDocument();
    expect(screen.getByText('格拉克')).toBeInTheDocument();
    expect(screen.getByText(/地精首领，敌对/)).toBeInTheDocument();
    expect(screen.getByText('矿井入口')).toBeInTheDocument();
  });

  it('战役数据库页展示数据源管理子区域', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDbSources).mockResolvedValueOnce({
      sources: [{
        id: 'src-table',
        url: 'https://example.test/table.js',
        name: '怪物状态表',
        sourceType: 'table_plugin',
        version: 'v1',
        fileHash: 'abcdef1234567890',
        fileSize: 2048,
        entryCount: 3,
        lastCheckedAt: '2026-05-30T00:00:00.000Z',
        createdAt: '2026-05-30T00:00:00.000Z'
      }]
    });
    vi.mocked(api.listDbSourceSheets).mockResolvedValueOnce({ sheets: [] });
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役数据库' }));

    expect(screen.getByRole('heading', { name: '数据源' })).toBeInTheDocument();
    expect(screen.getByText('数据库插件是战役数据库的外部资料来源。它提供结构化表数据；是否进入 AI 上下文由资料的 AI 参考规则决定。')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '从 URL 接入' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '从 URL 接入' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '从 JS 代码接入' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '从 JS 代码接入' })).not.toBeInTheDocument();

    // Source list section
    expect(screen.getByRole('heading', { name: '已接入数据源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新列表' })).toBeInTheDocument();
    expect(await screen.findByText('怪物状态表')).toBeInTheDocument();
    expect(screen.getByText(/类型：表格数据库插件/)).toBeInTheDocument();
    expect(screen.getByText(/表数量：3/)).toBeInTheDocument();
    expect(screen.getByText(/大小：2.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/上次检查：2026-05-30 00:00/)).toBeInTheDocument();
    expect(screen.queryByText(/table_plugin/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2048 bytes/)).not.toBeInTheDocument();
  });

  it('管理员台可在战役数据库详情中直接编辑数据源行', async () => {
    const user = userEvent.setup();
    vi.mocked(api.putRoomDbRow).mockClear();
    vi.mocked(api.listDbSources).mockResolvedValueOnce({
      sources: [{
        id: 'src-table',
        url: 'https://example.test/table.js',
        name: '怪物状态表',
        sourceType: 'table_plugin',
        version: 'v1',
        fileHash: 'abcdef1234567890',
        fileSize: 2048,
        entryCount: 1,
        lastCheckedAt: '2026-05-30T00:00:00.000Z',
        createdAt: '2026-05-30T00:00:00.000Z'
      }]
    });
    vi.mocked(api.listDbSourceSheets).mockResolvedValueOnce({
      sheets: [{
        id: 'sheet-monsters',
        sourceId: 'src-table',
        uid: 'monsters',
        name: '怪物状态表',
        tableName: 'campaign_monsters',
        note: '记录本房间已出现怪物。',
        initNode: '',
        updateNode: '按剧情更新',
        insertNode: '新增怪物',
        deleteNode: '',
        ddl: '',
        exportEnabled: true,
        orderIndex: 0,
        rawJson: {},
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z'
      }]
    });
    vi.mocked(api.listRoomDbSourceBindings).mockResolvedValueOnce({ bindings: [] });
    vi.mocked(api.listRoomDbSheets).mockResolvedValueOnce({
      sheets: [{
        id: 'sheet-monsters',
        sourceId: 'src-table',
        uid: 'monsters',
        name: '怪物状态表',
        tableName: 'campaign_monsters',
        note: '记录本房间已出现怪物。',
        initNode: '',
        updateNode: '按剧情更新',
        insertNode: '新增怪物',
        deleteNode: '',
        ddl: '',
        exportEnabled: true,
        orderIndex: 0,
        rawJson: {},
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z'
      }]
    });
    vi.mocked(api.listRoomDbRows).mockResolvedValueOnce({
      rows: [{
        id: 'row-1',
        roomId: 'room-1',
        sheetId: 'sheet-monsters',
        rowKey: 'goblin-1',
        data: { name: '哥布林', hp: 7 },
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z'
      }]
    });

    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: '战役数据库' }));
    const sourceRecord = (await screen.findAllByText('怪物状态表'))
      .map((element) => element.closest('.campaign-db-record'))
      .find(Boolean) as HTMLElement;
    await user.click(within(sourceRecord).getByRole('button', { name: '查看资料' }));

    const sourceEditor = screen.getByLabelText('编辑数据源资料');
    expect(within(sourceEditor).getByText('campaign_monsters · 1 行')).toBeInTheDocument();
    await user.click(within(sourceEditor).getByRole('button', { name: 'goblin-1' }));
    expect(within(sourceEditor).getByLabelText('行 Key')).toHaveValue('goblin-1');
    expect(within(sourceEditor).getByLabelText('行数据 JSON')).toHaveValue(JSON.stringify({ name: '哥布林', hp: 7 }, null, 2));
    await user.click(within(sourceEditor).getByRole('button', { name: '保存当前数据行' }));

    await waitFor(() => expect(api.putRoomDbRow).toHaveBeenCalledWith('room-1', 'sheet-monsters', 'goblin-1', { name: '哥布林', hp: 7 }));
  });
});
