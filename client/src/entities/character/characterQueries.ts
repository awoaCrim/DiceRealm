import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CharacterDraftInput } from '@dnd/contracts';
import * as characterApi from '../../api/characters/characterApi';
import { campaignCharactersKey } from '../../shared/lib/queryKeys';

/** 角色投影（我的草稿/待审/退回/批准 + owner 审核队列 + party 安全摘要）。 */
export function useCharacterProjection(campaignId?: string) {
  return useQuery({
    queryKey: campaignCharactersKey(campaignId ?? ''),
    queryFn: () => characterApi.getProjection(campaignId ?? ''),
    enabled: !!campaignId,
    retry: false,
  });
}

function useInvalidateCharacters(campaignId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: campaignCharactersKey(campaignId) });
  };
}

export function useCreateCharacter(campaignId: string) {
  const invalidate = useInvalidateCharacters(campaignId);
  return useMutation({
    mutationFn: (input: CharacterDraftInput) => characterApi.createDraft(campaignId, input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateCharacter(campaignId: string) {
  const invalidate = useInvalidateCharacters(campaignId);
  return useMutation({
    mutationFn: ({ characterId, input }: { characterId: string; input: CharacterDraftInput }) =>
      characterApi.updateDraft(campaignId, characterId, input),
    onSuccess: () => invalidate(),
  });
}

export function useSubmitCharacter(campaignId: string) {
  const invalidate = useInvalidateCharacters(campaignId);
  return useMutation({
    mutationFn: (characterId: string) => characterApi.submitForReview(campaignId, characterId),
    onSuccess: () => invalidate(),
  });
}

export function useReviewCharacter(campaignId: string) {
  const invalidate = useInvalidateCharacters(campaignId);
  return useMutation({
    mutationFn: ({ characterId, action }: { characterId: string; action: 'approve' | 'reject' }) =>
      characterApi.review(campaignId, characterId, action),
    onSuccess: () => invalidate(),
  });
}
