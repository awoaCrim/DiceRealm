import { nanoid } from 'nanoid';
import type {
  RuleSource,
  RuleSourceRegistrationInput,
} from '@dnd/contracts';
import { ruleSourceContentHashSchema } from '@dnd/contracts';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { RulesRepository, type RuleSourceRow } from './RulesRepository.js';

export interface PlatformRuleSourceInput {
  sourceName: string;
  version: string;
  license: string;
  attribution: string;
  contentHash: string;
}

/**
 * Rules module interface: register one immutable provenance record and list the
 * effective metadata registry. It owns validation, dedup error mapping, scope
 * targeting, and the hard "no rule body" storage boundary.
 */
export class RulesService {
  private readonly repository: RulesRepository;

  constructor(private readonly executor: DatabasePort) {
    this.repository = new RulesRepository(executor);
  }

  async listForOwner(ctx: CampaignAuthContext): Promise<RuleSource[]> {
    requireOwner(ctx);
    return (await this.repository.listEffective(ctx.campaignId, ctx.userId)).map(mapRuleSource);
  }

  async register(ctx: CampaignAuthContext, input: RuleSourceRegistrationInput): Promise<RuleSource> {
    requireOwner(ctx);
    const normalized = normalizeMetadata(input);
    const row: RuleSourceRow = {
      id: nanoid(24),
      source_name: normalized.sourceName,
      version: normalized.version,
      license: normalized.license,
      attribution: normalized.attribution,
      content_hash: normalized.contentHash,
      scope: input.scope,
      campaign_id: input.scope === 'campaign' ? ctx.campaignId : null,
      user_id: input.scope === 'user' ? ctx.userId : null,
      created_by_user_id: ctx.userId,
      created_at: new Date().toISOString(),
    };
    await this.insertOrInvalid(row);
    return mapRuleSource(row);
  }

  /** Trusted composition/seed interface only; campaign HTTP never exposes platform scope. */
  async registerPlatform(input: PlatformRuleSourceInput): Promise<RuleSource> {
    const normalized = normalizeMetadata(input);
    const row: RuleSourceRow = {
      id: nanoid(24),
      source_name: normalized.sourceName,
      version: normalized.version,
      license: normalized.license,
      attribution: normalized.attribution,
      content_hash: normalized.contentHash,
      scope: 'platform',
      campaign_id: null,
      user_id: null,
      created_by_user_id: null,
      created_at: new Date().toISOString(),
    };
    await this.insertOrInvalid(row);
    return mapRuleSource(row);
  }

  private async insertOrInvalid(row: RuleSourceRow): Promise<void> {
    try {
      await this.repository.insert(row);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new AppError('INVALID_RULE_SOURCE', '规则来源元数据无效或已登记。');
      }
      throw error;
    }
  }
}

function normalizeMetadata(input: PlatformRuleSourceInput): PlatformRuleSourceInput {
  const sourceName = input.sourceName.trim();
  const version = input.version.trim();
  const license = input.license.trim();
  const attribution = input.attribution.trim();
  const contentHash = input.contentHash.trim().toLowerCase();
  if (!sourceName || !version || !license || !attribution || !ruleSourceContentHashSchema.safeParse(contentHash).success) {
    throw new AppError('INVALID_RULE_SOURCE', '规则来源必须包含来源、版本、许可证、署名与有效的 SHA-256 哈希。');
  }
  return { sourceName, version, license, attribution, contentHash };
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: string };
  return candidate.code?.startsWith('SQLITE_CONSTRAINT') === true
    || candidate.code === '23505'
    || candidate.code === '23514';
}

function mapRuleSource(row: RuleSourceRow): RuleSource {
  return {
    id: row.id,
    sourceName: row.source_name,
    version: row.version,
    license: row.license,
    attribution: row.attribution,
    contentHash: row.content_hash,
    scope: row.scope,
    campaignId: row.campaign_id,
    createdAt: row.created_at,
  };
}
