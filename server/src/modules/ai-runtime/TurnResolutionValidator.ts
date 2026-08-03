import type { TurnResolution } from '@dnd/contracts';
import { turnResolutionSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';

export class TurnResolutionValidator {
  constructor(private readonly executor: QueryExecutor) {}

  async validate(campaignId: string, output: unknown): Promise<TurnResolution> {
    const parsed = turnResolutionSchema.safeParse(output);
    if (!parsed.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'AI 输出不符合结构化结算契约。');
    }
    const resolution = parsed.data;
    const memberIds = new Set(
      (await this.executor.query<{ user_id: string }>(
        "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'player'", [campaignId],
      )).map((row) => row.user_id),
    );
    // 在 SQL 之前拒绝重复 id：diceResults / interactionRequests 的 id 必须是唯一条目身份，
    // 重复会让条目身份不唯一，映射 AI_OUTPUT_INVALID，绝不能把 DB 唯一约束错误误报为 AI_PROVIDER_FAILED。
    const diceIds = resolution.diceResults.map((d) => d.id);
    if (new Set(diceIds).size !== diceIds.length) {
      throw new AppError('AI_OUTPUT_INVALID', 'diceResults 存在重复 id。');
    }
    const interactionIds = resolution.interactionRequests.map((i) => i.id);
    if (new Set(interactionIds).size !== interactionIds.length) {
      throw new AppError('AI_OUTPUT_INVALID', 'interactionRequests 存在重复 id。');
    }
    for (const update of resolution.privateUpdates) {
      if (!memberIds.has(update.playerId)) {
        throw new AppError('AI_OUTPUT_INVALID', `privateUpdates 目标玩家不是该战役成员：${update.playerId}`);
      }
    }
    for (const dice of resolution.diceResults) {
      if (dice.visibility === 'player_private' && dice.targetPlayerId && !memberIds.has(dice.targetPlayerId)) {
        throw new AppError('AI_OUTPUT_INVALID', `diceResults 目标玩家不是该战役成员：${dice.targetPlayerId}`);
      }
    }
    for (const interaction of resolution.interactionRequests) {
      if (!memberIds.has(interaction.targetPlayerId)) {
        throw new AppError('AI_OUTPUT_INVALID', `interactionRequests 目标玩家不是该战役成员：${interaction.targetPlayerId}`);
      }
    }
    await this.validateStateChangeTargets(campaignId, resolution);
    return resolution;
  }

  private async validateStateChangeTargets(campaignId: string, resolution: TurnResolution): Promise<void> {
    const characters = new CharacterRepository(this.executor);
    const facts = new WorldFactRepository(this.executor);
    for (const change of resolution.stateChanges) {
      if (change.kind === 'character') {
        const row = await characters.findById(change.targetId);
        if (!row || row.campaign_id !== campaignId) {
          throw new AppError('AI_OUTPUT_INVALID', `stateChanges.character 目标不属于该战役：${change.targetId}`);
        }
      } else if (change.kind === 'world' || change.kind === 'quest') {
        const row = await facts.findById(change.targetId);
        if (!row || row.campaign_id !== campaignId) {
          throw new AppError('AI_OUTPUT_INVALID', `stateChanges.${change.kind} 目标不属于该战役：${change.targetId}`);
        }
        if (change.kind === 'quest' && row.kind !== 'quest') {
          throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.quest 目标不是 quest 世界事实。');
        }
      }
      // kind=combat：target 归属不在本任务校验，由 materializer 在应用时抛 STATE_CONFLICT。
    }
  }
}
