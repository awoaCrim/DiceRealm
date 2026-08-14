import type { CharacterDraftInput, CharacterProjection } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import {
  characterDraftEnvelopeSchema,
  characterProjectionEnvelopeSchema,
  characterReviewEnvelopeSchema,
  characterReviewResultEnvelopeSchema,
} from '../../shared/lib/contractSchemas';

export async function getProjection(campaignId: string): Promise<CharacterProjection> {
  const { projection } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/characters`,
    { responseSchema: characterProjectionEnvelopeSchema },
  );
  return projection;
}

export async function createDraft(campaignId: string, input: CharacterDraftInput) {
  const { character } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/characters`,
    { method: 'POST', body: input, responseSchema: characterDraftEnvelopeSchema },
  );
  return character;
}

export async function updateDraft(campaignId: string, characterId: string, input: CharacterDraftInput) {
  const { character } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/characters/${encodeURIComponent(characterId)}`,
    { method: 'PUT', body: input, responseSchema: characterDraftEnvelopeSchema },
  );
  return character;
}

export async function submitForReview(campaignId: string, characterId: string) {
  const { character } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/characters/${encodeURIComponent(characterId)}/submit`,
    { method: 'POST', responseSchema: characterReviewEnvelopeSchema },
  );
  return character;
}

export async function review(campaignId: string, characterId: string, action: 'approve' | 'reject') {
  const { character } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/characters/${encodeURIComponent(characterId)}/review`,
    { method: 'POST', body: { action }, responseSchema: characterReviewResultEnvelopeSchema },
  );
  return character;
}
