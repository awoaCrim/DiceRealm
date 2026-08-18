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
  /** 007 superseded-history：被存档恢复覆盖的历史回合。insert 不写这两列（默认 NULL），读取时必可访问。 */
  superseded_at?: string | null;
  superseded_by_archive_id?: string | null;
}

export interface ActionRow {
  id: string;
  turn_id: string;
  campaign_id: string;
  player_id: string;
  actor_id?: string | null;
  body: string;
  submitted_at: string;
  updated_at: string;
  /** 019 action branch lifecycle：被存档恢复覆盖的历史行动仍保留供审计，但不再是 active action。 */
  superseded_at?: string | null;
  superseded_by_archive_id?: string | null;
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
    const rows = await this.executor.query<TurnRow>(
      'SELECT * FROM platform_turns WHERE id = ? AND superseded_at IS NULL',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * 查找战役内未终结（进行中）的回合：waiting_for_actions / locked / resolving /
   * needs_owner_attention 都算进行中，只有 completed 才允许开启下一回合。
   * 锁定后回合只能经 AI 结算或 owner 处理前进（产品规格），因此 locked 也阻挡新回合。
   * 只返回未 superseded 的行：被存档恢复覆盖的历史回合不再算进行中。
   */
  async findUnfinishedTurn(campaignId: string): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>(
      "SELECT * FROM platform_turns WHERE campaign_id = ? AND status IN ('waiting_for_actions','locked','resolving','needs_owner_attention') AND superseded_at IS NULL ORDER BY number ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  /** 默认 active 列表：只含未 superseded 的回合（存档恢复覆盖的历史回合默认不可见）。 */
  async listByCampaign(campaignId: string): Promise<TurnRow[]> {
    return this.executor.query<TurnRow>(
      'SELECT * FROM platform_turns WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY number ASC',
      [campaignId],
    );
  }

  /** 审计全量列表：含被存档恢复 supersede 的历史回合（供恢复与审计）。 */
  async listAllByCampaign(campaignId: string): Promise<TurnRow[]> {
    return this.executor.query<TurnRow>(
      'SELECT * FROM platform_turns WHERE campaign_id = ? ORDER BY number ASC',
      [campaignId],
    );
  }

  /**
   * 覆盖所有行的最大回合号（含 superseded）：恢复后新回合绝不复用历史号码。
   * 这是有意为之——maxTurnNumber 供新回合分配号码使用，必须包含被恢复覆盖的回合。
   */
  async maxTurnNumber(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(number) AS max FROM platform_turns WHERE campaign_id = ?',
      [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }

  /** 条件 no-op 更新：在 SQLite 写事务中触碰 turn 行，未命中表示不存在。
   *  superseded 回合不可再被提交/结算——返回 false → NOT_FOUND。 */
  async lockTurnRow(turnId: string, campaignId: string): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE platform_turns SET updated_at = updated_at WHERE id = ? AND campaign_id = ? AND superseded_at IS NULL',
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

  /** claim：仅当 locked 或 needs_owner_attention 时置 resolving（owner 可对失败回合用新 key 重试）。 */
  async markResolving(turnId: string, now: string): Promise<boolean> {
    const result = await this.executor.execute(
      "UPDATE platform_turns SET status = 'resolving', updated_at = ? WHERE id = ? AND status IN ('locked','needs_owner_attention')",
      [now, turnId],
    );
    return result.changes === 1;
  }

  /** formal apply：仅当仍为 resolving 时置 completed。 */
  async markCompleted(turnId: string, completedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      "UPDATE platform_turns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'resolving'",
      [completedAt, completedAt, turnId],
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
        (id, turn_id, campaign_id, player_id, actor_id, body, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.turn_id, row.campaign_id, row.player_id, row.actor_id ?? null, row.body, row.submitted_at, row.updated_at],
    );
  }

  async updateActionBody(actionId: string, body: string, updatedAt: string, actorId?: string | null): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE platform_actions SET body = ?, actor_id = COALESCE(?, actor_id), updated_at = ? WHERE id = ? AND superseded_at IS NULL',
      [body, actorId ?? null, updatedAt, actionId],
    );
    return result.changes === 1;
  }

  /** 默认只返回当前 active branch 的 action；superseded action 只通过审计查询读取。 */
  async findActionByTurnPlayer(turnId: string, playerId: string): Promise<ActionRow | null> {
    const rows = await this.executor.query<ActionRow>(
      'SELECT * FROM platform_actions WHERE turn_id = ? AND player_id = ? AND superseded_at IS NULL',
      [turnId, playerId],
    );
    return rows[0] ?? null;
  }

  async listActionsByTurn(turnId: string): Promise<ActionRow[]> {
    return this.executor.query<ActionRow>(
      'SELECT * FROM platform_actions WHERE turn_id = ? AND superseded_at IS NULL ORDER BY submitted_at ASC, id ASC',
      [turnId],
    );
  }

  /** 审计/恢复用全量列表：包含当前 branch 与所有被 supersede 的历史 action。 */
  async listAllActionsByTurn(turnId: string): Promise<ActionRow[]> {
    return this.executor.query<ActionRow>(
      'SELECT * FROM platform_actions WHERE turn_id = ? ORDER BY submitted_at ASC, id ASC',
      [turnId],
    );
  }

