import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as archiveApi from '../../api/archives/archiveApi';
import { campaignArchivesKey, campaignQueryPrefix, campaignTurnsKey } from '../../shared/lib/queryKeys';

/** 存档列表。 */
export function useArchiveList(campaignId?: string) {
  return useQuery({
    queryKey: campaignArchivesKey(campaignId ?? ''),
    queryFn: () => archiveApi.list(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

export function useCreateManualArchive(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => archiveApi.createManual(campaignId, label),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignArchivesKey(campaignId) });
    },
  });
}

export function useRestoreArchive(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archiveId: string) => archiveApi.restore(campaignId, archiveId),
    onSuccess: async () => {
      // 回档常从存档页触发；明确等待 turns 刷新，避免其它页面继续使用
      // 回档前的当前回合缓存。
      await queryClient.invalidateQueries({ queryKey: campaignTurnsKey(campaignId) });
      await queryClient.invalidateQueries({ queryKey: campaignQueryPrefix(campaignId) });
      await queryClient.invalidateQueries({ queryKey: campaignArchivesKey(campaignId) });
    },
  });
}
