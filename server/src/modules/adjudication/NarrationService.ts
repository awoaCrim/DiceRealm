import {
  narrationOutputSchema,
  narrationRequestSchema,
  type AiPrompt,
  type NarrationOutput,
  type NarrationRequest,
} from '@dnd/contracts';
import type { AiPreviewHooks, AiProviderPort } from '../ai-runtime/AiProviderPort.js';
import { AppError } from '../../platform/http/AppError.js';

/** Separate Provider boundary that can only produce readable narrative text. */
export class NarrationService {
  constructor(private readonly provider: AiProviderPort) {}

  async generate(request: NarrationRequest, basePrompt: AiPrompt, hooks: AiPreviewHooks): Promise<NarrationOutput> {
    const parsedRequest = narrationRequestSchema.parse(request);
    const allowedPlayerIds = new Set(parsedRequest.actionSummaries.map((summary) => summary.actorId));
    const prompt: AiPrompt = {
      campaignId: parsedRequest.campaignId,
      audience: 'public',
      stage: 'narration',
      // The narration Provider receives only actor identities that appear in
      // this turn's submitted actions; it never receives the owner context's
      // character sheet or GM-only blocks.
      characters: basePrompt.characters.filter((character) => allowedPlayerIds.has(character.playerId)),
      messages: [
        {
          role: 'system',
          content: [
            '你是叙事生成器。只描述服务端已经提交的 observableOutcome 和 observableEntities。',
            'actionSummaries 只有服务端投影的 observableIntent，不包含玩家 raw action body；不得补回或猜测隐藏意图。',
            '只返回 JSON：{ publicNarrative: string, privateUpdates: [{ playerId: string, content: string }] }。',
            '不得返回 stateChanges、DC、AC、修正值、骰点、RollPlan、RollRecord 或任何新的机械效果。',
            '只能使用 observableEntities 中的可见实体名称和 action/effect/roll 的显式关联。',
            'privateUpdates 只能使用输入中已经存在的玩家 id。',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(parsedRequest) },
      ],
    };
    let output: unknown;
    try {
      output = await this.provider.stream(prompt, hooks);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('AI_PROVIDER_FAILED', 'Narration Provider 调用失败。');
    }
    const parsed = narrationOutputSchema.safeParse(output);
    if (!parsed.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'Narration 输出不符合只读叙事契约。');
    }
    for (const update of parsed.data.privateUpdates) {
      if (!allowedPlayerIds.has(update.playerId)) {
        throw new AppError('AI_OUTPUT_INVALID', 'Narration 私密结果引用了不属于当前回合的玩家。');
      }
    }
    return parsed.data;
  }
}
