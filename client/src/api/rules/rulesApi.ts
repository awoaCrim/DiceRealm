import type { RuleSource, RuleSourceRegistrationInput } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import { ruleSourceEnvelopeSchema, ruleSourceListEnvelopeSchema } from '../../shared/lib/contractSchemas';

export async function list(campaignId: string): Promise<RuleSource[]> {
  const { sources } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/rules/sources`,
    { responseSchema: ruleSourceListEnvelopeSchema },
  );
  return sources;
}

export async function register(campaignId: string, input: RuleSourceRegistrationInput): Promise<RuleSource> {
  const { source } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/rules/sources`,
    { method: 'POST', body: input, responseSchema: ruleSourceEnvelopeSchema },
  );
  return source;
}
