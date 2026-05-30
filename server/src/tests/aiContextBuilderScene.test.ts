import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../services/aiContextBuilder.js';
import type { PromptBlock, SceneType } from '../domain/types.js';

describe('AI Context Builder scene filtering', () => {
  function makeBlocks(overrides: Array<Partial<PromptBlock>> = []): PromptBlock[] {
    return overrides.map((override, index) => ({
      id: `block-${index}`,
      presetId: 'preset-1',
      name: override.name ?? `Block ${index}`,
      role: 'system' as const,
      position: 'before_world' as const,
      enabled: true,
      orderIndex: index * 10,
      content: override.content ?? `Content ${index}`,
      category: override.category,
      sceneType: override.sceneType
    }));
  }

  function makeBaseInput() {
    return {
      room: { id: 'r1', name: 'Test Room', systemPrompt: '', worldInfo: 'Test World', currentTurn: 1, status: 'waiting_for_actions' as const, aiConfig: {} as any, createdAt: '' },
      players: [],
      publicLogs: [],
      actions: [],
      interactions: []
    };
  }

  it('includes all blocks when no sceneType is specified', () => {
    const blocks = makeBlocks([
      { name: 'General', sceneType: 'all', content: 'GENERAL' },
      { name: 'Combat Only', sceneType: 'combat', content: 'COMBAT' },
      { name: 'Exploration', sceneType: 'exploration', content: 'EXPLORE' },
      { name: 'No sceneType', content: 'NO_SCENE' }
    ]);

    const prompt = buildTurnPrompt({
      ...makeBaseInput(),
      promptBlocks: blocks
    });

    expect(prompt).toContain('GENERAL');
    expect(prompt).toContain('COMBAT');
    expect(prompt).toContain('EXPLORE');
    expect(prompt).toContain('NO_SCENE');
  });

  it('includes only matching sceneType blocks when sceneType is combat', () => {
    const blocks = makeBlocks([
      { name: 'General', sceneType: 'all', content: 'GENERAL' },
      { name: 'Combat Only', sceneType: 'combat', content: 'COMBAT' },
      { name: 'Exploration', sceneType: 'exploration', content: 'EXPLORE' },
      { name: 'Social', sceneType: 'social', content: 'SOCIAL' },
      { name: 'No sceneType', content: 'NO_SCENE' }
    ]);

    const prompt = buildTurnPrompt({
      ...makeBaseInput(),
      promptBlocks: blocks,
      sceneType: 'combat'
    });

    expect(prompt).toContain('GENERAL');
    expect(prompt).toContain('COMBAT');
    expect(prompt).toContain('NO_SCENE');
    expect(prompt).not.toContain('EXPLORE');
    expect(prompt).not.toContain('SOCIAL');
  });

  it('includes only matching sceneType blocks when sceneType is social', () => {
    const blocks = makeBlocks([
      { name: 'General', sceneType: 'all', content: 'GENERAL' },
      { name: 'Combat Only', sceneType: 'combat', content: 'COMBAT' },
      { name: 'Social', sceneType: 'social', content: 'SOCIAL' },
      { name: 'No sceneType', content: 'NO_SCENE' }
    ]);

    const prompt = buildTurnPrompt({
      ...makeBaseInput(),
      promptBlocks: blocks,
      sceneType: 'social'
    });

    expect(prompt).toContain('GENERAL');
    expect(prompt).toContain('SOCIAL');
    expect(prompt).toContain('NO_SCENE');
    expect(prompt).not.toContain('COMBAT');
  });

  it('excludes disabled blocks regardless of sceneType', () => {
    const blocks = makeBlocks([
      { name: 'Enabled Combat', sceneType: 'combat', enabled: true, content: 'ENABLED_COMBAT' }
    ]);
    // Add a disabled block
    blocks.push({
      id: 'block-disabled',
      presetId: 'preset-1',
      name: 'Disabled Combat',
      role: 'system',
      position: 'before_world',
      enabled: false,
      orderIndex: 100,
      content: 'DISABLED_COMBAT',
      sceneType: 'combat'
    });

    const prompt = buildTurnPrompt({
      ...makeBaseInput(),
      promptBlocks: blocks,
      sceneType: 'combat'
    });

    expect(prompt).toContain('ENABLED_COMBAT');
    expect(prompt).not.toContain('DISABLED_COMBAT');
  });

  it('default sceneType behavior: undefined sceneType blocks always included', () => {
    const blocks = makeBlocks([
      { name: 'Undefined sceneType', content: 'UNDEFINED' },
      { name: 'All sceneType', sceneType: 'all', content: 'ALL' },
      { name: 'Exploration', sceneType: 'exploration', content: 'EXPLORE' }
    ]);

    // sceneType='combat' should exclude exploration-specific block
    const combatPrompt = buildTurnPrompt({
      ...makeBaseInput(),
      promptBlocks: blocks,
      sceneType: 'combat'
    });

    expect(combatPrompt).toContain('UNDEFINED');
    expect(combatPrompt).toContain('ALL');
    expect(combatPrompt).not.toContain('EXPLORE');

    // sceneType='exploration' should include exploration-specific block
    const explorePrompt = buildTurnPrompt({
      ...makeBaseInput(),
      promptBlocks: blocks,
      sceneType: 'exploration'
    });

    expect(explorePrompt).toContain('UNDEFINED');
    expect(explorePrompt).toContain('ALL');
    expect(explorePrompt).toContain('EXPLORE');
  });
});
