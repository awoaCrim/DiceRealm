import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as aiApi from '../../api/ai/aiApi';
import { campaignAiRunHistoryKey, campaignAiRunKey, campaignAiRunsKey, campaignEntriesKey } from '../../shared/lib/queryKeys';

export function useAiProviderStatus(campaignId?: string) {
  return useQuery({
    queryKey: ['campaign', campaignId ?? '', 'ai-provider-status'],
    queryFn: () => aiApi.getProviderStatus(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

export function useCampaignAiRuns(campaignId?: string) {
  return useQuery({
    queryKey: campaignAiRunHistoryKey(campaignId ?? ''),
    queryFn: () => aiApi.listCampaignRuns(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

export function useAiRuns(campaignId?: string, turnId?: string) {
  return useQuery({
    queryKey: campaignAiRunsKey(campaignId ?? '', turnId ?? ''),
    queryFn: () => aiApi.listRuns(campaignId ?? '', turnId ?? ''),
    enabled: !!campaignId && !!turnId,
    retry: false,
  });
}

/** AI run 详情（owner-only：含 context/result/rawDebug，仅显式展开时请求）。 */
export function useAiRunDetail(campaignId?: string, runId?: string) {
  return useQuery({
    queryKey: campaignAiRunKey(campaignId ?? '', runId ?? ''),
    queryFn: () => aiApi.getRunDetail(campaignId ?? '', runId ?? ''),
    enabled: !!campaignId && !!runId,
    retry: false,
  });
}

/** turn entries（owner 全量 / player 投影，服务端处理）。 */
export function useTurnEntries(campaignId?: string, turnId?: string) {
  return useQuery({
    queryKey: campaignEntriesKey(campaignId ?? '', turnId ?? ''),
    queryFn: () => aiApi.listEntries(campaignId ?? '', turnId ?? ''),
    enabled: !!campaignId && !!turnId,
    retry: false,
  });
}

export function useResolveTurn(campaignId: string, turnId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (idempotencyKey: string) => aiApi.resolveTurn(campaignId, turnId, idempotencyKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignAiRunsKey(campaignId, turnId) });
    },
  });
}
