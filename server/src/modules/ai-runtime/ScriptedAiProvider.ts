import type { AiPrompt } from '@dnd/contracts';
import type { AiPreviewHooks, AiProviderPort } from './AiProviderPort.js';

/** 测试用 Provider 脚本：返回 final output（unknown）或 throw。只应通过 CreateAppOptions.aiProvider 注入。 */
export type AiProviderScript = (input: AiPrompt, hooks: AiPreviewHooks) => Promise<unknown>;

export class ScriptedAiProvider implements AiProviderPort {
  readonly name = 'scripted';
  constructor(private readonly script: AiProviderScript) {}
  stream(input: AiPrompt, hooks: AiPreviewHooks): Promise<unknown> {
    return this.script(input, hooks);
  }
}

/** 辅助：先按 deltaTexts 逐条 emit preview delta，再返回 resolution 对象（未 parse，由应用层 parse）。 */
export function scriptedResolution(resolution: unknown, deltaTexts: string[] = []): AiProviderScript {
  return async (_input, hooks) => {
    for (const text of deltaTexts) {
      await hooks.onDelta({ kind: 'text', text });
    }
    return resolution;
  };
}

/**
 * 结构化读取 prompt 中已批准角色的 playerId：测试脚本用它构造真实成员 id 的
 * privateUpdates/dice/interactions，避免硬编码 id 与真实成员不一致。
 * 直接消费 AiPrompt.characters（结构化字段），不解析人类可读 prompt 字符串。
 */
export function approvedPlayerIds(prompt: AiPrompt): string[] {
  return prompt.characters.map((c) => c.playerId);
}
