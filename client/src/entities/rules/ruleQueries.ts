import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RuleSourceRegistrationInput } from '@dnd/contracts';
import * as rulesApi from '../../api/rules/rulesApi';
import { campaignRuleSourcesKey } from '../../shared/lib/queryKeys';

export function useRuleSources(campaignId?: string) {
  return useQuery({
    queryKey: campaignRuleSourcesKey(campaignId ?? ''),
    queryFn: () => rulesApi.list(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

export function useRegisterRuleSource(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RuleSourceRegistrationInput) => rulesApi.register(campaignId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignRuleSourcesKey(campaignId) });
    },
  });
}
