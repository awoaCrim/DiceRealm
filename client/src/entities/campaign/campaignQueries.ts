import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateCampaignInput } from '@dnd/contracts';
import * as campaignApi from '../../api/campaigns/campaignApi';

export const campaignListKey = ['campaigns'] as const;

export function campaignDetailKey(campaignId: string) {
  return ['campaign', campaignId, 'detail'] as const;
}

export function useCampaignList() {
  return useQuery({
    queryKey: campaignListKey,
    queryFn: campaignApi.list,
  });
}

export function useCampaignDetail(campaignId?: string) {
  return useQuery({
    queryKey: campaignDetailKey(campaignId ?? ''),
    queryFn: () => campaignApi.get(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
    staleTime: 30_000,
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCampaignInput) => campaignApi.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignListKey });
    },
  });
}

export function useJoinCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, code }: { campaignId: string; code: string }) =>
      campaignApi.join(campaignId, code),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignListKey });
    },
  });
}
