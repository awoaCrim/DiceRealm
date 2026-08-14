import type { Archive, ArchiveRestoreResult } from '@dnd/contracts';
import { platformRequest } from '../../shared/api/platformHttp';
import {
  archiveEnvelopeSchema,
  archiveListEnvelopeSchema,
  archiveRestoreEnvelopeSchema,
} from '../../shared/lib/contractSchemas';

export async function list(campaignId: string): Promise<Archive[]> {
  const { archives } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/archives`,
    { responseSchema: archiveListEnvelopeSchema },
  );
  return archives;
}

export async function createManual(campaignId: string, label: string): Promise<Archive> {
  const { archive } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/archives`,
    { method: 'POST', body: { label }, responseSchema: archiveEnvelopeSchema },
  );
  return archive;
}

/** restore 响应是 { result } 包装：正确解析内层 shape。 */
export async function restore(campaignId: string, archiveId: string): Promise<ArchiveRestoreResult> {
  const { result } = await platformRequest(
    `/api/campaigns/${encodeURIComponent(campaignId)}/archives/${encodeURIComponent(archiveId)}/restore`,
    { method: 'POST', responseSchema: archiveRestoreEnvelopeSchema },
  );
  return result;
}
