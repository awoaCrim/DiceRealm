import type { AiPrompt } from '@dnd/contracts';
import { assertSafeProviderUrl } from './ProviderUrlPolicy.js';

const AI_PROVIDER_ERROR_BODY_MAX_CHARS = 1000;
const DECODE_FAILURE_MESSAGE = 'AI provider returned an invalid response format.';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 单请求调用参数：v1 contract 一次 attempt 至多一次 Provider HTTP 请求，无自动 retry。 */
export interface OpenAiCompatibleRequestSettings {
  timeoutMs: number;
  temperature: number;
}

/** 稳定、可读、不携带密钥/URL/原始正文的 transport 错误。 */
export class OpenAiCompatibleTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAiCompatibleTransportError';
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

async function chatCompletionsUrl(baseUrl: string): Promise<URL> {
  // 只做 URL shape 校验（ProviderUrlPolicy）；loopback/LAN 等目标地址本 Phase 允许。
  // ProviderUrlPolicy 抛出的 AppError 在此统一转成 transport 错误，保证模块错误契约一致。
  let parsed: URL;
  try {
    parsed = await assertSafeProviderUrl(baseUrl);
  } catch {
    throw new OpenAiCompatibleTransportError('AI provider base URL 无效：需要 HTTP(S) URL 且不能包含用户名或密码。');
  }
  // 清除 query/hash：它们不应泄漏到 chat/completions 请求 URL；且残留 search 会干扰
  // WHATWG 相对解析（例如 /v1?token=… 会错误地丢掉 /v1 段）。
  parsed.search = '';
  parsed.hash = '';
  let pathname = parsed.pathname;
  if (!pathname.endsWith('/')) pathname += '/';
  parsed.pathname = pathname;
  return new URL('chat/completions', parsed);
}

function parseJsonWithMessage(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenAiCompatibleTransportError(message);
  }
}

/**
 * 解析 chat-completions 响应文本：兼容普通 JSON，以及上游误发 `data:` SSE 帧
 * 时的 buffered parse（逐帧拼 content）。不导出 retry/backoff 或 legacy
 * turn parser/validator。
 */
function parseOpenAiCompatibleResponseText(responseText: string): unknown {
  const trimmed = responseText.trim();
  if (!trimmed.startsWith('data:')) {
    return parseJsonWithMessage(responseText, DECODE_FAILURE_MESSAGE);
  }

  let content = '';
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.trim().startsWith('data:')
      ? line.trim().slice('data:'.length).trim()
      : '';
    if (!data || data === '[DONE]') continue;
    const chunk = parseJsonWithMessage(data, DECODE_FAILURE_MESSAGE);
    if (!isPlainObject(chunk)) continue;
    const chunkChoices = chunk.choices;
    if (!Array.isArray(chunkChoices)) continue;
    for (const choice of chunkChoices) {
      if (!isPlainObject(choice)) continue;
      const delta = choice.delta;
      const message = choice.message;
      if (isPlainObject(delta) && typeof delta.content === 'string') content += delta.content;
      if (isPlainObject(message) && typeof message.content === 'string') content += message.content;
    }
  }
  return content ? { choices: [{ message: { content } }] } : { choices: [] };
}

/**
 * 单请求 OpenAI-compatible transport：一次 attempt 恰好一次 HTTP 请求。
 *
 * 保留：URL shape check、chat/completions join、Bearer header、stream:false、
 * AbortController timeout、redirect:'manual' + 3xx 拒绝、API key 脱敏、
 * 错误正文 ≤1000 字符预算、JSON/`data:` SSE 容错解析、`fetchImpl` 注入 seam。
 * 删除：retry loop/backoff、429/5xx transient 分类、attempt 计数配置、Mock、
 * tool-calling、legacy turn parser/validator。
 */
export async function requestOpenAiCompatibleMessage(
  config: OpenAiCompatibleConfig,
  messages: AiPrompt['messages'],
  settings: OpenAiCompatibleRequestSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.apiKey) {
    throw new OpenAiCompatibleTransportError('apiKey is required when provider=openai-compatible');
  }
  if (messages.length === 0) {
    throw new OpenAiCompatibleTransportError('messages must not be empty');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, settings.timeoutMs);

  try {
    const url = await chatCompletionsUrl(config.baseUrl);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: settings.temperature,
        stream: false,
      }),
      signal: controller.signal,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      throw new OpenAiCompatibleTransportError('AI provider redirects are not allowed');
    }
    // undici 在 redirect:'manual' 下会把 3xx 折叠成 opaque-redirect（status 0 / type 'opaqueredirect'）：
    // 同样拒绝并给出稳定错误，不 follow、不携带 Authorization 发送到重定向目标。
    if (response.status === 0 || response.type === 'opaqueredirect') {
      throw new OpenAiCompatibleTransportError('AI provider redirects are not allowed');
    }
    const responseText = await response.text();
    if (!response.ok) {
      // 绝不透传 statusText：上游可能把敏感值（如 API key 片段）放进 reason phrase。
      const sanitizedBody = sanitizeProviderBody(responseText, config.apiKey);
      throw new OpenAiCompatibleTransportError(
        `AI provider failed with ${response.status}: ${sanitizedBody}`,
      );
    }

    const data = parseOpenAiCompatibleResponseText(responseText);
    if (!isPlainObject(data)) throw new OpenAiCompatibleTransportError(DECODE_FAILURE_MESSAGE);
    const choices = data.choices;
    const content = Array.isArray(choices) && isPlainObject(choices[0]) && isPlainObject(choices[0].message)
      ? choices[0].message.content
      : undefined;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new OpenAiCompatibleTransportError('AI provider returned no choices[0].message.content');
    }
    return content;
  } catch (error) {
    if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
      throw new OpenAiCompatibleTransportError(`AI provider request timed out after ${settings.timeoutMs}ms`);
    }
    if (error instanceof OpenAiCompatibleTransportError) throw error;
    throw new OpenAiCompatibleTransportError('AI provider request failed');
  } finally {
    clearTimeout(timer);
  }
}
