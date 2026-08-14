import type {
  AiProviderConfigInput,
  AiProviderPublicConfig,
} from '@dnd/contracts';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { requestOpenAiCompatibleMessage } from './OpenAiCompatibleTransport.js';
import {
  DEFAULT_AI_PROVIDER_TEMPERATURE,
  DEFAULT_AI_PROVIDER_TIMEOUT_MS,
} from '../../config.js';
import type { AiProviderPort } from './AiProviderPort.js';
import type { AiProviderEnvConfig } from '../../config.js';
import { createAiProviderFromConfig } from './createAiProvider.js';
import { CredentialCipher } from './CredentialCipher.js';
import {
  AiProviderConfigRepository,
  toCampaignProviderPublicConfig,
} from './AiProviderConfigRepository.js';
import type { CampaignAiProviderResolver } from './CampaignScopedAiProvider.js';
import { assertSafeProviderUrl } from './ProviderUrlPolicy.js';

export interface AiProviderConfigServiceOptions {
  fallbackProvider: AiProviderPort;
  credentialCipher?: CredentialCipher;
  fetchImpl?: typeof fetch;
  /** test-only seam for deterministic saved-provider behavior. Production uses the real factory. */
  providerFactory?: (config: AiProviderEnvConfig, fetchImpl?: typeof fetch) => AiProviderPort;
}

/**
 * Campaign Provider configuration seam: owner-only mutation/testing, encrypted
 * persistence and dynamic provider resolution. API keys leave this module only
 * as an Authorization header or as authenticated ciphertext.
 */
export class AiProviderConfigService implements CampaignAiProviderResolver {
  private readonly fallbackProvider: AiProviderPort;
  private readonly cipher?: CredentialCipher;
  private readonly fetchImpl?: typeof fetch;
  private readonly providerFactory: (config: AiProviderEnvConfig, fetchImpl?: typeof fetch) => AiProviderPort;

  constructor(
    private readonly db: DatabasePort,
    options: AiProviderConfigServiceOptions,
  ) {
    this.fallbackProvider = options.fallbackProvider;
    this.cipher = options.credentialCipher;
    this.fetchImpl = options.fetchImpl;
    this.providerFactory = options.providerFactory ?? createAiProviderFromConfig;
  }

  async getForOwner(ctx: CampaignAuthContext): Promise<AiProviderPublicConfig> {
    requireOwner(ctx);
    return this.getPublicConfig(ctx.campaignId);
  }

  async getPublicConfig(campaignId: string): Promise<AiProviderPublicConfig> {
    const row = await new AiProviderConfigRepository(this.db).findByCampaign(campaignId);
    if (row) return toCampaignProviderPublicConfig(row);
    return publicFallback(this.fallbackProvider);
  }

  async save(ctx: CampaignAuthContext, input: AiProviderConfigInput): Promise<AiProviderPublicConfig> {
    requireOwner(ctx);
    const cipher = this.requireCipher();
    const existing = await new AiProviderConfigRepository(this.db).findByCampaign(ctx.campaignId);
    this.requireExplicitKeyForEndpointChange(input, existing);
    await this.assertSafeUrl(input.baseUrl);
    const apiKey = this.resolveApiKey(input.apiKey, existing?.encrypted_api_key ?? null, cipher);
    const encryptedApiKey = cipher.encrypt(apiKey);
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await new AiProviderConfigRepository(tx).upsert({
        campaign_id: ctx.campaignId,
        provider: input.provider,
        base_url: input.baseUrl,
        model: input.model,
        encrypted_api_key: encryptedApiKey,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
    });
    return {
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      configured: true,
      apiKeyConfigured: true,
      source: 'campaign',
    };
  }

  async test(ctx: CampaignAuthContext, input: AiProviderConfigInput): Promise<void> {
    requireOwner(ctx);
    const existing = await new AiProviderConfigRepository(this.db).findByCampaign(ctx.campaignId);
    this.requireExplicitKeyForEndpointChange(input, existing);
    await this.assertSafeUrl(input.baseUrl);
    const apiKey = this.resolveApiKey(input.apiKey, existing?.encrypted_api_key ?? null, this.cipher);
    try {
      await requestOpenAiCompatibleMessage(
        { baseUrl: input.baseUrl, model: input.model, apiKey },
        [
          { role: 'system', content: 'You are testing whether this model endpoint responds.' },
          { role: 'user', content: 'Reply with ok.' },
        ],
        { timeoutMs: 15_000, temperature: 0 },
        this.fetchImpl ?? fetch,
      );
    } catch {
      // Upstream response bodies, URLs and credentials must never enter HTTP errors.
      throw new AppError('AI_PROVIDER_FAILED', 'AI Provider 连接测试失败。');
    }
  }

  async resolve(campaignId: string): Promise<AiProviderPort> {
    const row = await new AiProviderConfigRepository(this.db).findByCampaign(campaignId);
    if (!row) return this.fallbackProvider;
    const cipher = this.requireCipher();
    const apiKey = cipher.decrypt(row.encrypted_api_key);
    await this.assertSafeUrl(row.base_url);
    return this.providerFactory({
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      apiKey,
      timeoutMs: DEFAULT_AI_PROVIDER_TIMEOUT_MS,
      temperature: DEFAULT_AI_PROVIDER_TEMPERATURE,
    }, this.fetchImpl);
  }

  private requireExplicitKeyForEndpointChange(
    input: AiProviderConfigInput,
    existing: Awaited<ReturnType<AiProviderConfigRepository['findByCampaign']>>,
  ): void {
    if (existing && !input.apiKey.trim() && normalizeEndpoint(existing.base_url) !== normalizeEndpoint(input.baseUrl)) {
      throw new AppError('VALIDATION_ERROR', '修改 API 地址时必须重新填写 API Key。');
    }
  }

  private async assertSafeUrl(baseUrl: string): Promise<void> {
    await assertSafeProviderUrl(baseUrl);
  }

  private resolveApiKey(apiKey: string, encryptedExisting: string | null, cipher: CredentialCipher | undefined): string {
    if (apiKey.trim()) return apiKey;
    if (!encryptedExisting) {
      throw new AppError('VALIDATION_ERROR', '首次配置必须填写 API Key。');
    }
    if (!cipher) {
      throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', '服务器凭证加密暂不可用。');
    }
    return cipher.decrypt(encryptedExisting);
  }

  private requireCipher(): CredentialCipher {
    if (!this.cipher) {
      throw new AppError('CREDENTIAL_ENCRYPTION_UNAVAILABLE', '服务器凭证加密暂不可用。');
    }
    return this.cipher;
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

function publicFallback(provider: AiProviderPort): AiProviderPublicConfig {
  const config = provider.publicConfig;
  if (config) {
    return {
      ...config,
      apiKeyConfigured: config.apiKeyConfigured ?? config.configured,
      source: config.source ?? (config.configured ? 'environment' : 'unavailable'),
    };
  }
  return {
    provider: provider.name === 'openai-compatible' ? 'openai-compatible' : 'unavailable',
    baseUrl: '',
    model: provider.model,
    configured: provider.name === 'openai-compatible',
    apiKeyConfigured: provider.name === 'openai-compatible',
    source: provider.name === 'openai-compatible' ? 'environment' : 'unavailable',
  };
}
