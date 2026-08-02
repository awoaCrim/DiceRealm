import { describe, expect, it } from 'vitest';
import {
  aiProviderKindSchema,
  aiRunDetailSchema,
  aiRunStatusSchema,
  aiRunViewSchema,
  interactionRequestViewSchema,
  resolveTurnInputSchema,
  turnEntrySchema,
} from './index';

describe('ai runtime contracts', () => {
  it('exposes the planned provider kinds and run lifecycle statuses', () => {
    expect(aiProviderKindSchema.options).toEqual(['mock', 'scripted', 'unavailable', 'openai-compatible']);
    expect(aiRunStatusSchema.options).toEqual(['running', 'succeeded', 'failed']);
  });

  it('rejects an empty or overlong idempotencyKey', () => {
    expect(resolveTurnInputSchema.parse({ idempotencyKey: '  k1  ' }).idempotencyKey).toBe('k1');
    expect(() => resolveTurnInputSchema.parse({ idempotencyKey: '  ' })).toThrow();
    expect(() => resolveTurnInputSchema.parse({ idempotencyKey: 'x'.repeat(65) })).toThrow();
  });

  it('parses an ai run view without sensitive fields', () => {
    const view = aiRunViewSchema.parse({
      id: 'run-1', campaignId: 'c1', campaignSequence: 1, turnId: 't1', attempt: 1,
      idempotencyKey: 'k1', provider: 'scripted', model: 'scripted', status: 'succeeded',
      errorCode: null, startedAt: 'now', completedAt: 'now', superseded: false,
    });
    expect(view.status).toBe('succeeded');
    expect(JSON.stringify(view)).not.toContain('context');
    expect(JSON.stringify(view)).not.toContain('rawDebug');
  });

  it('parses an ai run detail with context/result/rawDebug for the owner', () => {
    const detail = aiRunDetailSchema.parse({
      id: 'run-1', campaignId: 'c1', campaignSequence: 1, turnId: 't1', attempt: 1,
      idempotencyKey: 'k1', provider: 'scripted', model: 'scripted', status: 'running',
      errorCode: null, startedAt: 'now', completedAt: null, superseded: false,
      context: { characters: [] }, result: { publicNarrative: '雨停了。' }, rawDebug: { prompt: 'x' },
    });
    expect(detail.rawDebug).toEqual({ prompt: 'x' });
    expect(detail.result).toEqual({ publicNarrative: '雨停了。' });
  });

  it('parses a turn entry with a player_private target', () => {
    const entry = turnEntrySchema.parse({
      id: 'e1', aiRunId: 'run-1', turnId: 't1', campaignId: 'c1', entryKind: 'private_update',
      entryIndex: 0, visibility: 'player_private', targetPlayerId: 'p1',
      payload: { text: '你发现了暗门。' }, createdAt: 'now',
    });
    expect(entry.targetPlayerId).toBe('p1');
    expect(JSON.stringify(entry)).not.toContain('_json');
  });

  it('parses an interaction request view', () => {
    const request = interactionRequestViewSchema.parse({
      id: 'req-a', campaignId: 'c1', turnId: 't1', aiRunId: 'run-1',
      targetPlayerId: 'p1', prompt: '酒馆老板等待你的回答。', status: 'pending', createdAt: 'now',
    });
    expect(request.status).toBe('pending');
    expect(request.targetPlayerId).toBe('p1');
  });
});
