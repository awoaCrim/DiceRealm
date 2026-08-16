import type { EncounterStartInput, ValidatedStateChange } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

/**
 * Phase 3+ 战斗能力端口：StateChangeMaterializer 把 kind='combat' 的 stateChange 委托给 apply，
 * 把 AI 创建式遭遇（encounterStarts）委托给 startEncounter；二者都在调用方 formal apply tx 内执行。
 */
export interface CombatStateChangeApplier {
  apply(tx: QueryExecutor, campaignId: string, change: ValidatedStateChange): Promise<void>;
  /** AI 创建遭遇：服务端生成 id、默认同事务掷先攻；仅一次结算一个遭遇（validator 已限制）。 */
  startEncounter(tx: QueryExecutor, campaignId: string, start: EncounterStartInput): Promise<void>;
}
