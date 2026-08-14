import type { CombatCommand, Encounter, StartEncounterInput } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import {
  encounterEnvelopeSchema,
  encounterListEnvelopeSchema,
} from '../../shared/lib/contractSchemas';

export async function list(campaignId: string): Promise<Encounter[]> {
  const { encounters } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/combat`,
    { responseSchema: encounterListEnvelopeSchema },
  );
  return encounters;
}

export async function get(campaignId: string, encounterId: string): Promise<Encounter> {
  const { encounter } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/combat/${encodeURIComponent(encounterId)}`,
    { responseSchema: encounterEnvelopeSchema },
  );
  return encounter;
}

export async function start(campaignId: string, input: StartEncounterInput): Promise<Encounter> {
  const { encounter } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/combat`,
    { method: 'POST', body: input, responseSchema: encounterEnvelopeSchema },
  );
  return encounter;
}

export async function executeCommand(
  campaignId: string,
  encounterId: string,
  command: CombatCommand,
): Promise<Encounter> {
  const { encounter } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/combat/${encodeURIComponent(encounterId)}/commands`,
    { method: 'POST', body: command, responseSchema: encounterEnvelopeSchema },
  );
  return encounter;
}
