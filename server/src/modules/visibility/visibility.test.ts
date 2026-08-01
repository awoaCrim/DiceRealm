import { describe, expect, it } from 'vitest';
import { ProjectionService, type ProjectableState } from './ProjectionService.js';

describe('visibility policy', () => {
  const service = new ProjectionService();

  it('does not expose another player private fact', () => {
    const full: ProjectableState = {
      facts: [
        { id: 'f-public', visibility: 'public', knownBy: [] },
        { id: 'f-private', visibility: 'player_private', knownBy: ['player-a'] },
        { id: 'f-owner', visibility: 'owner_only', knownBy: [] },
      ],
    };
    expect(service.projectFacts({ role: 'player', playerId: 'player-b' }, full).map((f) => f.id))
      .toEqual(['f-public']);
    expect(service.projectFacts({ role: 'player', playerId: 'player-a' }, full).map((f) => f.id))
      .toEqual(['f-public', 'f-private']);
    expect(service.projectFacts({ role: 'owner', playerId: null }, full).map((f) => f.id))
      .toEqual(['f-public', 'f-private', 'f-owner']);
  });

  it('never bypasses owner_only via knownBy', () => {
    const state: ProjectableState = {
      facts: [{ id: 'leak', visibility: 'owner_only', knownBy: ['player-a'] }],
    };
    expect(service.projectFacts(
      { role: 'player', playerId: 'player-a' },
      state,
    )).toEqual([]);
  });
});
