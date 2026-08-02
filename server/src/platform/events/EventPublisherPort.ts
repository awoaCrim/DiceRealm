import type { CampaignEvent } from '@dnd/contracts';
import type { QueryExecutor } from '../database/DatabasePort.js';

/** 领域事件发布端口：在业务事务内写入 outbox（同 tx 原子提交/回滚）。service 只依赖本端口，不 new concrete。 */
export interface EventPublisherPort {
  publishIn(tx: QueryExecutor, event: CampaignEvent): Promise<number>;
}