  async findResolvingTurn(campaignId: string): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>(
      "SELECT * FROM platform_turns WHERE campaign_id = ? AND status = 'resolving' AND superseded_at IS NULL ORDER BY number ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  /** 存档 watermark：捕获时 unsuperseded 历史最大 turn number（setup 无回合 = 0）。
   *  必须显式过滤 superseded：与 maxTurnNumber（含 superseded，防号码复用）语义不同。 */
  async maxActiveTurnNumber(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(number) AS max FROM platform_turns WHERE campaign_id = ? AND superseded_at IS NULL',
      [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }

  async findByNumber(campaignId: string, number: number): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>(
      'SELECT * FROM platform_turns WHERE campaign_id = ? AND number = ?', [campaignId, number],
    );
    return rows[0] ?? null;
  }

  /** 恢复：清掉快照当前回合的 superseded 标记，使其成为当前状态。 */
  async clearSuperseded(turnId: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turns SET superseded_at = NULL, superseded_by_archive_id = NULL WHERE id = ?', [turnId],
    );
  }

  /** 恢复：恢复现有回合的状态字段（status/locked_at/completed_at/updated_at），
   *  使已完成行恢复到快照中的 locked/waiting/needs_owner_attention 等状态。
   *  注意：completed_at 按快照原样恢复（可能保留快照中的 completed_at 时间）。
   *  只有 currentTurn 快照的 turn 才调用；null 快照不会走到这里。 */
  async restoreTurnState(
    turnId: string,
    patch: { status: TurnStatus; lockedAt: string | null; completedAt: string | null; updatedAt: string },
  ): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turns SET status = ?, locked_at = ?, completed_at = ?, updated_at = ? WHERE id = ?',
      [patch.status, patch.lockedAt, patch.completedAt, patch.updatedAt, turnId],
    );
  }

  /**
   * 恢复：把当前回合 action 切换到快照 branch（同 tx）。
   * 快照外的 later action 永不物理删除：即使被 platform_action_intents 引用，也保留完整审计链，
   * 只是标记 superseded。快照内 action 可重新激活；之后同一玩家提交会创建新的 action id，
   * 避免把旧 branch 的 audit row 原地改写成新 branch 的证据。
   */
  async replaceActions(
    turnId: string,
    campaignId: string,
    actions: ActionRow[],
    archiveId: string,
    supersededAt: string,
  ): Promise<void> {
    const existing = await this.listAllActionsByTurn(turnId);
    const snapshotIds = new Set(actions.map((action) => action.id));
    for (const action of existing) {
      if (action.superseded_at != null || snapshotIds.has(action.id)) continue;
      await this.executor.execute(
        `UPDATE platform_actions
         SET superseded_at = ?, superseded_by_archive_id = ?
         WHERE id = ? AND turn_id = ? AND superseded_at IS NULL`,
        [supersededAt, archiveId, action.id, turnId],
      );
    }
    for (const action of actions) {
      const updated = await this.executor.execute(
        `UPDATE platform_actions
         SET turn_id = ?, campaign_id = ?, player_id = ?, actor_id = ?, body = ?, submitted_at = ?, updated_at = ?,
             superseded_at = NULL, superseded_by_archive_id = NULL
         WHERE id = ?`,
        [turnId, campaignId, action.player_id, action.actor_id ?? null, action.body, action.submitted_at, action.updated_at, action.id],
      );
      if (updated.changes === 0) {
        await this.executor.execute(
          `INSERT INTO platform_actions
             (id, turn_id, campaign_id, player_id, actor_id, body, submitted_at, updated_at,
              superseded_at, superseded_by_archive_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          [action.id, turnId, campaignId, action.player_id, action.actor_id ?? null, action.body, action.submitted_at, action.updated_at],
        );
      }
    }
  }

  /** 恢复没有 currentTurn 或切换到更早回合时，先把 watermark 之后的 action branch 一并 supersede。 */
  async supersedeActionsAfterNumber(
    campaignId: string,
    number: number,
    archiveId: string,
    supersededAt: string,
  ): Promise<void> {
    await this.executor.execute(
      `UPDATE platform_actions
       SET superseded_at = ?, superseded_by_archive_id = ?
       WHERE campaign_id = ? AND superseded_at IS NULL
         AND turn_id IN (
           SELECT id FROM platform_turns
           WHERE campaign_id = ? AND number > ?
         )`,
      [supersededAt, archiveId, campaignId, campaignId, number],
    );
  }

  async replaceRequirements(turnId: string, campaignId: string, requirements: RequirementRow[]): Promise<void> {
    await this.executor.execute('DELETE FROM platform_turn_requirements WHERE turn_id = ?', [turnId]);
    for (const requirement of requirements) {
      await this.executor.execute(
        'INSERT INTO platform_turn_requirements (turn_id, campaign_id, player_id, submitted) VALUES (?, ?, ?, ?)',
        [turnId, campaignId, requirement.player_id, requirement.submitted],
      );
    }
  }

  /** 恢复：超 watermark 的回合（number 更大）一律 supersede。setup 与 idle-after-completed 统一走本方法：
   *  setup 快照（turnNumber=0）→ 所有回合 number>0 全部 supersede（等效全量 supersede）；
   *  idle-after-completed 快照（currentTurn=null, turnNumber=N>0）→ 只 supersede number>N 的 later turns，
   *  保留 <=N 的既有 completed 历史。绝不在 null currentTurn 时从 `currentTurn===null` 推断 supersede 全部。 */
  async supersedeTurnsAfterNumber(campaignId: string, number: number, archiveId: string, now: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turns SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND number > ?',
      [now, archiveId, campaignId, number],
    );
  }
}
