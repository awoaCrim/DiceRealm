import type { AiPrompt, AiProviderPublicConfig } from '@dnd/contracts';
import type { AiPreviewHooks, AiProviderPort } from './AiProviderPort.js';

export interface CampaignAiProviderResolver {
  getPublicConfig(campaignId: string): Promise<AiProviderPublicConfig>;
  resolve(campaignId: string): Promise<AiProviderPort>;
}

/**
 * Stable provider facade injected into AiResolutionService. It resolves the
 * campaign provider for every run, so a saved WebUI configuration takes effect
 * immediately without replacing the service or restarting the process.
 */
export class CampaignScopedAiProvider implements AiProviderPort {
  readonly name = 'campaign-configured';
  readonly model = 'campaign-configured';

  constructor(private readonly resolver: CampaignAiProviderResolver) {}

  async resolveForCampaign(campaignId: string): Promise<AiProviderPort> {
    return this.resolver.resolve(campaignId);
  }

  async stream(input: AiPrompt, hooks: AiPreviewHooks): Promise<unknown> {
    const provider = await this.resolveForCampaign(input.campaignId);
    return provider.stream(input, hooks);
  }
}
