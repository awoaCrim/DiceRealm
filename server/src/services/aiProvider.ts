import type { AiProviderConfig, AiTurnResult } from '../domain/types.js';

const AI_PROVIDER_TIMEOUT_MS = 30_000;
const AI_PROVIDER_ERROR_BODY_MAX_CHARS = 1000;

export interface AiProvider {
  name: string;
  generateTurnResult(prompt: string): Promise<AiTurnResult>;
}

export class MockAiProvider implements AiProvider {
  name = 'mock';

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    return {
      publicLog: `The party's actions echo through the scene.\n\n${prompt.slice(0, 240)}`,
      privateUpdatesByPlayer: {},
      ruleResults: ['Mock ruling: no rule conflict detected.'],
      interactionRequests: []
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

function parseJsonWithMessage(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(message);
  }
}

function validateAiTurnResult(value: unknown): AiTurnResult {
  if (!isPlainObject(value)) throw new Error('AI provider returned invalid AiTurnResult payload');
  if (typeof value.publicLog !== 'string') throw new Error('AI provider returned invalid AiTurnResult payload');
  if (!isPlainObject(value.privateUpdatesByPlayer)) throw new Error('AI provider returned invalid AiTurnResult payload');
  if (!Object.values(value.privateUpdatesByPlayer).every((item) => typeof item === 'string')) {
    throw new Error('AI provider returned invalid AiTurnResult payload');
  }
  if (!Array.isArray(value.ruleResults) || !value.ruleResults.every((item) => typeof item === 'string')) {
    throw new Error('AI provider returned invalid AiTurnResult payload');
  }
  if (!Array.isArray(value.interactionRequests) || !value.interactionRequests.every((item) => (
    isPlainObject(item)
    && typeof item.sourcePlayerId === 'string'
    && typeof item.targetPlayerId === 'string'
    && typeof item.type === 'string'
    && typeof item.prompt === 'string'
  ))) {
    throw new Error('AI provider returned invalid AiTurnResult payload');
  }

  return {
    publicLog: value.publicLog,
    privateUpdatesByPlayer: value.privateUpdatesByPlayer as Record<string, string>,
    ruleResults: value.ruleResults,
    interactionRequests: value.interactionRequests as AiTurnResult['interactionRequests'],
    suggestedStateChanges: Array.isArray(value.suggestedStateChanges) ? value.suggestedStateChanges as AiTurnResult['suggestedStateChanges'] : undefined,
    characterResourceChanges: value.characterResourceChanges as AiTurnResult['characterResourceChanges'],
    diceRequests: value.diceRequests as AiTurnResult['diceRequests'],
    diceResults: value.diceResults as AiTurnResult['diceResults']
  };
}

export async function requestOpenAiCompatibleMessage(config: AiProviderConfig, messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string> {
  if (!config.apiKey) {
    throw new Error('apiKey is required when provider=openai-compatible');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : '';
      throw new Error(`AI provider failed with ${response.status}${statusText}: ${sanitizeProviderBody(responseText, config.apiKey)}`);
    }

    const data = parseJsonWithMessage(responseText, 'AI provider returned invalid JSON response');
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
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  name = 'openai-compatible';

  constructor(private readonly config: AiProviderConfig) {}

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    const content = await requestOpenAiCompatibleMessage(this.config, [
      { role: 'system', content: 'Return strict JSON only. Never include markdown fences.' },
      { role: 'user', content: prompt }
    ]);

    const parsed = parseJsonWithMessage(content, 'AI provider returned invalid AiTurnResult JSON');
    return validateAiTurnResult(parsed);
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
