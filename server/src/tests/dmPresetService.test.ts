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
      for (const block of template.blocks) {
        expect(block.category).toBeTruthy();
        expect(block.content).toBeTruthy();
      }
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
