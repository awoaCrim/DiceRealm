import type { AiPrompt } from '@dnd/contracts';

/** 公开 preview delta：2B 只有 text；Phase 3 扩展结构化增量。 */
export interface AiPreviewDelta {
  kind: 'text';
  text: string;
}

export interface AiPreviewHooks {
  onDelta(delta: AiPreviewDelta): Promise<void>;
}

/** Provider 端口：stream 返回 final output（unknown），由应用层 turnResolutionSchema parse。绝不持有 DB tx。 */
export interface AiProviderPort {
  readonly name: string;
  stream(input: AiPrompt, hooks: AiPreviewHooks): Promise<unknown>;
}
