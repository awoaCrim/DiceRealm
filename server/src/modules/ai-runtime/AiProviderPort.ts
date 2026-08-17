import type { AiPrompt, AiProviderPublicConfig } from '@dnd/contracts';

/** Public preview deltas currently carry text; providers may emit structured deltas later. */
export interface AiPreviewDelta {
  kind: 'text';
  text: string;
}

export interface AiPreviewHooks {
  onDelta(delta: AiPreviewDelta): Promise<void>;
}

/** Provider 端口：stream 返回 Provider-facing AiResolutionProposal（unknown），由应用层 schema/域校验解析。绝不持有 DB tx。
 *  name 标识 Provider 种类（unavailable/scripted/openai-compatible）；model 记录真实模型名
 *  （platform_ai_runs.model 落库值，OpenAI 兼容 Provider 应为配置的上游模型名）。 */
export interface AiProviderPort {
  readonly name: string;
  readonly model: string;
  /** 脱敏运行状态：不包含 API Key；旧测试 Provider 可不实现，路由会使用安全回退。 */
  readonly publicConfig?: AiProviderPublicConfig;
  /** 动态 Provider 可按战役解析真实适配器；AiResolutionService 在 claim 前固定本次 run 的实例。 */
  resolveForCampaign?(campaignId: string): Promise<AiProviderPort>;
  stream(input: AiPrompt, hooks: AiPreviewHooks): Promise<unknown>;
}
