import type { WorldFact, WorldFactInput, WorldFactProjection } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import { noContentSchema, worldFactEnvelopeSchema, worldProjectionEnvelopeSchema } from '../../shared/lib/contractSchemas';

export async function getProjection(campaignId: string): Promise<WorldFactProjection> {
  const { projection } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/world`,
    { responseSchema: worldProjectionEnvelopeSchema },
  );
  return projection;
}

export async function create(campaignId: string, input: WorldFactInput): Promise<WorldFact> {
  const { fact } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/world`,
    { method: 'POST', body: input, responseSchema: worldFactEnvelopeSchema },
  );
  return fact;
}

export async function update(campaignId: string, factId: string, input: WorldFactInput): Promise<WorldFact> {
  const { fact } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/world/${encodeURIComponent(factId)}`,
    { method: 'PUT', body: input, responseSchema: worldFactEnvelopeSchema },
  );
  return fact;
}

export async function remove(campaignId: string, factId: string): Promise<void> {
  // DELETE 返回 204 无响应体。
  await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/world/${encodeURIComponent(factId)}`,
    { method: 'DELETE', responseSchema: noContentSchema },
  );
}
