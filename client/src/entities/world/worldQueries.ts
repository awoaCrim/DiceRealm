import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorldFactInput } from '@dnd/contracts';
import * as worldApi from '../../api/world/worldApi';
import { campaignWorldKey } from '../../shared/lib/queryKeys';

/** 世界事实投影（owner 全量 / player 已投影）。 */
export function useWorldProjection(campaignId?: string) {
  return useQuery({
    queryKey: campaignWorldKey(campaignId ?? ''),
    queryFn: () => worldApi.getProjection(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

export function useCreateWorldFact(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WorldFactInput) => worldApi.create(campaignId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignWorldKey(campaignId) });
    },
  });
}

export function useUpdateWorldFact(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ factId, input }: { factId: string; input: WorldFactInput }) =>
      worldApi.update(campaignId, factId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignWorldKey(campaignId) });
    },
  });
}

export function useDeleteWorldFact(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (factId: string) => worldApi.remove(campaignId, factId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignWorldKey(campaignId) });
    },
  });
}
