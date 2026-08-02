import type { TurnStatus } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface TurnRow {
  id: string;
  campaign_id: string;
  number: number;
  status: TurnStatus;
  locked_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionRow {
  id: string;
  turn_id: string;
  campaign_id: string;
  player_id: string;
  body: string;
  submitted_at: string;
  updated_at: string;
}

export interface RequirementRow {
  turn_id: string;
  campaign_id: string;
  player_id: string;
  submitted: number;
}

/**
 * TurnRepository：通过 QueryExecutor 端口访问回合/行动/要求表。
 * 每个方法都接收 executor，可在 DatabasePort.transaction 内用 tx 重新构造，
 * 保证读 + 状态检查 + 条件更新 + 事件发布在同一事务内完成。
 * 不包含权限策略与业务规则（这些属于 TurnService）。
 */
export class TurnRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insertTurn(row: TurnRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_turns
        (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.number, row.status, row.locked_at, row.completed_at,
       row.created_at, row.updated_at],
    );
  }

  async findTurnById(id: string): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>('SELECT * FROM platform_turns WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  /**
   * 查找战役内未终结（进行中）的回合：waiting_for_actions / locked / resolving /
   * needs_owner_attention 都算进行中，只有 completed 才允许开启下一回合。
   * 锁定后回合只能经 AI 结算或 owner 处理前进（产品规格），因此 locked 也阻挡新回合。
   */
  async findUnfinishedTurn(campaignId: string): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>(
      "SELECT * FROM platform_turns WHERE campaign_id = ? AND status IN ('waiting_for_actions','locked','resolving','needs_owner_attention') ORDER BY number ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  async listByCampaign(campaignId: string): Promise<TurnRow[]> {
    return this.executor.query<TurnRow>(
      'SELECT * FROM platform_turns WHERE campaign_id = ? ORDER BY number ASC',
      [campaignId],
    );
  }

  async maxTurnNumber(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(number) AS max FROM platform_turns WHERE campaign_id = ?',
      [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }

  /** 条件 no-op 更新：获得 turn 行锁（Postgres 行锁；SQLite 写事务串行），未命中表示不存在。 */
  async lockTurnRow(turnId: string, campaignId: string): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE platform_turns SET updated_at = updated_at WHERE id = ? AND campaign_id = ?',
      [turnId, campaignId],
    );
    return result.changes === 1;
  }

  /** 状态迁移：仅当仍为 waiting_for_actions 时锁定；返回是否命中（防止重复发 locked 事件）。 */
  async lockTurn(turnId: string, lockedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      "UPDATE platform_turns SET status = 'locked', locked_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_actions'",
      [lockedAt, lockedAt, turnId],
    );
    return result.changes === 1;
  }

  async insertRequirement(turnId: string, campaignId: string, playerId: string): Promise<void> {
    await this.executor.execute(
      'INSERT INTO platform_turn_requirements (turn_id, campaign_id, player_id, submitted) VALUES (?, ?, ?, 0)',
      [turnId, campaignId, playerId],
    );
  }

  async listRequirements(turnId: string): Promise<RequirementRow[]> {
    return this.executor.query<RequirementRow>(
      'SELECT * FROM platform_turn_requirements WHERE turn_id = ? ORDER BY player_id',
      [turnId],
    );
  }

  async isRequired(turnId: string, playerId: string): Promise<boolean> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_requirements WHERE turn_id = ? AND player_id = ?',
      [turnId, playerId],
    );
    return Number(rows[0].count) > 0;
  }

  async markRequirementSubmitted(turnId: string, playerId: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turn_requirements SET submitted = 1 WHERE turn_id = ? AND player_id = ?',
      [turnId, playerId],
    );
  }

  async countSubmitted(turnId: string): Promise<number> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_requirements WHERE turn_id = ? AND submitted = 1',
      [turnId],
    );
    return Number(rows[0].count);
  }

  async countTotal(turnId: string): Promise<number> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_requirements WHERE turn_id = ?',
      [turnId],
    );
    return Number(rows[0].count);
  }

  async insertAction(row: ActionRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_actions
        (id, turn_id, campaign_id, player_id, body, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.turn_id, row.campaign_id, row.player_id, row.body, row.submitted_at, row.updated_at],
    );
  }

  async updateActionBody(actionId: string, body: string, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE platform_actions SET body = ?, updated_at = ? WHERE id = ?',
      [body, updatedAt, actionId],
    );
    return result.changes === 1;
  }

  async findActionByTurnPlayer(turnId: string, playerId: string): Promise<ActionRow | null> {
    const rows = await this.executor.query<ActionRow>(
      'SELECT * FROM platform_actions WHERE turn_id = ? AND player_id = ?',
      [turnId, playerId],
    );
    return rows[0] ?? null;
  }

  async listActionsByTurn(turnId: string): Promise<ActionRow[]> {
    return this.executor.query<ActionRow>(
      'SELECT * FROM platform_actions WHERE turn_id = ? ORDER BY submitted_at ASC',
      [turnId],
    );
  }
}
