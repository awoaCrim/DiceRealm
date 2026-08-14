import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { RuleSourceScope } from '@dnd/contracts';

export interface RuleSourceRow {
  id: string;
  source_name: string;
  version: string;
  license: string;
  attribution: string;
  content_hash: string;
  scope: RuleSourceScope;
  campaign_id: string | null;
  user_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

/** Persistence adapter for the immutable rule-source metadata registry. */
export class RulesRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insert(row: RuleSourceRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_rule_sources
        (id, source_name, version, license, attribution, content_hash, scope, campaign_id, user_id, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.source_name, row.version, row.license, row.attribution,
        row.content_hash, row.scope, row.campaign_id, row.user_id,
        row.created_by_user_id, row.created_at,
      ],
    );
  }

  /** Platform + this campaign + this owner-user sources form the effective registry view. */
  async listEffective(campaignId: string, userId: string): Promise<RuleSourceRow[]> {
    return this.executor.query<RuleSourceRow>(
      `SELECT * FROM platform_rule_sources
       WHERE scope = 'platform'
          OR (scope = 'campaign' AND campaign_id = ?)
          OR (scope = 'user' AND user_id = ?)
       ORDER BY source_name ASC, version ASC, created_at ASC, id ASC`,
      [campaignId, userId],
    );
  }
}
