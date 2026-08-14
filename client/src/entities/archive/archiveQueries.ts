import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as archiveApi from '../../api/archives/archiveApi';
import { campaignArchivesKey } from '../../shared/lib/queryKeys';

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
    onSuccess: () => {
      // archive.restored 事件会全前缀失效；mutation 成功路径也做双保险。
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
    },
  });
}
