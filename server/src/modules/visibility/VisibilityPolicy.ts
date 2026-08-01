import type { Visibility } from '@dnd/contracts';

export interface VisibilitySubject {
  role: 'owner' | 'player';
  playerId: string | null;
}

/** 唯一可见性规则：owner 全量；player 只见 public + 自己 knownBy 的 player_private；owner_only 永不外泄。 */
export function canRead(
  subject: VisibilitySubject,
  visibility: Visibility,
  knownBy: string[],
): boolean {
  if (subject.role === 'owner') {
    return true;
  }
  if (visibility === 'public') {
    return true;
  }
  if (visibility === 'player_private') {
    return subject.playerId != null && knownBy.includes(subject.playerId);
  }
  return false;
}
