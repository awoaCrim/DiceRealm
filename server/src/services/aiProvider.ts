import type { AiProviderConfig, AiTurnResult } from '../domain/types.js';
import { defaultNarrativeLengthLimits, type NarrativeLengthLimits } from './aiContextBuilder.js';

const AI_PROVIDER_TIMEOUT_MS = 120_000;
const AI_PROVIDER_ERROR_BODY_MAX_CHARS = 1000;
const AI_PROVIDER_MAX_ATTEMPTS = 3;

export interface AiProvider {
  name: string;
  generateTurnResult(prompt: string): Promise<AiTurnResult>;
}

export class MockAiProvider implements AiProvider {
  name = 'mock';

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    const log = `The party's actions echo through the scene.\n\n${prompt.slice(0, 240)}`;
    return {
      objectiveLog: log,
      publicLog: log,
      privateUpdatesByPlayer: {},
      ruleResults: ['Mock ruling: no rule conflict detected.'],
      interactionRequests: [],
      diceRequests: [],
      suggestedStateChanges: [],
      characterResourceChanges: []
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function sanitizeProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join('[REDACTED_API_KEY]') : body;
  return redacted.length > AI_PROVIDER_ERROR_BODY_MAX_CHARS
    ? `${redacted.slice(0, AI_PROVIDER_ERROR_BODY_MAX_CHARS)}…`
    : redacted;
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenAI-compatible provider baseUrl must use http or https');
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  assertHttpUrl(parsed);
  const base = new URL(parsed.toString().replace(/\/*$/, '/'));
  return new URL('chat/completions', base).toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientProviderError(status: number, body: string): boolean {
  return status === 429 || status >= 500 || /\b(EOF|ECONNRESET|ETIMEDOUT|timeout|temporarily unavailable|connection)\b/i.test(body);
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\b(EOF|ECONNRESET|ETIMEDOUT|fetch failed|socket|network|connection)\b/i.test(`${error.name} ${error.message}`);
}

function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }

  return null;
}

function parseJsonWithMessage(text: string, message: string, allowEmbeddedJson = false): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (allowEmbeddedJson) {
      const candidate = extractJsonCandidate(text);
      if (candidate && candidate !== text) {
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
        }
      }
    }
    throw new Error(message);
  }
}

function parseOpenAiCompatibleResponseText(responseText: string): unknown {
  const trimmed = responseText.trim();
  if (!trimmed.startsWith('data:')) {
    return parseJsonWithMessage(responseText, 'AI provider returned invalid JSON response');
  }

  let content = '';
  const choices: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.trim().startsWith('data:')
      ? line.trim().slice('data:'.length).trim()
      : '';
    if (!data || data === '[DONE]') continue;
    const chunk = parseJsonWithMessage(data, 'AI provider returned invalid streaming JSON chunk');
    if (!isPlainObject(chunk)) continue;
    const chunkChoices = chunk.choices;
    if (!Array.isArray(chunkChoices)) continue;
    choices.push(...chunkChoices);
    for (const choice of chunkChoices) {
      if (!isPlainObject(choice)) continue;
      const delta = choice.delta;
      const message = choice.message;
      if (isPlainObject(delta) && typeof delta.content === 'string') content += delta.content;
      if (isPlainObject(message) && typeof message.content === 'string') content += message.content;
    }
  }

  return { choices: choices.length > 0 ? [{ message: { content } }] : [] };
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function optionalRecordOfStrings(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function firstStringField(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string' && field.trim()) return field;
  }
  return '';
}

const requiredAiTurnFields = [
  'objectiveLog',
  'publicLog',
  'privateUpdatesByPlayer',
  'ruleResults',
  'interactionRequests',
  'diceRequests',
  'suggestedStateChanges',
  'characterResourceChanges'
];

export const aiTurnLengthLimits = {
  objectiveLog: defaultNarrativeLengthLimits.objectiveLog,
  publicLog: defaultNarrativeLengthLimits.publicLog,
  privateUpdate: defaultNarrativeLengthLimits.privateUpdate,
  ruleResult: 120,
  interactionRequest: 120,
  suggestedStateChangeReason: 120,
  characterResourceChangeReason: 80,
  diceRequestReason: 80
} as const;

function textLength(value: string): number {
  return Array.from(value.trim()).length;
}

function pushLengthWarning(warnings: string[], label: string, value: string, max: number): void {
  const current = textLength(value);
  if (current > max) warnings.push(`${label} 长度 ${current}/${max}，超过上限。`);
}

export function validateAiTurnResultLengthWarnings(result: AiTurnResult, narrativeLimits: NarrativeLengthLimits = defaultNarrativeLengthLimits): string[] {
  const warnings: string[] = [];
  pushLengthWarning(warnings, 'objectiveLog', result.objectiveLog ?? '', narrativeLimits.objectiveLog);
  pushLengthWarning(warnings, 'publicLog', result.publicLog, narrativeLimits.publicLog);
  for (const [playerId, content] of Object.entries(result.privateUpdatesByPlayer)) {
    pushLengthWarning(warnings, `privateUpdatesByPlayer.${playerId}`, content, narrativeLimits.privateUpdate);
  }
  for (const [index, item] of result.ruleResults.entries()) {
    pushLengthWarning(warnings, `ruleResults[${index}]`, item, aiTurnLengthLimits.ruleResult);
  }
  for (const [index, item] of result.interactionRequests.entries()) {
    pushLengthWarning(warnings, `interactionRequests[${index}].prompt`, item.prompt, aiTurnLengthLimits.interactionRequest);
  }
  for (const [index, item] of (result.suggestedStateChanges ?? []).entries()) {
    if (typeof item.reason === 'string') pushLengthWarning(warnings, `suggestedStateChanges[${index}].reason`, item.reason, aiTurnLengthLimits.suggestedStateChangeReason);
  }
  for (const [index, item] of (result.characterResourceChanges ?? []).entries()) {
    pushLengthWarning(warnings, `characterResourceChanges[${index}].reason`, item.reason, aiTurnLengthLimits.characterResourceChangeReason);
  }
  for (const [index, item] of (result.diceRequests ?? []).entries()) {
    pushLengthWarning(warnings, `diceRequests[${index}].reason`, item.reason, aiTurnLengthLimits.diceRequestReason);
  }
  return warnings;
}

function hasAnyField(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => key in value);
}

function normalizeAiTurnResultShape(value: unknown, options: { strictRequiredFields?: boolean } = {}): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('AI provider returned invalid AiTurnResult payload');
  if (options.strictRequiredFields) {
    const missing = requiredAiTurnFields.filter((field) => !hasAnyField(value, [field, field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)]));
    if (missing.length > 0) throw new Error(`AI provider returned AiTurnResult missing required fields: ${missing.join(', ')}`);
  }

  const publicLog = firstStringField(value, ['publicLog', 'public_log', 'publicNarration', 'publicNarrative', 'narration', 'story', '剧情', '公开剧情', '公共剧情']);
  const objectiveLog = firstStringField(value, ['objectiveLog', 'objective_log', 'objectiveNarration', 'objectiveNarrative', 'dmLog', 'dm_log', '客观剧情', '完整剧情', '主持人剧情']) || publicLog;
  const privateUpdatesByPlayer =
    value.privateUpdatesByPlayer
    ?? value.private_updates_by_player
    ?? value.privateLogs
    ?? value.playerLogs
    ?? value.playerNarratives
    ?? value['玩家剧情'];
  const ruleResults = value.ruleResults ?? value.rule_results ?? value.rules ?? value['规则结果'];
  const interactionRequests = value.interactionRequests ?? value.interaction_requests ?? value.interactions ?? value['互动请求'];
  const suggestedStateChanges = value.suggestedStateChanges ?? value.suggested_state_changes ?? value.stateChanges ?? value['状态变更建议'];
  const characterResourceChanges = value.characterResourceChanges ?? value.character_resource_changes ?? value.resourceChanges ?? value['玩家状态变更'];
  const diceRequests = value.diceRequests ?? value.dice_requests ?? value['骰点请求'];
  const diceResults = value.diceResults ?? value.dice_results ?? value['骰点结果'];

  return {
    ...value,
    objectiveLog,
    publicLog,
    privateUpdatesByPlayer: optionalRecordOfStrings(privateUpdatesByPlayer),
    ruleResults: optionalStringArray(ruleResults),
    interactionRequests: Array.isArray(interactionRequests) ? interactionRequests : [],
    suggestedStateChanges: Array.isArray(suggestedStateChanges) ? suggestedStateChanges : [],
    characterResourceChanges: normalizeCharacterResourceChanges(characterResourceChanges, suggestedStateChanges),
    diceRequests: Array.isArray(diceRequests) ? diceRequests : [],
    diceResults: Array.isArray(diceResults) ? diceResults : undefined
  };
}

function isCharacterResourcePath(path: string): boolean {
  return [
    /^hitPoints\.(current|max|temp)$/,
    /^hitDice\.(remaining|total)$/,
    /^spellSlots\.([a-zA-Z0-9_]+|\d+)$/,
    /^spellSlots\.([a-zA-Z0-9_]+|\d+)\.(total|used)$/,
    /^ammo\.\d+\.(name|current|max)$/,
    /^consumables\.\d+\.(name|quantity)$/,
    /^currency\.(gp|sp|cp)$/,
    /^conditions$/,
  ].some((pattern) => pattern.test(path));
}

function normalizeOneCharacterResourceChange(change: unknown): unknown[] {
  if (!isPlainObject(change) || typeof change.path !== 'string' || !isCharacterResourcePath(change.path)) return [];
  const characterId = typeof change.characterId === 'string'
    ? change.characterId
    : typeof change.targetId === 'string'
      ? change.targetId
      : '';
  if (!characterId || characterId.startsWith('room:')) return [];
  return [{
    characterId,
    path: change.path,
    before: change.before,
    after: change.after,
    reason: typeof change.reason === 'string' ? change.reason : 'AI suggested character resource change',
    ruleRefs: Array.isArray(change.ruleRefs) ? change.ruleRefs.filter((item): item is string => typeof item === 'string') : []
  }];
}

function normalizeCharacterResourceChanges(explicitChanges: unknown, suggestedChanges: unknown): unknown[] | undefined {
  const direct = Array.isArray(explicitChanges) ? explicitChanges.flatMap(normalizeOneCharacterResourceChange) : [];
  const fromSuggested = Array.isArray(suggestedChanges)
    ? suggestedChanges.flatMap((change) => {
      if (!isPlainObject(change)) return [];
      const changeType = typeof change.changeType === 'string' ? change.changeType : typeof change.type === 'string' ? change.type : '';
      const looksLikeResourceChange = ['character_resource', 'character_resource_change', 'player_status', '玩家状态'].includes(changeType)
        || (typeof change.path === 'string'
          && isCharacterResourcePath(change.path)
          && (typeof change.characterId === 'string' || typeof change.targetId === 'string'));
      if (!looksLikeResourceChange || typeof change.path !== 'string') return [];
      return normalizeOneCharacterResourceChange(change);
    })
    : [];
  const combined = [...direct, ...fromSuggested];
  return combined;
}

export function validateAiTurnResult(value: unknown, options: { strictRequiredFields?: boolean } = {}): AiTurnResult {
  const normalized = normalizeAiTurnResultShape(value, options);
  if (typeof normalized.publicLog !== 'string' || normalized.publicLog.trim() === '') throw new Error('AI provider returned invalid AiTurnResult payload');
  if (!isPlainObject(normalized.privateUpdatesByPlayer)) throw new Error('AI provider returned invalid AiTurnResult payload');
  if (!Object.values(normalized.privateUpdatesByPlayer).every((item) => typeof item === 'string')) {
    throw new Error('AI provider returned invalid AiTurnResult payload');
  }
  if (!Array.isArray(normalized.ruleResults) || !normalized.ruleResults.every((item) => typeof item === 'string')) {
    throw new Error('AI provider returned invalid AiTurnResult payload');
  }
  if (!Array.isArray(normalized.interactionRequests) || !normalized.interactionRequests.every((item) => (
    isPlainObject(item)
    && typeof item.sourcePlayerId === 'string'
    && typeof item.targetPlayerId === 'string'
    && typeof item.type === 'string'
    && typeof item.prompt === 'string'
  ))) {
    throw new Error('AI provider returned invalid AiTurnResult payload');
  }

  return {
    objectiveLog: normalized.objectiveLog as string,
    publicLog: normalized.publicLog,
    privateUpdatesByPlayer: normalized.privateUpdatesByPlayer as Record<string, string>,
    ruleResults: normalized.ruleResults as string[],
    interactionRequests: normalized.interactionRequests as AiTurnResult['interactionRequests'],
    suggestedStateChanges: normalized.suggestedStateChanges as AiTurnResult['suggestedStateChanges'],
    characterResourceChanges: normalized.characterResourceChanges as AiTurnResult['characterResourceChanges'],
    diceRequests: normalized.diceRequests as AiTurnResult['diceRequests'],
    diceResults: normalized.diceResults as AiTurnResult['diceResults']
  };
}

export async function requestOpenAiCompatibleMessage(config: AiProviderConfig, messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string> {
  if (!config.apiKey) {
    throw new Error('apiKey is required when provider=openai-compatible');
  }

  const url = chatCompletionsUrl(config.baseUrl);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= AI_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AI_PROVIDER_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.7,
          stream: false
        }),
        signal: controller.signal
      });

      const responseText = await response.text();
      if (!response.ok) {
        const statusText = response.statusText ? ` ${response.statusText}` : '';
        const sanitizedBody = sanitizeProviderBody(responseText, config.apiKey);
        const error = new Error(`AI provider failed with ${response.status}${statusText}: ${sanitizedBody}`);
        lastError = error;
        if (attempt < AI_PROVIDER_MAX_ATTEMPTS && isTransientProviderError(response.status, responseText)) {
          await delay(200 * attempt);
          continue;
        }
        throw error;
      }

      const data = parseOpenAiCompatibleResponseText(responseText);
      if (!isPlainObject(data)) throw new Error('AI provider returned invalid JSON response');
      const choices = data.choices;
      const content = Array.isArray(choices) && isPlainObject(choices[0]) && isPlainObject(choices[0].message)
        ? choices[0].message.content
        : undefined;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('AI provider returned no choices[0].message.content');
      }
      return content;
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(`AI provider request timed out after ${AI_PROVIDER_TIMEOUT_MS}ms`);
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < AI_PROVIDER_MAX_ATTEMPTS && isTransientFetchError(error)) {
        await delay(200 * attempt);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('AI provider request failed');
}

export class OpenAiCompatibleProvider implements AiProvider {
  name = 'openai-compatible';

  constructor(private readonly config: AiProviderConfig) {}

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    const content = await requestOpenAiCompatibleMessage(this.config, [
      { role: 'system', content: 'Return strict JSON only. Never include markdown fences.' },
      { role: 'user', content: prompt }
    ]);

    let parsed: unknown;
    try {
      parsed = parseJsonWithMessage(content, 'AI provider returned invalid AiTurnResult JSON', true);
    } catch {
      parsed = {
        publicLog: content.trim(),
        privateUpdatesByPlayer: {},
        ruleResults: [],
        interactionRequests: []
      };
    }
    return validateAiTurnResult(parsed, { strictRequiredFields: true });
  }
}

export function createAiProviderFromConfig(config: AiProviderConfig): AiProvider {
  if (config.provider === 'openai-compatible') {
    assertHttpUrl(new URL(config.baseUrl));
    return new OpenAiCompatibleProvider(config);
  }
  return new MockAiProvider();
}

export async function testAiProviderConfig(config: AiProviderConfig): Promise<void> {
  if (config.provider === 'mock') return;
  await requestOpenAiCompatibleMessage(config, [
    { role: 'system', content: 'You are testing whether this model endpoint responds.' },
    { role: 'user', content: 'Reply with ok.' }
  ]);
}
