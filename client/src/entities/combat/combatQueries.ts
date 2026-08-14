import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CombatCommand, StartEncounterInput } from '@dnd/contracts';
import * as combatApi from '../../api/combat/combatApi';
import { campaignCombatDetailKey, campaignCombatKey } from '../../shared/lib/queryKeys';

/** 战斗列表（服务端按 viewer 投影 combatants）。 */
export function useEncounterList(campaignId?: string) {
  return useQuery({
    queryKey: campaignCombatKey(campaignId ?? ''),
    queryFn: () => combatApi.list(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

export function useEncounter(campaignId?: string, encounterId?: string) {
  return useQuery({
    queryKey: campaignCombatDetailKey(campaignId ?? '', encounterId ?? ''),
    queryFn: () => combatApi.get(campaignId ?? '', encounterId ?? ''),
    enabled: !!campaignId && !!encounterId,
    retry: false,
  });
}

export function useStartEncounter(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartEncounterInput) => combatApi.start(campaignId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignCombatKey(campaignId) });
    },
  });
}

export function useCombatCommand(campaignId: string, encounterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: CombatCommand) => combatApi.executeCommand(campaignId, encounterId, command),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignCombatKey(campaignId) });
      void queryClient.invalidateQueries({ queryKey: campaignCombatDetailKey(campaignId, encounterId) });
    },
  });
}
