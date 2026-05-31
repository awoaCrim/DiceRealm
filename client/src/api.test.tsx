import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearGlobalPresetPackage,
  clearGlobalScriptCard,
  confirmCharacterBuilderDraft,
  createAiTurnPreview,
  createRoom,
  createWorldBook,
  createWorldBookEntry,
  deleteRoom,
  deletePresetPackage,
  deleteResourceWorldBook,
  deleteScriptCard,
  getCharacterBuilderOptions,
  getGlobalConfig,
  getGlobalAiProviderConfig,
  getGlobalEmbeddingProviderConfig,
  getPresetPackage,
  getResourceWorldBook,
  getResourceWorldBookEntries,
  getScriptCard,
  createResourceImportJob,
  getApprovedCatalogs,
  importSillyTavernPresetPackage,
  importSillyTavernScriptCard,
  importSillyTavernWorldBook,
  listResourceImportDrafts,
  listPresetPackages,
  listResourceWorldBooks,
  listRooms,
  listScriptCards,
  previewAiPrompt,
  putGlobalPresetPackage,
  putGlobalResourceWorldBookBindings,
  putGlobalScriptCard,
  reviewResourceImportDraft,
  activatePreset,
  applyAiTurnPreview,
  auditCharacterBuilderDraft,
  reindexRuleEmbeddings,
  saveCharacterBuilderDraft,
  saveGlobalAiProviderConfig,
  saveGlobalEmbeddingProviderConfig,
  savePreset,
  sendAiTurnPreview,
  testGlobalAiProviderConfig,
  testGlobalEmbeddingProviderConfig,
  previewRuleRetrieval,
  listSessionSummaries,
  triggerSessionSummary,
  listQuests,
  updateQuest,
  listNpcs,
  updateNpc,
  listLocations,
  updateLocation
} from './api';
import type { AiProviderConfig, EmbeddingProviderConfig, PromptPreviewResponse } from './types';

