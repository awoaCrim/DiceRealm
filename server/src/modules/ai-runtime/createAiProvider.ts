import { parseAiProviderEnv, type AiProviderEnvConfig } from '../../config.js';
import type { AiProviderPort } from './AiProviderPort.js';
import { OpenAiCompatibleAiProvider } from './OpenAiCompatibleAiProvider.js';
import { UnavailableAiProvider } from './UnavailableAiProvider.js';

/**
 * 安全组合工厂：只有 provider === 'openai-compatible' 且 baseUrl/apiKey/model 完整、
 * baseUrl 为 HTTP(S) 时才生成真实适配器；其余一律 UnavailableAiProvider。绝不生成 Mock。
 * 不导入 legacy transport 工厂（它会返回 Mock，v1 平台绝不允许）。
 */
export function createAiProviderFromConfig(config: AiProviderEnvConfig, fetchImpl?: typeof fetch): AiProviderPort {
  if (config.provider !== 'openai-compatible') {
    return new UnavailableAiProvider();
  }
  if (!config.baseUrl.trim() || !config.apiKey.trim() || !config.model.trim()) {
    return new UnavailableAiProvider();
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    return new UnavailableAiProvider();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return new UnavailableAiProvider();
  }
  if (!url.hostname) {
    return new UnavailableAiProvider();
  }
  return new OpenAiCompatibleAiProvider(
    { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model },
    { timeoutMs: config.timeoutMs, temperature: config.temperature },
    fetchImpl,
  );
}

/**
 * 唯一无副作用的 env → parse → factory 入口：index.ts composition root 只调用它，
 * 测试可直接传入任意 env 对象验证（不读取 process.env、不启动任何服务）。
 */
export function createConfiguredAiProvider(env: Record<string, string | undefined>): AiProviderPort {
  return createAiProviderFromConfig(parseAiProviderEnv(env));
}
