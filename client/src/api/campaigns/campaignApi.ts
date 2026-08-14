import type { CampaignMember, CampaignSummary, CampaignView, CreateCampaignInput, CreateCampaignResult } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import {
  campaignDetailEnvelopeSchema,
  campaignListEnvelopeSchema,
  createCampaignEnvelopeSchema,
  joinEnvelopeSchema,
} from '../../shared/lib/contractSchemas';

export async function list(): Promise<CampaignSummary[]> {
  const { campaigns } = await platformRequest('/api/campaigns', {
    responseSchema: campaignListEnvelopeSchema,
  });
  return campaigns;
}

export async function get(campaignId: string): Promise<CampaignView> {
  return platformRequest(`/api/campaigns/${encodeURIComponent(campaignId)}`, {
    responseSchema: campaignDetailEnvelopeSchema,
  });
}

export async function create(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  return platformRequest('/api/campaigns', {
    method: 'POST',
    body: input,
    responseSchema: createCampaignEnvelopeSchema,
  });
}

export async function join(campaignId: string, inviteCode: string): Promise<CampaignMember> {
  const { member } = await platformRequest(`/api/campaigns/${encodeURIComponent(campaignId)}/join`, {
    method: 'POST',
    body: { inviteCode },
    responseSchema: joinEnvelopeSchema,
  });
  return member;
}
