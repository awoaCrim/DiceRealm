import { loadConfig, parseAiProviderEnv } from './config.js';
import { createConfiguredAiProvider } from './modules/ai-runtime/createAiProvider.js';
import { runServerWithSignals } from './platform/startup/runServerWithSignals.js';

// 薄入口：启动顺序（lock → manifest → open → migrate → credential gate → app → listen）
// 与 SIGINT/SIGTERM 关闭全部由 runServerWithSignals + startPlatformServer 负责；
// 本文件只做 config 加载与配置完整性提示，不再直接 open/migrate/load key。
const config = loadConfig();
await runServerWithSignals({ config, env: process.env });

// 环境变量 → 安全工厂（只读 process.env，绝不写库/日志/HTTP）：
// 仅当 AI_PROVIDER=openai-compatible 且配置完整时启用真实 Provider，否则安全回落 UnavailableAiProvider。
if (parseAiProviderEnv(process.env).provider === 'openai-compatible') {
  const probe = createConfiguredAiProvider(process.env);
  if (probe.name === 'unavailable') {
    // 不输出任何配置值/密钥；只提示配置不完整已回落。
    console.warn('AI_PROVIDER=openai-compatible 配置不完整，已安全回落 UnavailableAiProvider。请检查 AI_PROVIDER_BASE_URL / AI_PROVIDER_API_KEY / AI_PROVIDER_MODEL。');
  }
}
