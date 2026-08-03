import { describe, expect, it } from 'vitest';
import type { TurnEntryRow } from './TurnEntryRepository.js';
import { projectEntries } from './TurnEntryRepository.js';

describe('turn entries projection', () => {
  const entries: TurnEntryRow[] = [
    { id: 'e1', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'narrative', entry_index: 0, visibility: 'public', target_player_id: null, payload_json: '{"text":"公开"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
    { id: 'e2', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'private_update', entry_index: 1, visibility: 'player_private', target_player_id: 'p1', payload_json: '{"text":"给 A"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
    { id: 'e3', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'private_update', entry_index: 2, visibility: 'player_private', target_player_id: 'p2', payload_json: '{"text":"给 B"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
    { id: 'e4', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'narrative', entry_index: 3, visibility: 'owner_only', target_player_id: null, payload_json: '{"text":"DM 备注"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
  ];

  it('owner sees all entries; player sees public + own private only', () => {
    expect(projectEntries({ role: 'owner', playerId: null }, entries).map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(projectEntries({ role: 'player', playerId: 'p1' }, entries).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(projectEntries({ role: 'player', playerId: 'p2' }, entries).map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('never leaks owner_only to any player', () => {
    const projected = projectEntries({ role: 'player', playerId: 'p1' }, entries);
    expect(JSON.stringify(projected)).not.toContain('DM 备注');
  });
});
