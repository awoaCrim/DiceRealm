import type {
  AiProviderConfigInput,
  AiProviderPublicConfig,
  AiProviderTestResult,
  AiRunDetail,
  AiRunView,
  TurnEntry,
} from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import {
  aiRunDetailEnvelopeSchema,
  aiRunEnvelopeSchema,
  aiRunHistoryEnvelopeSchema,
  aiRunListEnvelopeSchema,
  aiProviderStatusEnvelopeSchema,
  aiProviderTestResultEnvelopeSchema,
  turnEntryListEnvelopeSchema,
} from '../../shared/lib/contractSchemas';

export async function resolveTurn(
  campaignId: string,
  turnId: string,
  idempotencyKey: string,
): Promise<AiRunView> {
  const { run } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/turns/${encodeURIComponent(turnId)}/runs`,
    { method: 'POST', body: { idempotencyKey }, responseSchema: aiRunEnvelopeSchema },
  );
  return run;
}

export async function getProviderStatus(campaignId: string): Promise<AiProviderPublicConfig> {
  const { provider } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/provider-status`,
    { responseSchema: aiProviderStatusEnvelopeSchema },
  );
  return provider;
}

export async function saveProviderConfig(campaignId: string, input: AiProviderConfigInput): Promise<AiProviderPublicConfig> {
  const { provider } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/provider-config`,
    { method: 'PUT', body: input, responseSchema: aiProviderStatusEnvelopeSchema },
  );
  return provider;
}

export async function testProviderConfig(campaignId: string, input: AiProviderConfigInput): Promise<AiProviderTestResult> {
  return platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/provider-config/test`,
    { method: 'POST', body: input, responseSchema: aiProviderTestResultEnvelopeSchema },
  );
}

export async function listCampaignRuns(campaignId: string): Promise<AiRunView[]> {
  const { runs } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/runs`,
    { responseSchema: aiRunHistoryEnvelopeSchema },
  );
  return runs;
}

export async function listRuns(campaignId: string, turnId: string): Promise<AiRunView[]> {
  const { runs } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/turns/${encodeURIComponent(turnId)}/runs`,
    { responseSchema: aiRunListEnvelopeSchema },
  );
  return runs;
}

export async function getRunDetail(campaignId: string, runId: string): Promise<AiRunDetail> {
  const { run } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/runs/${encodeURIComponent(runId)}`,
    { responseSchema: aiRunDetailEnvelopeSchema },
  );
  return run;
}

export async function listEntries(campaignId: string, turnId: string): Promise<TurnEntry[]> {
  const { entries } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/ai/turns/${encodeURIComponent(turnId)}/entries`,
    { responseSchema: turnEntryListEnvelopeSchema },
  );
  return entries;
}
