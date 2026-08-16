import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TurnListEntry } from '@dnd/contracts';
import * as turnApi from '../../api/turns/turnApi';
import { campaignTurnKey, campaignTurnsKey } from '../../shared/lib/queryKeys';

/** Select the active turn by domain sequence rather than response array position. */
export function currentTurnEntry(entries: readonly TurnListEntry[]): TurnListEntry | undefined {
  return entries.reduce<TurnListEntry | undefined>(
    (current, entry) => !current || entry.turn.number > current.turn.number ? entry : current,
    undefined,
  );
}

/** 回合列表（owner/player 均可读；不含 action 正文）。 */
export function useTurnList(campaignId?: string) {
  return useQuery({
    queryKey: campaignTurnsKey(campaignId ?? ''),
    queryFn: () => turnApi.list(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

/** 回合视图：owner 全量 actions；player 只有 myAction（服务端投影）。 */
export function useTurnView(campaignId?: string, turnId?: string) {
  return useQuery({
    queryKey: campaignTurnKey(campaignId ?? '', turnId ?? ''),
    queryFn: () => turnApi.getView(campaignId ?? '', turnId ?? ''),
    enabled: !!campaignId && !!turnId,
    retry: false,
  });
}

export function useStartTurn(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => turnApi.startTurn(campaignId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignTurnsKey(campaignId) });
    },
  });
}

export function useSubmitAction(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ turnId, body }: { turnId: string; body: string }) =>
      turnApi.submitAction(campaignId, turnId, body),
    onSuccess: (_view, { turnId }) => {
      void queryClient.invalidateQueries({ queryKey: campaignTurnsKey(campaignId) });
      void queryClient.invalidateQueries({ queryKey: campaignTurnKey(campaignId, turnId) });
    },
  });
}
