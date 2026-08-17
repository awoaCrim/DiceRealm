import type { StateRevision } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor, QueryReader } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';

export interface CampaignMutationRequest {
  campaignId: string;
  expectedRevision?: number;
  mutationId: string;
  causeType: string;
  causeId?: string;
}

export interface CampaignMutationContext {
  tx: QueryExecutor;
  campaignId: string;
  previousRevision: number;
  stateRevision: number;
  mutationId: string;
  causeType: string;
  causeId?: string;
}

export interface CampaignMutationExecution<T> {
  replayed: boolean;
  result?: T;
  revision: StateRevision;
}

interface StateHeadRow { campaign_id: string; revision: number; updated_at?: string; }
interface LedgerRow { campaign_id: string; revision: number; mutation_id: string; cause_type: string; cause_id: string | null; created_at: string; }

/** One transaction seam for authoritative campaign runtime mutations. */
export class CampaignMutationCoordinator {
  constructor(private readonly database: DatabasePort) {}

  async run<T>(request: CampaignMutationRequest, work: (context: CampaignMutationContext) => Promise<T>): Promise<CampaignMutationExecution<T>> {
    validateRequest(request);
    return this.database.transaction((tx) => this.runInTransaction(tx, request, work));
  }

  /** Use from an already-open transaction (claim/formal apply/archive restore). */
  async runInTransaction<T>(tx: QueryExecutor, request: CampaignMutationRequest, work: (context: CampaignMutationContext) => Promise<T>): Promise<CampaignMutationExecution<T>> {
    validateRequest(request);
    const existing = (await tx.query<LedgerRow>(
      'SELECT campaign_id, revision, mutation_id, cause_type, cause_id, created_at FROM platform_campaign_state_revisions WHERE campaign_id = ? AND mutation_id = ?',
      [request.campaignId, request.mutationId],
    ))[0];
    if (existing) {
      if (existing.cause_type !== request.causeType || (existing.cause_id ?? undefined) !== request.causeId) {
        throw new AppError('MUTATION_REPLAY', '运行时 mutation id 已用于其它变更。');
      }
      return { replayed: true, revision: toRevision(existing) };
    }

    const head = (await tx.query<StateHeadRow>(
      'SELECT campaign_id, revision FROM platform_campaign_state_heads WHERE campaign_id = ?',
      [request.campaignId],
    ))[0];
    if (!head) throw new AppError('STATE_CONFLICT', '战役运行时状态版本不存在。');
    const previousRevision = Number(head.revision);
    const expected = request.expectedRevision;
    if (expected !== undefined && expected !== previousRevision) {
      throw new AppError('STALE_STATE_REVISION', '战役状态已变化，结果已拒绝。');
    }

    const updated = await tx.execute(
      'UPDATE platform_campaign_state_heads SET revision = revision + 1, updated_at = ? WHERE campaign_id = ? AND revision = ?',
      [new Date().toISOString(), request.campaignId, previousRevision],
    );
    if (updated.changes !== 1) throw new AppError('STALE_STATE_REVISION', '战役状态已变化，结果已拒绝。');
    const stateRevision = previousRevision + 1;
    const createdAt = new Date().toISOString();
    await tx.execute(
      `INSERT INTO platform_campaign_state_revisions
        (campaign_id, revision, mutation_id, cause_type, cause_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [request.campaignId, stateRevision, request.mutationId, request.causeType, request.causeId ?? null, createdAt],
    );
    const context: CampaignMutationContext = {
      tx,
      campaignId: request.campaignId,
      previousRevision,
      stateRevision,
      mutationId: request.mutationId,
      causeType: request.causeType,
      causeId: request.causeId,
    };
    const result = await work(context);
    return {
      replayed: false,
      result,
      revision: {
        campaignId: request.campaignId,
        revision: stateRevision,
        mutationId: request.mutationId,
        causeType: request.causeType,
        ...(request.causeId ? { causeId: request.causeId } : {}),
        createdAt,
      },
    };
  }

  async mutate<T>(request: CampaignMutationRequest, work: (context: CampaignMutationContext) => Promise<T>): Promise<CampaignMutationExecution<T>> {
    return this.run(request, work);
  }

  /** Compatibility seam for services that already own the surrounding transaction. */
  async mutateIn<T>(tx: QueryExecutor, request: CampaignMutationRequest, work: (context: CampaignMutationContext) => Promise<T>): Promise<CampaignMutationExecution<T>> {
    return this.runInTransaction(tx, request, work);
  }

  /**
   * Return the current revision when all changes after a claim are explicitly
   * known to be input-only. Action submissions may arrive while a Provider is
   * running; they must not invalidate that Decision's world-state snapshot.
   * Any other intervening mutation remains a hard stale-state conflict.
   */
  async latestCompatibleRevisionIn(
    tx: QueryReader,
    campaignId: string,
    baseRevision: number,
    allowedCauseTypes: readonly string[],
  ): Promise<number> {
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      throw new AppError('VALIDATION_ERROR', '基础运行时状态版本无效。');
    }
    const head = (await tx.query<StateHeadRow>(
      'SELECT campaign_id, revision FROM platform_campaign_state_heads WHERE campaign_id = ?',
      [campaignId],
    ))[0];
    if (!head) throw new AppError('STATE_CONFLICT', '战役运行时状态版本不存在。');
    const currentRevision = Number(head.revision);
    if (baseRevision > currentRevision) {
      throw new AppError('STALE_STATE_REVISION', '战役状态版本无效。');
    }
    if (baseRevision === currentRevision) return currentRevision;
    const allowed = new Set(allowedCauseTypes);
    const intervening = await tx.query<{ cause_type: string }>(
      `SELECT cause_type FROM platform_campaign_state_revisions
       WHERE campaign_id = ? AND revision > ? ORDER BY revision ASC`,
      [campaignId, baseRevision],
    );
    if (intervening.some((revision) => !allowed.has(revision.cause_type))) {
      throw new AppError('STALE_STATE_REVISION', '战役状态已发生不兼容变化。');
    }
    return currentRevision;
  }

  async current(campaignId: string): Promise<StateRevision | null> {
    const rows = await this.database.query<StateHeadRow>(
      'SELECT campaign_id, revision, updated_at FROM platform_campaign_state_heads WHERE campaign_id = ?', [campaignId],
    );
    const row = rows[0];
    return row ? {
      campaignId: row.campaign_id,
      revision: Number(row.revision),
      mutationId: 'head',
      causeType: 'head',
      createdAt: row.updated_at ?? new Date(0).toISOString(),
    } : null;
  }
}

function validateRequest(request: CampaignMutationRequest): void {
  if (!request.campaignId || !request.mutationId || !request.causeType.trim()
    || (request.causeId !== undefined && !request.causeId)) {
    throw new AppError('VALIDATION_ERROR', '运行时 mutation contract 无效。');
  }
  if (request.expectedRevision !== undefined && (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0)) {
    throw new AppError('VALIDATION_ERROR', 'expected state revision 无效。');
  }
}

function toRevision(row: LedgerRow): StateRevision {
  return {
    campaignId: row.campaign_id,
    revision: Number(row.revision),
    mutationId: row.mutation_id,
    causeType: row.cause_type,
    ...(row.cause_id ? { causeId: row.cause_id } : {}),
    createdAt: row.created_at,
  };
}
