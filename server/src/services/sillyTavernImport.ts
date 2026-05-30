import type { ImportedWorldBookPosition } from '../domain/types.js';

export interface ParsedScriptCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  visibilityNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  rawJson: unknown;
}

export interface ParsedWorldBookEntry {
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  priority: number;
  orderIndex: number;
  position: ImportedWorldBookPosition;
  rawJson: unknown;
}

export interface ParsedWorldBook {
  name: string;
  entries: ParsedWorldBookEntry[];
  warnings: string[];
  rawJson: unknown;
}

export interface ParsedCharacterCardImport {
  script: ParsedScriptCard;
  embeddedWorldBook?: ParsedWorldBook;
  warnings: string[];
  rawJson: unknown;
}

export interface PresetPackageInput {
  openAiSettings: unknown;
  contextTemplate?: unknown;
  instructTemplate?: unknown;
  sysprompt?: unknown;
  reasoningTemplate?: unknown;
  [key: string]: unknown;
}

export interface ParsedPresetPackage {
  name: string;
  openAiSettings: Record<string, unknown>;
  contextTemplate: unknown | null;
  instructTemplate: unknown | null;
  sysprompt: unknown | null;
  reasoningTemplate: unknown | null;
  warnings: string[];
  rawJson: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function normalizePosition(value: unknown): ImportedWorldBookPosition {
  if (value === 'before' || value === 'before_world' || value === 0) return 'before';
  return 'after';
}

function entryTitle(entry: Record<string, unknown>, index: number): string {
  return stringValue(entry.title) || stringValue(entry.name) || stringValue(entry.comment) || `Entry ${index + 1}`;
}

interface NormalizedWorldBookEntries {
  entries: Record<string, unknown>[];
  warnings: string[];
}

function normalizeWorldBookEntries(entriesInput: unknown): NormalizedWorldBookEntries {
  if (Array.isArray(entriesInput)) {
    const entries: Record<string, unknown>[] = [];
    const warnings: string[] = [];

    entriesInput.forEach((entry, index) => {
      if (isRecord(entry)) {
        entries.push(entry);
      } else {
        warnings.push(`World book entry at index ${index} is not an object and was skipped.`);
      }
    });

    return { entries, warnings };
  }

  if (isRecord(entriesInput)) {
    const entries: Record<string, unknown>[] = [];
    const warnings: string[] = [];

    for (const [key, entry] of Object.entries(entriesInput)) {
      if (isRecord(entry)) {
        entries.push(entry);
      } else {
        warnings.push(`World book entry "${key}" is not an object and was skipped.`);
      }
    }

    return { entries, warnings };
  }

  return { entries: [], warnings: [] };
}

function parseWorldBookEntry(entry: Record<string, unknown>, index: number): ParsedWorldBookEntry {
  const hasEnabled = 'enabled' in entry;
  const enabled = hasEnabled ? Boolean(entry.enabled) : !Boolean(entry.disable);

  return {
    title: entryTitle(entry, index),
    keys: stringArrayValue(entry.keys ?? entry.key),
    secondaryKeys: stringArrayValue(entry.secondaryKeys ?? entry.secondary_keys ?? entry.keysecondary),
    content: stringValue(entry.content),
    enabled,
    constant: Boolean(entry.constant),
    priority: numberValue(entry.priority, numberValue(entry.order, 0)),
    orderIndex: numberValue(entry.orderIndex, numberValue(entry.insertion_order, index)),
    position: normalizePosition(entry.position),
    rawJson: entry
  };
}

export function parseSillyTavernWorldBook(input: unknown, fallbackName = 'Imported ST World Book'): ParsedWorldBook {
  if (!isRecord(input)) {
    throw new TypeError('SillyTavern world book must be an object.');
  }

  const worldBook = input;
  const normalizedEntries = normalizeWorldBookEntries(worldBook.entries);
  const entries = normalizedEntries.entries.map(parseWorldBookEntry);
  const warnings = [
    ...normalizedEntries.warnings,
    ...entries
      .filter((entry) => entry.enabled && !entry.constant && entry.keys.length === 0)
      .map((entry) => `World book entry "${entry.title}" has no keys and is not constant, so it will not activate until edited.`)
  ];

  return {
    name: stringValue(worldBook.name, fallbackName),
    entries,
    warnings,
    rawJson: input
  };
}

export function parseSillyTavernCharacterCard(input: unknown): ParsedCharacterCardImport {
  if (!isRecord(input)) {
    throw new TypeError('SillyTavern character card must be an object.');
  }

  const root = input;
  const data = isRecord(root.data) ? root.data : root;
  const embeddedWorldBook = isRecord(data.character_book)
    ? parseSillyTavernWorldBook(data.character_book, `${stringValue(data.name, 'Imported ST Character')} World Book`)
    : undefined;

  const script: ParsedScriptCard = {
    name: stringValue(data.name, 'Imported ST Character'),
    description: stringValue(data.description),
    personality: stringValue(data.personality),
    scenario: stringValue(data.scenario),
    firstMes: stringValue(data.first_mes),
    mesExample: stringValue(data.mes_example),
    creatorNotes: stringValue(data.creator_notes),
    visibilityNotes: stringValue(data.visibility_notes) || stringValue(data.visibilityNotes),
    systemPrompt: stringValue(data.system_prompt),
    postHistoryInstructions: stringValue(data.post_history_instructions),
    rawJson: data
  };

  return {
    script,
    embeddedWorldBook,
    warnings: embeddedWorldBook?.warnings ?? [],
    rawJson: input
  };
}

export function parseSillyTavernPresetPackage(input: unknown): ParsedPresetPackage {
  if (!isRecord(input)) {
    throw new TypeError('SillyTavern preset package requires an openAiSettings object.');
  }

  const presetPackage = input;
  const openAiSettings = presetPackage.openAiSettings;
  if (!isRecord(openAiSettings)) {
    throw new TypeError('SillyTavern preset package requires an openAiSettings object.');
  }
  const warnings: string[] = [];
  if (!Array.isArray(openAiSettings.prompts)) {
    warnings.push('Preset openAiSettings has no prompts array.');
  }
  if (!Array.isArray(openAiSettings.prompt_order)) {
    warnings.push('Preset openAiSettings has no prompt_order array.');
  }

  return {
    name: stringValue(openAiSettings.name) || stringValue(openAiSettings.preset_name, 'Imported ST Preset'),
    openAiSettings,
    contextTemplate: presetPackage.contextTemplate ?? null,
    instructTemplate: presetPackage.instructTemplate ?? null,
    sysprompt: presetPackage.sysprompt ?? null,
    reasoningTemplate: presetPackage.reasoningTemplate ?? null,
    warnings,
    rawJson: input
  };
}