function mockFetchJson(value: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => value,
    text: async () => JSON.stringify(value)
  }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resource API helpers', () => {
  it('requests script card resource endpoints with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ scriptCards: [] });

    await listScriptCards();
    await importSillyTavernScriptCard({ name: 'Alice' });
    await getScriptCard('script-1');
    await deleteScriptCard('script-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/resources/script-cards', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/resources/script-cards/import/sillytavern', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ characterCard: { name: 'Alice' } })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/resources/script-cards/script-1', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/resources/script-cards/script-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('requests world book resource endpoints with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ worldBooks: [], entries: [] });

    await listResourceWorldBooks();
    await importSillyTavernWorldBook({ entries: {} }, 'Lore');
    await getResourceWorldBook('world-1');
    await getResourceWorldBookEntries('world-1');
    await deleteResourceWorldBook('world-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/resources/world-books', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/resources/world-books/import/sillytavern', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ worldBook: { entries: {} }, fallbackName: 'Lore' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/resources/world-books/world-1', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/resources/world-books/world-1/entries', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/resources/world-books/world-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('requests preset package resource endpoints with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ presetPackages: [] });
    const input = { openAiSettings: { temperature: 0.7 }, contextTemplate: { story: true } };

    await listPresetPackages();
    await importSillyTavernPresetPackage(input);
    await getPresetPackage('preset-1');
    await deletePresetPackage('preset-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/resources/preset-packages', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/resources/preset-packages/import/sillytavern', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(input)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/resources/preset-packages/preset-1', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/resources/preset-packages/preset-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('requests global config and AI provider endpoints with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ aiProviderConfig: {}, bindings: [] });
    const providerConfig: AiProviderConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'test-model'
    };
    const bindings = [{ worldBookId: 'world-1', enabled: true, orderIndex: 0 }];

    await getGlobalConfig();
    await getGlobalAiProviderConfig();
    await saveGlobalAiProviderConfig(providerConfig);
    await testGlobalAiProviderConfig(providerConfig);
    await testGlobalAiProviderConfig();
    await putGlobalScriptCard('script-1');
    await clearGlobalScriptCard();
    await putGlobalResourceWorldBookBindings(bindings);
    await putGlobalPresetPackage('preset-1');
    await clearGlobalPresetPackage();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/config', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/config/ai-provider', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/config/ai-provider', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(providerConfig)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/config/ai-provider/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(providerConfig)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/config/ai-provider/test', expect.objectContaining({
      method: 'POST'
    }));
    expect((fetchMock.mock.calls[4] as unknown[])[1]).not.toHaveProperty('body');
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/api/admin/config/script-card', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ scriptCardId: 'script-1' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/api/admin/config/script-card', expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, '/api/admin/config/resource-world-books', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ bindings })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(9, '/api/admin/config/preset-package', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ presetPackageId: 'preset-1' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(10, '/api/admin/config/preset-package', expect.objectContaining({ method: 'DELETE' }));
  });

  it('saves, tests, indexes, and previews embedding rule retrieval APIs', async () => {
    const providerConfig: EmbeddingProviderConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://embedding.test/v1',
      apiKey: 'embedding-key',
      model: 'embedding-model',
      dimensions: 1536
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => providerConfig,
        text: async () => JSON.stringify(providerConfig)
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => providerConfig,
        text: async () => JSON.stringify(providerConfig)
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ indexed: 1, skipped: 0 }),
        text: async () => JSON.stringify({ indexed: 1, skipped: 0 })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ matches: [{ entryId: 'rule-1', title: '攻击检定' }] }),
        text: async () => JSON.stringify({ matches: [{ entryId: 'rule-1', title: '攻击检定' }] })
      } as Response);

    await getGlobalEmbeddingProviderConfig();
    await saveGlobalEmbeddingProviderConfig(providerConfig);
    await testGlobalEmbeddingProviderConfig(providerConfig);
    await reindexRuleEmbeddings();
    await previewRuleRetrieval('攻击 AC');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/config/embedding-provider', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('method');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/config/embedding-provider', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(providerConfig)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/config/embedding-provider/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(providerConfig)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/rules/embeddings/reindex', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/rules/retrieval-preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ query: '攻击 AC', limit: 5 })
    }));
  });

  it('requests global preset and world book helpers with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ preset: {}, presets: [], worldBook: {}, worldBooks: [], entry: {}, entries: [] });
    const preset = {
      name: '全局预设',
      description: '测试预设',
      isActive: true,
      blocks: [{ name: '核心规则', role: 'system' as const, position: 'before_world' as const, enabled: true, orderIndex: 10, content: '核心内容' }]
    };
    const existingPreset = { ...preset, id: 'preset-1' };
    const worldBook = { name: '全局世界书', description: '世界书描述', enabled: true };
    const entry = {
      title: '条目',
      keys: ['关键词'],
      secondaryKeys: [],
      content: '条目内容',
      enabled: true,
      constant: false,
      selective: false,
      priority: 100,
      position: 'after_world' as const
    };

    await savePreset(preset);
    await savePreset(existingPreset);
    await activatePreset('preset-1');
    await createWorldBook(worldBook);
    await createWorldBookEntry('world-1', entry);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/config/presets', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(preset)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/config/presets/preset-1', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(existingPreset)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/config/presets/preset-1/activate', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/config/world-books', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(worldBook)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/config/world-books/world-1/entries', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(entry)
    }));
  });

  it('requests preset template APIs with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ templates: [], preset: {}, presets: [], presetType: null });

    const { listPresetTemplates, applyPresetTemplate, getActivePresetType } = await import('./api');

    await listPresetTemplates();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/preset-templates', expect.objectContaining({ headers: expect.any(Object) }));

    await applyPresetTemplate('tutorial');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/preset-templates/tutorial/apply', expect.objectContaining({ method: 'POST' }));

    await getActivePresetType();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/active-preset-type', expect.objectContaining({ headers: expect.any(Object) }));
  });

  it('creates rooms with only a name because configuration is global', async () => {
    const fetchMock = mockFetchJson({ roomId: 'room-1', adminUrl: '/admin/room-1' });

    const createInput = { name: '全局配置房间', worldInfo: '不应发送', systemPrompt: '不应发送' } as { name: string };

    await createRoom(createInput);

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/rooms', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: '全局配置房间' })
    }));
  });

  it('lists and deletes rooms through admin APIs', async () => {
    const fetchMock = mockFetchJson({ rooms: [] });

    await listRooms();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/rooms', expect.objectContaining({ headers: expect.any(Object) }));

    await deleteRoom('room-1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/rooms/room-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('imports and reviews PHB extraction drafts through admin resource APIs', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ job: { id: 'job-1' }, drafts: [] }),
        text: async () => JSON.stringify({ job: { id: 'job-1' }, drafts: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ drafts: [{ id: 'draft-1', status: 'pending' }] }),
        text: async () => JSON.stringify({ drafts: [{ id: 'draft-1', status: 'pending' }] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ draft: { id: 'draft-1', status: 'approved' } }),
        text: async () => JSON.stringify({ draft: { id: 'draft-1', status: 'approved' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ruleEntries: [], characterOptions: [], resourceRules: [] }),
        text: async () => JSON.stringify({ ruleEntries: [], characterOptions: [], resourceRules: [] })
      } as Response);

    await createResourceImportJob({ name: 'PHB', sourceType: 'phb_extraction', sourceFileName: 'phb.pdf', drafts: [{ kind: 'rule_entry', title: '检定', summary: '摘要' }] });
    await listResourceImportDrafts({ status: 'pending' });
    await reviewResourceImportDraft('draft-1', { status: 'approved' });
    await getApprovedCatalogs();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/resources/import-jobs', expect.objectContaining({
      method: 'POST'
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/resources/import-drafts?status=pending', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/resources/import-drafts/draft-1/review', expect.objectContaining({
      method: 'PUT'
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/resources/approved-catalogs', expect.objectContaining({ headers: expect.any(Object) }));
  });

  it('returns structured prompt preview responses', async () => {
    const response: PromptPreviewResponse = {
      mode: 'sillytavern-compatible',
      prompt: 'system prompt',
      messages: [{ role: 'system', content: 'system prompt' }],
      slots: [{ key: 'char', source: 'script-card', content: 'Alice' }],
      worldBookMatches: [{
        worldBookId: 'world-1',
        entryId: 'entry-1',
        keys: ['dragon'],
        reason: 'primary-key',
        position: 'before',
        content: 'Dragon lore'
      }],
      ruleMatches: [],
      promptBlocks: [{ identifier: 'main', source: 'st-preset', role: 'system', content: 'system prompt' }],
      warnings: []
    };
    mockFetchJson(response);

    const result = await previewAiPrompt('room-1');

    expect(result).toEqual(response);
    expect(result.messages[0].role).toBe('system');
    expect(result.worldBookMatches[0].position).toBe('before');
  });

  it('calls AI turn preview and send-preview APIs', async () => {
    const previewResponse = {
      previewId: 'preview-1',
      roomId: 'room-1',
      turnId: 'turn-1',
      flatPrompt: 'editable prompt',
      messages: [{ role: 'user', content: 'editable prompt' }],
      contextSections: [{ title: 'Character Status', content: 'Fighter HP 12/12' }],
      warnings: []
    };
    const sendResponse = {
      responseText: 'AI narration',
      suggestedStateChanges: [{ type: 'dice_request', reason: 'attack' }],
      raw: { publicLog: 'AI narration', privateUpdatesByPlayer: {}, ruleResults: [], interactionRequests: [] },
      applied: false,
      warnings: ['publicLog 长度 320/300，超过上限。']
    };
    const applyResponse = { ...sendResponse, applied: true };
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => previewResponse,
        text: async () => JSON.stringify(previewResponse)
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sendResponse,
        text: async () => JSON.stringify(sendResponse)
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => applyResponse,
        text: async () => JSON.stringify(applyResponse)
      } as Response);

    await expect(createAiTurnPreview('room-1')).resolves.toEqual(previewResponse);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/ai/turn-preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ roomId: 'room-1' })
    }));

    await expect(sendAiTurnPreview('room-1', 'preview-1', 'edited prompt')).resolves.toEqual(sendResponse);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/ai/send-preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ roomId: 'room-1', previewId: 'preview-1', flatPrompt: 'edited prompt' })
    }));
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 120000);
    await expect(applyAiTurnPreview('room-1', 'preview-1', {
      confirmedSuggestedStateChangeIndexes: [0],
      confirmedCharacterResourceChangeIndexes: [1]
    })).resolves.toEqual(applyResponse);
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/ai/apply-preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        roomId: 'room-1',
        previewId: 'preview-1',
        confirmedSuggestedStateChangeIndexes: [0],
        confirmedCharacterResourceChangeIndexes: [1]
      })
    }));
    timeoutSpy.mockRestore();
  });

  it('calls character resource rest and audit APIs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ resources: { hitPoints: { current: 12, max: 12, temp: 0 } } }),
        text: async () => JSON.stringify({ resources: { hitPoints: { current: 12, max: 12, temp: 0 } } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ changes: [{ id: 'ch-1', path: 'hitPoints.current', before: 10, after: 12, reason: 'short rest', actorType: 'player', actorId: 'p1', revertedAt: null, createdAt: '2026-05-30T00:00:00.000Z' }] }),
        text: async () => JSON.stringify({ changes: [{ id: 'ch-1', path: 'hitPoints.current' }] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ change: { id: 'ch-1', revertedAt: '2026-05-30T01:00:00.000Z' } }),
        text: async () => JSON.stringify({ change: { id: 'ch-1', revertedAt: '2026-05-30T01:00:00.000Z' } })
      } as Response);

    const { restCharacter, listCharacterResourceChanges, rollbackCharacterResourceChange } = await import('./api');

    const restResult = await restCharacter('room-1', 'char-1', { action: 'short', actorType: 'player', actorId: 'p1', hitDiceSpent: 1 });
    expect(restResult).toEqual({ resources: { hitPoints: { current: 12, max: 12, temp: 0 } } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/rooms/room-1/characters/char-1/rest', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'short', actorType: 'player', actorId: 'p1', hitDiceSpent: 1 })
    }));

    const changeList = await listCharacterResourceChanges('room-1', { characterId: 'char-1' });
    expect(changeList).toEqual({ changes: [{ id: 'ch-1', path: 'hitPoints.current', before: 10, after: 12, reason: 'short rest', actorType: 'player', actorId: 'p1', revertedAt: null, createdAt: '2026-05-30T00:00:00.000Z' }] });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/rooms/room-1/character-resource-changes?characterId=char-1', expect.objectContaining({
      headers: expect.any(Object)
    }));

    const rollbackResult = await rollbackCharacterResourceChange('room-1', 'ch-1', 'admin-1');
    expect(rollbackResult).toEqual({ change: { id: 'ch-1', revertedAt: '2026-05-30T01:00:00.000Z' } });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/rooms/room-1/character-resource-changes/ch-1/rollback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ adminId: 'admin-1' })
    }));

    fetchMock.mockRestore();
  });

  it('calls admin dice and combat APIs', async () => {
    const combatState = {
      id: 'combat-1',
      roomId: 'room-1',
      round: 1,
      currentTurn: 0,
      combatants: [{
        id: 'combatant-1',
        characterId: null,
        npcId: 'npc-1',
        name: '哥布林',
        initiative: 18,
        hp: { current: 7, max: 7 },
        ac: 15,
        isPlayer: false,
        conditions: []
      }],
      status: 'active',
      startedAt: '2026-05-30T00:00:00.000Z'
    };
    const nextCombatState = {
      ...combatState,
      round: 2,
      combatants: [{ ...combatState.combatants[0], hp: { current: 4, max: 7 } }]
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ values: [15], modifier: 3, total: 18, success: true, diceLog: { id: 'dice-1' } }),
        text: async () => JSON.stringify({ values: [15], modifier: 3, total: 18, success: true, diceLog: { id: 'dice-1' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ combatState }),
        text: async () => JSON.stringify({ combatState })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ combatState }),
        text: async () => JSON.stringify({ combatState })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ combatState: nextCombatState, hit: true, criticalHit: false, criticalMiss: false, attackRoll: 12, attackTotal: 17, damageTotal: 8 }),
        text: async () => JSON.stringify({ combatState: nextCombatState, hit: true, criticalHit: false, criticalMiss: false, attackRoll: 12, attackTotal: 17, damageTotal: 8 })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ combatState: nextCombatState }),
        text: async () => JSON.stringify({ combatState: nextCombatState })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ combatState }),
        text: async () => JSON.stringify({ combatState })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ logs: [{ id: 'log-1', roomId: 'room-1', turnId: null, combatId: 'combat-1', characterId: null, diceType: 'd20', values: [15], modifier: 3, total: 18, dc: 15, reason: '攻击检定', success: true, isPublic: true, createdAt: '2026-05-30T00:00:00.000Z' }] }),
        text: async () => JSON.stringify({ logs: [{ id: 'log-1', roomId: 'room-1', turnId: null, combatId: 'combat-1', characterId: null, diceType: 'd20', values: [15], modifier: 3, total: 18, dc: 15, reason: '攻击检定', success: true, isPublic: true, createdAt: '2026-05-30T00:00:00.000Z' }] })
      } as Response);

    const { adminDiceRoll, startCombat, rollCombatInitiative, combatAttack, combatNextTurn, getCombatState, getDiceLogs } = await import('./api');

    const diceInput = { diceType: 'd20', modifier: 3, dc: 15, reason: '攻击检定' };
    const diceResult = await adminDiceRoll('room-1', diceInput);
    expect(diceResult).toEqual({ values: [15], modifier: 3, total: 18, success: true, diceLog: { id: 'dice-1' } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/rooms/room-1/dice/roll', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(diceInput)
    }));

    const combatInput = { combatants: [{ name: '哥布林', hp: 7, ac: 15, dexMod: 2 }] };
    const started = await startCombat('room-1', combatInput);
    expect(started.combatState).toEqual(combatState);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/rooms/room-1/combat/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(combatInput)
    }));

    const initiativeState = await rollCombatInitiative('room-1', 'combat-1');
    expect(initiativeState.combatState.combatants[0].initiative).toBe(18);
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/rooms/room-1/combat/roll-initiative', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ combatId: 'combat-1' })
    }));

    const attackInput = { combatId: 'combat-1', attackerIndex: 0, targetIndex: 0, weaponDie: 'd8' };
    const attackResult = await combatAttack('room-1', attackInput);
    expect(attackResult).toEqual({ combatState: nextCombatState, hit: true, criticalHit: false, criticalMiss: false, attackRoll: 12, attackTotal: 17, damageTotal: 8 });
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/rooms/room-1/combat/attack', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(attackInput)
    }));

    const nextTurnState = await combatNextTurn('room-1', 'combat-1');
    expect(nextTurnState.combatState.round).toBe(2);
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/rooms/room-1/combat/next-turn', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ combatId: 'combat-1' })
    }));

    const getState = await getCombatState('room-1');
    expect(getState.combatState.id).toBe('combat-1');
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/api/admin/rooms/room-1/combat', expect.objectContaining({ headers: expect.any(Object) }));

    const logsResult = await getDiceLogs('room-1');
    expect(logsResult.logs[0].diceType).toBe('d20');
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/api/admin/rooms/room-1/dice-logs', expect.objectContaining({ headers: expect.any(Object) }));

    fetchMock.mockRestore();
  });

  it('calls player character builder APIs', async () => {
    const draft = { name: '洛林', concept: '', species: '', subSpecies: '', className: '', classDetail: '', background: '', abilityScores: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, skills: [], equipment: [], spells: [], languages: [], proficiencies: [], personality: '', ideal: '', bond: '', flaw: '', notes: '' };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ options: { classes: [] } }),
        text: async () => JSON.stringify({ options: { classes: [] } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ draft: { name: '洛林' }, audit: { valid: false, issues: [] } }),
        text: async () => JSON.stringify({ draft: { name: '洛林' }, audit: { valid: false, issues: [] } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ character: { id: 'char-1', confirmed: false } }),
        text: async () => JSON.stringify({ character: { id: 'char-1', confirmed: false } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ character: { id: 'char-1', confirmed: true } }),
        text: async () => JSON.stringify({ character: { id: 'char-1', confirmed: true } })
      } as Response);

    await getCharacterBuilderOptions('token-1');
    await auditCharacterBuilderDraft('token-1', draft);
    await saveCharacterBuilderDraft('token-1', draft);
    await confirmCharacterBuilderDraft('token-1', draft);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/player/token-1/character-builder/options', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/player/token-1/character-builder/audit', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ draft })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/player/token-1/character-builder/draft', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ draft })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/player/token-1/character-builder/confirm', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ draft })
    }));

    fetchMock.mockRestore();
  });

  it('calls campaign memory APIs for summaries, quests, NPCs, and locations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ summaries: [] }),
        text: async () => JSON.stringify({ summaries: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ summary: { id: 's-1' } }),
        text: async () => JSON.stringify({ summary: { id: 's-1' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quests: [] }),
        text: async () => JSON.stringify({ quests: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quest: { id: 'q-1', title: '调查矿井' } }),
        text: async () => JSON.stringify({ quest: { id: 'q-1', title: '调查矿井' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ npcs: [] }),
        text: async () => JSON.stringify({ npcs: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ npc: { id: 'n-1', name: '格拉克' } }),
        text: async () => JSON.stringify({ npc: { id: 'n-1', name: '格拉克' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ locations: [] }),
        text: async () => JSON.stringify({ locations: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ location: { id: 'l-1', name: '废弃矿井' } }),
        text: async () => JSON.stringify({ location: { id: 'l-1', name: '废弃矿井' } })
      } as Response);

    await listSessionSummaries('room-1');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/rooms/room-1/summaries', expect.objectContaining({ headers: expect.any(Object) }));

    await triggerSessionSummary('room-1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/rooms/room-1/summaries', expect.objectContaining({ method: 'POST' }));

    await listQuests('room-1');
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/rooms/room-1/quests', expect.objectContaining({ headers: expect.any(Object) }));

    const questInput = { title: '调查矿井', status: 'in_progress' as const, description: '' };
    await updateQuest('room-1', questInput);
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/rooms/room-1/quests', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(questInput)
    }));

    await listNpcs('room-1');
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/rooms/room-1/npcs', expect.objectContaining({ headers: expect.any(Object) }));

    const npcInput = { name: '格拉克', role: '地精首领', attitude: 'hostile' as const, notes: '', location: '' };
    await updateNpc('room-1', npcInput);
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/api/admin/rooms/room-1/npcs', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(npcInput)
    }));

    await listLocations('room-1');
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/api/admin/rooms/room-1/locations', expect.objectContaining({ headers: expect.any(Object) }));

    const locInput = { name: '废弃矿井', description: '被地精占据的旧矿井。' };
    await updateLocation('room-1', locInput);
    expect(fetchMock).toHaveBeenNthCalledWith(8, '/api/admin/rooms/room-1/locations', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(locInput)
    }));

    fetchMock.mockRestore();
  });

  it('calls DB management APIs with expected methods and bodies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: { id: 'src-1', name: 'World A', fileHash: 'abc123' }, sourceType: 'world_book', worldBook: { name: 'World A' }, draftsCount: 0 }),
        text: async () => JSON.stringify({ source: { id: 'src-1', name: 'World A' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sources: [{ id: 'src-1', name: 'World A', url: 'http://localhost/test.json', sourceType: 'world_book', version: '', fileHash: 'abc123', fileSize: 100, entryCount: 5, lastCheckedAt: '2026-05-30T00:00:00.000Z', createdAt: '2026-05-30T00:00:00.000Z' }] }),
        text: async () => JSON.stringify({ sources: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hasUpdate: true, newHash: 'def456' }),
        text: async () => JSON.stringify({ hasUpdate: true })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: { id: 'src-1', name: 'World A Updated' }, sourceType: 'world_book' }),
        text: async () => JSON.stringify({ source: {} })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true })
      } as Response);

    const { listDbSources, checkDbSourceUpdates, updateDbSource, deleteDbSource } = await import('./api');

    await listDbSources();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/db/sources', expect.objectContaining({ headers: expect.any(Object) }));

    await checkDbSourceUpdates('src-1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/db/sources/src-1/check-updates', expect.objectContaining({ method: 'POST' }));

    await updateDbSource('src-1');
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/db/sources/src-1/update', expect.objectContaining({ method: 'POST' }));

    await deleteDbSource('src-1');
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/db/sources/src-1', expect.objectContaining({ method: 'DELETE' }));

    fetchMock.mockRestore();
  });
});
