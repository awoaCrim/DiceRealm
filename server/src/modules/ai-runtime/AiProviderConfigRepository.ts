import type { AiProviderPublicConfig } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface AiProviderConfigRow {
  campaign_id: string;
  provider: 'openai-compatible';
  base_url: string;
  model: string;
  encrypted_api_key: string;
  created_at: string;
  updated_at: string;
}

export class AiProviderConfigRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async findByCampaign(campaignId: string): Promise<AiProviderConfigRow | null> {
    const rows = await this.executor.query<AiProviderConfigRow>(
      `SELECT campaign_id, provider, base_url, model, encrypted_api_key, created_at, updated_at
         FROM platform_ai_provider_configs
        WHERE campaign_id = ?`,
      [campaignId],
    );
    return rows[0] ?? null;
  }

  async upsert(row: AiProviderConfigRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_ai_provider_configs
        (campaign_id, provider, base_url, model, encrypted_api_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (campaign_id) DO UPDATE SET
         provider = excluded.provider,
         base_url = excluded.base_url,
         model = excluded.model,
         encrypted_api_key = excluded.encrypted_api_key,
         updated_at = excluded.updated_at`,
      [row.campaign_id, row.provider, row.base_url, row.model, row.encrypted_api_key, row.created_at, row.updated_at],
    );
  }
}

export function toCampaignProviderPublicConfig(row: AiProviderConfigRow): AiProviderPublicConfig {
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    configured: true,
    apiKeyConfigured: true,
    source: 'campaign',
  };
}
