import type { AppDatabase } from '../db/connection.js';
import type { PresetNumericConfig, PromptBlock, PromptBlockPosition, RuntimeSettings } from '../domain/types.js';
import { defaultPresetNumericConfig, defaultRuntimeSettings } from '../domain/types.js';
import { defaultNarrativeLengthLimits, type NarrativeLengthLimits, renderDndOutputContract } from './aiContextBuilder.js';
import { getActiveGlobalPromptBlocks, getGlobalPresets, getGlobalRuntimeSettings } from './globalConfigService.js';

export function getActivePresetBlockByPosition(db: AppDatabase, position: PromptBlockPosition): PromptBlock | undefined {
  const blocks = getActiveGlobalPromptBlocks(db);
  return blocks.find((block) => block.enabled && block.position === position);
}

export function getActivePresetBlocksByPosition(db: AppDatabase, position: PromptBlockPosition): PromptBlock[] {
  const blocks = getActiveGlobalPromptBlocks(db);
  return blocks.filter((block) => block.enabled && block.position === position);
}

export function getActiveNumericConfig(db: AppDatabase): PresetNumericConfig {
  const presets = getGlobalPresets(db);
  const active = presets.find((p) => p.isActive);
  return active?.numericConfig ?? defaultPresetNumericConfig;
}

export function getActiveNarrativeLengthLimits(db: AppDatabase): NarrativeLengthLimits {
  const config = getActiveNumericConfig(db);
  const limits = config.narrativeLimits ?? defaultPresetNumericConfig.narrativeLimits;
  return {
    objectiveLog: limits.objective ?? defaultNarrativeLengthLimits.objectiveLog,
    publicLog: limits.public ?? defaultNarrativeLengthLimits.publicLog,
    privateUpdate: limits.private ?? defaultNarrativeLengthLimits.privateUpdate
  };
}

export function getActiveOutputContract(db: AppDatabase): string {
  const block = getActivePresetBlockByPosition(db, 'output_contract');
  if (block?.content?.trim()) return block.content.trim();
  const limits = getActiveNarrativeLengthLimits(db);
  return renderDndOutputContract(limits);
}

export function getActiveRewriteTaskPrompt(db: AppDatabase): string | null {
  return getActivePresetBlockByPosition(db, 'rewrite_task')?.content?.trim() || null;
}

export function getActiveRewriteStylePrompt(db: AppDatabase): string | null {
  return getActivePresetBlockByPosition(db, 'rewrite_style')?.content?.trim() || null;
}

export function getActiveRewriteAntiClichePrompt(db: AppDatabase): string | null {
  return getActivePresetBlockByPosition(db, 'rewrite_anti_cliche')?.content?.trim() || null;
}

export function getActiveRewriteCotPrompt(db: AppDatabase): string | null {
  return getActivePresetBlockByPosition(db, 'rewrite_cot')?.content?.trim() || null;
}

export function getActiveOpeningPrompt(db: AppDatabase): string | null {
  return getActivePresetBlockByPosition(db, 'opening_prompt')?.content?.trim() || null;
}

export function getActiveOpeningFallback(db: AppDatabase): string | null {
  return getActivePresetBlockByPosition(db, 'opening_fallback')?.content?.trim() || null;
}

export function getActivePostResolutionPrompt(db: AppDatabase): string | null {
  return getActivePresetBlockByPosition(db, 'post_resolution_prompt')?.content?.trim() || null;
}

export function getActiveRuntimeSettings(db: AppDatabase): RuntimeSettings {
  return getGlobalRuntimeSettings(db);
}
