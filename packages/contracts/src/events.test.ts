import { describe, expect, it } from 'vitest';
import { campaignEventSchema, canReadEvent, eventDefaultAudience } from './index';

describe('campaign event contracts', () => {
  it('accepts every variant with campaignId', () => {
    expect(campaignEventSchema.parse({ type: 'player.joined', campaignId: 'c', playerId: 'p' }))
      .toHaveProperty('campaignId', 'c');
    expect(campaignEventSchema.parse({ type: 'turn.action_submitted', campaignId: 'c', turnId: 't', playerId: 'p' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'turn.locked', campaignId: 'c', turnId: 't' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'ai.preview.failed', campaignId: 'c', runId: 'r', code: 'AI_PROVIDER_FAILED' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'interaction.requested', campaignId: 'c', requestId: 'q', targetPlayerId: 'p2' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'owner.debug', campaignId: 'c', runId: 'r', kind: 'ctx' })).toBeTruthy();
  });

  it('rejects an event without campaignId', () => {
    expect(() => campaignEventSchema.parse({ type: 'turn.locked', turnId: 't' })).toThrow();
  });

  it('rejects interaction.requested without targetPlayerId', () => {
    expect(() => campaignEventSchema.parse({ type: 'interaction.requested', campaignId: 'c', requestId: 'q' })).toThrow();
  });

  it('computes the default audience per event type', () => {
    expect(eventDefaultAudience({ type: 'turn.locked', campaignId: 'c', turnId: 't' }))
      .toEqual({ visibility: 'public', targetPlayerId: null });
    expect(eventDefaultAudience({ type: 'owner.debug', campaignId: 'c', runId: 'r', kind: 'k' }))
      .toEqual({ visibility: 'owner_only', targetPlayerId: null });
    expect(eventDefaultAudience({ type: 'interaction.requested', campaignId: 'c', requestId: 'q', targetPlayerId: 'p2' }))
      .toEqual({ visibility: 'player_private', targetPlayerId: 'p2' });
  });

  it('projects events per viewer', () => {
    const owner = { role: 'owner' as const, playerId: null };
    const p1 = { role: 'player' as const, playerId: 'p1' };
    const p2 = { role: 'player' as const, playerId: 'p2' };
    const submitted = { type: 'turn.action_submitted' as const, campaignId: 'c', turnId: 't', playerId: 'p1' };
    expect(canReadEvent(owner, submitted)).toBe(true);
    expect(canReadEvent(p1, submitted)).toBe(true);
    expect(canReadEvent(p2, submitted)).toBe(true);
    const debug = { type: 'owner.debug' as const, campaignId: 'c', runId: 'r', kind: 'k' };
    expect(canReadEvent(owner, debug)).toBe(true);
    expect(canReadEvent(p1, debug)).toBe(false);
    const interaction = { type: 'interaction.requested' as const, campaignId: 'c', requestId: 'q', targetPlayerId: 'p2' };
    expect(canReadEvent(p1, interaction)).toBe(false);
    expect(canReadEvent(p2, interaction)).toBe(true);
    expect(canReadEvent(owner, interaction)).toBe(true);
  });
});
