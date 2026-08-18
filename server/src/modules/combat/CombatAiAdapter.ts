import { z } from 'zod';
import {
  combatCommandSchema,
  encounterStartSchema,
  startEncounterInputSchema,
  type EncounterStartInput,
  isValidatedStateChange,
  type ProposedStateChange,
  type ValidatedStateChange,
} from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import type { CombatStateChangeApplier } from '../ai-runtime/CombatStateChangeApplier.js';
import type { CombatCommandPort } from './CombatService.js';
import { CombatRepository } from './CombatRepository.js';

/** AI combat patch：{ command: <non-start kind>, ...payloadFields }；payload 字段由 combatCommandSchema 严格校验。 */
const combatPatchSchema = z.object({
  command: z.enum([
    'roll_initiative',
    'advance_turn',
    'apply_attack',
    'apply_saving_throw',
    'apply_damage',
    'apply_healing',
    'add_condition',
    'remove_condition',
    'end_encounter',
  ]),
}).passthrough();

/**
 * AI 战斗适配：把 stateChange { kind:'combat', targetId, patch } 映射为同一白名单命令端口
 * （CombatCommandPort.applyIn），与 AI entries/archive/turn complete 在同一 formal apply tx。
 * 只接受既有且 unsuperseded 的 encounter；创建式遭遇（encounterStarts）经 startEncounter
 * 委托 CombatService.createIn 并在同 tx 掷先攻。
 * patch 解析/目标不存在/跨 campaign → AI_OUTPUT_INVALID；战斗状态冲突保持 STATE_CONFLICT。
 */
export class CombatAiAdapter implements CombatStateChangeApplier {
  constructor(
    private readonly combat: CombatCommandPort,
    private readonly repository: CombatRepository,
  ) {}

  /** AI 创建遭遇：调用方 formal apply tx 内复用 createIn seam；默认 rollInitiative=true 同事务掷先攻。
   *  AI 数据导致的 VALIDATION_ERROR（schema 失败/非成员/跨战役角色）→ AI_OUTPUT_INVALID；
   *  STATE_CONFLICT（已有未完成遭遇等）保持原码。 */
  async startEncounter(tx: QueryExecutor, campaignId: string, start: EncounterStartInput): Promise<void> {
    try {
      // 防御性重解析：生产路径已由 turnResolutionSchema 解析并施加 rollInitiative 默认值；
      // 直接调用 seam 时也保证语义一致（缺省 true）。
      const parsedStart = encounterStartSchema.parse(start);
      // 去掉 rollInitiative，复用 owner start 同一输入 schema 与 createIn 核心。
      const input = startEncounterInputSchema.parse(parsedStart);
      const revisionRows = await tx.query<{ revision: number }>(
        'SELECT revision FROM platform_campaign_state_heads WHERE campaign_id = ?', [campaignId],
      );
      const stateRevision = Number(revisionRows[0]?.revision ?? 0);
      const encounter = await this.combat.createIn(tx, campaignId, input, stateRevision);
      if (parsedStart.rollInitiative) {
        // 同一白名单命令端口、同一 caller tx：服务端注入 RNG 掷先攻并进入 active。
        await this.combat.applyIn(tx, campaignId, encounter.id, { kind: 'roll_initiative', payload: {} });
      }
    } catch (error) {
      if (error instanceof z.ZodError || (error instanceof AppError && error.code === 'VALIDATION_ERROR')) {
        throw new AppError('AI_OUTPUT_INVALID', 'AI 遭遇创建数据无效（战斗员或角色归属不合法）。');
      }
      throw error;
    }
  }

  async apply(tx: QueryExecutor, campaignId: string, change: ProposedStateChange): Promise<void> {
    if (!isValidatedStateChange(change)) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges 尚未完成服务端校验。');
    }
    if (change.kind !== 'combat') {
      throw new AppError('AI_OUTPUT_INVALID', 'CombatAiAdapter 只接受 combat stateChange。');
    }
    const patch = combatPatchSchema.safeParse(change.patch);
    if (!patch.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.combat patch 不是白名单命令。');
    }
    // targetId 必须是既有且 unsuperseded 的 encounter。
    const encounter = await this.repository.findEncounterById(change.targetId);
    if (!encounter || encounter.campaign_id !== campaignId) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.combat 目标遭遇不存在或不属于该战役。');
    }
    const { command, ...payloadFields } = patch.data;
    const commandInput = { kind: command, payload: payloadFields };
    const parsed = combatCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.combat 命令 payload 无效。');
    }
    // 战斗状态冲突（非活动 actor、encounter 非 active 等）保持 STATE_CONFLICT 原码。
    await this.combat.applyIn(tx, campaignId, change.targetId, parsed.data);
  }
}

/** 独立构造 helper：composition root 与测试共用。 */
export function createCombatAiAdapter(combat: CombatCommandPort, executor: QueryExecutor): CombatAiAdapter {
  return new CombatAiAdapter(combat, new CombatRepository(executor));
}
