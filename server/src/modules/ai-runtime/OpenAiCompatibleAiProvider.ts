import type { AiPrompt, AiProviderPublicConfig } from '@dnd/contracts';
import {
  requestOpenAiCompatibleMessage,
  type OpenAiCompatibleConfig,
} from './OpenAiCompatibleTransport.js';
import type { AiPreviewHooks, AiProviderPort } from './AiProviderPort.js';

/** 与 transport 一致的连接配置（来自环境变量，仅服务端内存持有）。 */
export type { OpenAiCompatibleConfig };

/** 与 legacy RuntimeSettings 结构一致的上游调用参数（v1 无 retry 面）。 */
export interface OpenAiCompatibleRuntimeSettings {
  timeoutMs: number;
  temperature: number;
}

/** 无法把 provider 输出解码为 JSON object 时的固定脱敏错误文案：绝不携带原始响应正文或密钥。 */
const DECODE_FAILURE_MESSAGE = 'AI provider returned an invalid response format.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * 从 provider 输出文本中提取唯一的 JSON object：优先纯 JSON，其次 Markdown ```json fence，
 * 最后把首尾 {} 之间作为候选。解码失败抛固定脱敏错误（不含原始正文）。
 * 这是传输协议适配层：领域 schema 校验仍由应用层 TurnResolutionValidator 负责。
 */
export function extractJsonObjectCandidate(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  const parseObject = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const direct = parseObject(raw);
  if (direct) return direct;
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < raw.length; end += 1) {
      const char = raw[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const embedded = parseObject(raw.slice(start, end + 1));
          if (embedded && typeof embedded.publicNarrative === 'string') return embedded;
          break;
        }
      }
    }
  }
  throw new Error(DECODE_FAILURE_MESSAGE);
}

/**
 * 真实 OpenAI-compatible Provider 端口适配器：只做协议适配，绝不持有 DB tx、不应用领域状态。
 * stream 返回结构化 unknown（JSON object），由应用层 AiResolutionProposal schema/域校验解析；
 * preview 只发送已解析对象中的非空 publicNarrative，绝不把完整 JSON 广播到公开预览。
 */
export class OpenAiCompatibleAiProvider implements AiProviderPort {
  readonly name = 'openai-compatible';
  readonly model: string;

  get publicConfig(): AiProviderPublicConfig {
    return {
      provider: this.name,
      baseUrl: this.config.baseUrl,
      model: this.model,
      configured: true,
      apiKeyConfigured: true,
      source: 'environment',
    };
  }

  constructor(
    private readonly config: OpenAiCompatibleConfig,
    private readonly runtimeSettings?: OpenAiCompatibleRuntimeSettings,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.model = config.model;
  }

  async stream(input: AiPrompt, hooks: AiPreviewHooks): Promise<unknown> {
    const content = await requestOpenAiCompatibleMessage(
      this.config,
      input.messages,
      this.runtimeSettings ?? { timeoutMs: 240_000, temperature: 0.7 },
      this.fetchImpl,
    );
    const parsed = extractJsonObjectCandidate(content);
    const publicNarrative = typeof parsed.publicNarrative === 'string' && parsed.publicNarrative.trim() !== ''
      ? parsed.publicNarrative.trim()
      : '';
    if (publicNarrative) {
      await hooks.onDelta({ kind: 'text', text: publicNarrative });
    }
    return parsed;
  }
}
