import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  applyPresetTemplate,
  getActivePresetType,
  listPresetTemplates,
  PRESET_TEMPLATES
} from '../services/dmPresetService.js';
import { createDefaultGlobalPreset, getActiveGlobalPromptBlocks, getGlobalPresets } from '../services/globalConfigService.js';

describe('DM Preset Service', () => {
  it('listPresetTemplates returns 8 template types', () => {
    const templates = listPresetTemplates();
    expect(templates).toHaveLength(8);
    const types = templates.map((t) => t.type);
    expect(types).toContain('tutorial');
    expect(types).toContain('rules_strict');
    expect(types).toContain('story_first');
    expect(types).toContain('combat_first');
    expect(types).toContain('casual');
    expect(types).toContain('dark_fantasy');
    expect(types).toContain('sandbox');
    expect(types).toContain('epic');
    // Metadata only, no full block content in list
    for (const template of templates) {
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.blockCount).toBeGreaterThan(0);
      expect((template as unknown as Record<string, unknown>).blocks).toBeUndefined();
    }
  });

  it('PRESET_TEMPLATES constant has 8 entries with blocks that have categories', () => {
    expect(PRESET_TEMPLATES).toHaveLength(8);
    for (const template of PRESET_TEMPLATES) {
      expect(template.type).toBeTruthy();
      expect(template.blocks.length).toBeGreaterThan(0);
      expect(template.blocks.some((block) => (
        block.name === '剧情字数限制'
        && block.content.includes('objectiveLog：最多 300')
        && block.content.includes('publicLog：最多 1500')
        && block.content.includes('常规多人行动回合写 500-900')
        && block.content.includes('privateUpdatesByPlayer：每名玩家最多 300')
      ))).toBe(true);
      for (const block of template.blocks) {
        expect(block.category).toBeTruthy();
        expect(block.content).toBeTruthy();
      }
    }
  });

  it('combat-oriented templates describe combat as lightweight situational context', () => {
    const combatText = PRESET_TEMPLATES
      .filter((template) => template.type === 'rules_strict' || template.type === 'combat_first')
      .flatMap((template) => [template.name, template.description, ...template.blocks.map((block) => block.content)])
      .join('\n');

    expect(combatText).toContain('轻量临场态势');
    expect(combatText).toContain('combat_state 只作为辅助');
    expect(combatText).not.toContain('战斗中严格遵循先攻顺序');
    expect(combatText).not.toContain('精确追踪每个战斗细节');
    expect(combatText).not.toContain('严格遵守 5e 战斗规则');
  });

  it('upgrades legacy default narrative limits without overwriting custom limits', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      createDefaultGlobalPreset(db);
      const legacyRules = [
        '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
        '- objectiveLog：最多 300 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。',
        '- publicLog：最多 300 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。',
        '- privateUpdatesByPlayer：每名玩家最多 150 个中文字符，只写该玩家本人可见的私人信息。'
      ].join('\n');
      db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE name = ?').run(legacyRules, '剧情字数限制');

      createDefaultGlobalPreset(db);
      let block = getActiveGlobalPromptBlocks(db).find((item) => item.name === '剧情字数限制');
      expect(block?.content).toContain('publicLog：最多 1500');
      expect(block?.content).toContain('privateUpdatesByPlayer：每名玩家最多 300');

      const previousRules = [
        '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
        '- objectiveLog：最多 300 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。',
        '- publicLog：最多 600 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。',
        '- privateUpdatesByPlayer：每名玩家最多 300 个中文字符，只写该玩家本人可见的私人信息。'
      ].join('\n');
      db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE name = ?').run(previousRules, '剧情字数限制');

      createDefaultGlobalPreset(db);
      block = getActiveGlobalPromptBlocks(db).find((item) => item.name === '剧情字数限制');
      expect(block?.content).toContain('publicLog：最多 1500');
      expect(block?.content).toContain('privateUpdatesByPlayer：每名玩家最多 300');

      const currentBeforeExpansionRules = [
        '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
        '- objectiveLog：最多 300 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。',
        '- publicLog：最多 1000 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。',
        '- privateUpdatesByPlayer：每名玩家最多 300 个中文字符，只写该玩家本人可见的私人信息。'
      ].join('\n');
      db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE name = ?').run(currentBeforeExpansionRules, '剧情字数限制');

      createDefaultGlobalPreset(db);
      block = getActiveGlobalPromptBlocks(db).find((item) => item.name === '剧情字数限制');
      expect(block?.content).toContain('publicLog：最多 1500');
      expect(block?.content).toContain('常规多人行动回合写 500-900');
      expect(block?.content).toContain('privateUpdatesByPlayer：每名玩家最多 300');

      const currentBeforeMinimumGuidanceRules = [
        '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
        '- objectiveLog：最多 300 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。',
        '- publicLog：最多 1500 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。通常写 500-900 个中文字符，写成可读场景段落，不要压缩成一句摘要；即使检定失败，也要交代玩家动作过程、现场反馈、NPC/环境反应和下一步可行动信息。',
        '- privateUpdatesByPlayer：每名玩家最多 300 个中文字符，只写该玩家本人可见的私人信息。'
      ].join('\n');
      db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE name = ?').run(currentBeforeMinimumGuidanceRules, '剧情字数限制');

      createDefaultGlobalPreset(db);
      block = getActiveGlobalPromptBlocks(db).find((item) => item.name === '剧情字数限制');
      expect(block?.content).toContain('publicLog：最多 1500');
      expect(block?.content).toContain('常规多人行动回合写 500-900');
      expect(block?.content).toContain('privateUpdatesByPlayer：每名玩家最多 300');

      const suggestedTemplateRules = [
        '剧情字数限制：控制 AI 本回合输出的三层剧情长度。',
        '- objectiveLog：建议 500-1000 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。',
        '- publicLog：建议 500-1500 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。',
        '- privateUpdatesByPlayer：每名玩家建议 300-800 个中文字符，只写该玩家本人可见的私人信息。',
        '如本回合信息量较少，可以低于建议下限；如信息量较大，优先保留可行动信息、规则结果和状态变化，不要用冗长文学描写填满上限。'
      ].join('\n');
      db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE name = ?').run(suggestedTemplateRules, '剧情字数限制');

      createDefaultGlobalPreset(db);
      block = getActiveGlobalPromptBlocks(db).find((item) => item.name === '剧情字数限制');
      expect(block?.content).toContain('publicLog：最多 1500');
      expect(block?.content).toContain('常规多人行动回合写 500-900');
      expect(block?.content).toContain('privateUpdatesByPlayer：每名玩家最多 300');

      const customRules = [
        '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
        '- objectiveLog：最多 1000 个中文字符。',
        '- publicLog：最多 900 个中文字符。',
        '- privateUpdatesByPlayer：每名玩家最多 500 个中文字符。'
      ].join('\n');
      db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE name = ?').run(customRules, '剧情字数限制');

      createDefaultGlobalPreset(db);
      block = getActiveGlobalPromptBlocks(db).find((item) => item.name === '剧情字数限制');
      expect(block?.content).toContain('publicLog：最多 900');
      expect(block?.content).toContain('privateUpdatesByPlayer：每名玩家最多 500');
    } finally {
      db.close();
    }
  });

  it('applyPresetTemplate creates preset with typed blocks', () => {
    const db = createMemoryDb();
    migrate(db);
    createDefaultGlobalPreset(db);

    const preset = applyPresetTemplate(db, 'tutorial');

    expect(preset.presetType).toBe('tutorial');
    expect(preset.name).toBeTruthy();
    expect(preset.blocks.length).toBeGreaterThan(0);
    for (const block of preset.blocks) {
      expect(block.category).toBeTruthy();
      expect(block.content).toBeTruthy();
    }

    // Verify the preset was stored in DB
    const presets = getGlobalPresets(db);
    const stored = presets.find((p) => p.id === preset.id);
    expect(stored).toBeDefined();
    if (stored) {
      expect(stored.presetType).toBe('tutorial');
      expect(stored.blocks.length).toBeGreaterThan(0);
      for (const block of stored.blocks) {
        expect(block.category).toBeTruthy();
      }
    }
  });

  it('applyPresetTemplate sets as active and deactivates others', () => {
    const db = createMemoryDb();
    migrate(db);
    createDefaultGlobalPreset(db);

    // Apply first template
    const preset1 = applyPresetTemplate(db, 'tutorial');
    expect(preset1.isActive).toBe(true);

    // Apply second template
    const preset2 = applyPresetTemplate(db, 'rules_strict');
    expect(preset2.isActive).toBe(true);

    // Verify only one is active
    const presets = getGlobalPresets(db);
    const activeCount = presets.filter((p) => p.isActive).length;
    expect(activeCount).toBe(1);

    // Verify preset1 is no longer active
    const stored1 = presets.find((p) => p.id === preset1.id);
    expect(stored1?.isActive).toBe(false);
  });

  it('getActivePresetType returns correct type', () => {
    const db = createMemoryDb();
    migrate(db);
    createDefaultGlobalPreset(db);

    // Initially no preset template applied, default preset has no presetType
    const initialType = getActivePresetType(db);
    expect(initialType).toBeNull();

    // Apply a template
    applyPresetTemplate(db, 'combat_first');
    const activeType = getActivePresetType(db);
    expect(activeType).toBe('combat_first');
  });

  it('applyPresetTemplate also creates blocks with sceneType defaults', () => {
    const db = createMemoryDb();
    migrate(db);
    createDefaultGlobalPreset(db);

    const preset = applyPresetTemplate(db, 'rules_strict');

    // At least some blocks should have sceneType defined or default to 'all'
    const blocksWithSceneType = preset.blocks.filter(
      (b) => b.sceneType !== undefined
    );
    // Not all templates define sceneType, but if they do, they should be valid
    for (const block of blocksWithSceneType) {
      expect(['exploration', 'social', 'combat', 'all']).toContain(block.sceneType);
    }

    // All blocks should fall back to 'all' when sceneType is undefined
    const allBlocks = getActiveGlobalPromptBlocks(db);
    for (const block of allBlocks) {
      const sceneType = block.sceneType ?? 'all';
      expect(['exploration', 'social', 'combat', 'all']).toContain(sceneType);
    }
  });
});
