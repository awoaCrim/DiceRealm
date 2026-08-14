import type { TurnListEntry, TurnSummary } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import {
  turnListEnvelopeSchema,
  turnSummaryEnvelopeSchema,
  turnViewEnvelopeSchema,
} from '../../shared/lib/contractSchemas';

export async function list(campaignId: string): Promise<TurnListEntry[]> {
  const { turns } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/turns`,
    { responseSchema: turnListEnvelopeSchema },
  );
  return turns;
}

export async function startTurn(campaignId: string): Promise<TurnSummary> {
  const { turn } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/turns`,
    { method: 'POST', responseSchema: turnSummaryEnvelopeSchema },
  );
  return turn;
}

/** owner → actions 全量；player → 只有自己的 myAction（服务端投影）。 */
export async function getView(campaignId: string, turnId: string) {
  const { view } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/turns/${encodeURIComponent(turnId)}`,
    { responseSchema: turnViewEnvelopeSchema },
  );
  return view;
}

export async function submitAction(campaignId: string, turnId: string, body: string) {
  const { view } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/turns/${encodeURIComponent(turnId)}/actions`,
    { method: 'POST', body: { body }, responseSchema: turnViewEnvelopeSchema },
  );
  return view;
}
