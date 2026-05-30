import type { EmbeddingProviderConfig } from '../domain/types.js';

const EMBEDDING_PROVIDER_TIMEOUT_MS = 30_000;
const EMBEDDING_PROVIDER_ERROR_BODY_MAX_CHARS = 1000;

export interface EmbeddingProvider {
  name: string;
  fingerprint: string;
  embed(text: string): Promise<number[]>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function sanitizeProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join('[REDACTED_API_KEY]') : body;
  return redacted.length > EMBEDDING_PROVIDER_ERROR_BODY_MAX_CHARS
    ? `${redacted.slice(0, EMBEDDING_PROVIDER_ERROR_BODY_MAX_CHARS)}…`
    : redacted;
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenAI-compatible embedding provider baseUrl must use http or https');
  }
}

function embeddingsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  assertHttpUrl(parsed);
  const base = new URL(parsed.toString().replace(/\/*$/, '/'));
  return new URL('embeddings', base).toString();
}

function parseJsonWithMessage(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(message);
  }
}

function validateEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('Embedding provider returned invalid embedding vector');
  }
  return value;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  name = 'mock';
  readonly fingerprint: string;

  constructor(private readonly dimensions: number) {
    this.fingerprint = `mock:${dimensions}`;
  }

  async embed(text: string): Promise<number[]> {
    const bytes = new TextEncoder().encode(text);
    const vector = Array.from({ length: this.dimensions }, (_, index) => {
      let value = 0;
      for (let offset = index; offset < bytes.length; offset += this.dimensions) {
        value = (value * 31 + bytes[offset] + offset + 1) % 2000;
      }
      return value - 1000;
    });
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) return Array.from({ length: this.dimensions }, () => 0);
    return vector.map((value) => value / norm);
  }
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  name = 'openai-compatible';
  readonly fingerprint: string;

  constructor(private readonly config: EmbeddingProviderConfig) {
    this.fingerprint = `openai-compatible:${config.baseUrl}:${config.model}:${config.dimensions}`;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.config.apiKey) {
      throw new Error('apiKey is required when provider=openai-compatible');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, EMBEDDING_PROVIDER_TIMEOUT_MS);

    try {
      const response = await fetch(embeddingsUrl(this.config.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          input: text,
          dimensions: this.config.dimensions
        }),
        signal: controller.signal
      });

      const responseText = await response.text();
      if (!response.ok) {
        const statusText = response.statusText ? ` ${response.statusText}` : '';
        throw new Error(`Embedding provider failed with ${response.status}${statusText}: ${sanitizeProviderBody(responseText, this.config.apiKey)}`);
      }

      const data = parseJsonWithMessage(responseText, 'Embedding provider returned invalid JSON response');
      const embedding = isPlainObject(data) && Array.isArray(data.data) && isPlainObject(data.data[0])
        ? data.data[0].embedding
        : undefined;
      return validateEmbeddingVector(embedding);
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(`Embedding provider request timed out after ${EMBEDDING_PROVIDER_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createEmbeddingProviderFromConfig(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.provider === 'openai-compatible') {
    assertHttpUrl(new URL(config.baseUrl));
    return new OpenAiCompatibleEmbeddingProvider(config);
  }
  return new MockEmbeddingProvider(config.dimensions);
}

export async function testEmbeddingProviderConfig(config: EmbeddingProviderConfig): Promise<void> {
  if (config.provider === 'mock') return;
  const provider = createEmbeddingProviderFromConfig(config);
  await provider.embed('connection test');
}
