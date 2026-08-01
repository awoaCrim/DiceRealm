import { describe, expect, it } from 'vitest';
import { worldFactInputSchema, worldFactProjectionSchema } from './index';

describe('world fact contracts', () => {
  it('parses a player_private input with knownBy', () => {
    const input = worldFactInputSchema.parse({
      title: '密室钥匙', kind: 'item', content: '藏在地毯下。',
      visibility: 'player_private', knownBy: ['player-a'],
    });
    expect(input.knownBy).toEqual(['player-a']);
  });

  it('defaults knownBy to an empty list', () => {
    const input = worldFactInputSchema.parse({
      title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public',
    });
    expect(input.knownBy).toEqual([]);
  });

  it('trims the title and rejects blank titles', () => {
    const input = worldFactInputSchema.parse({
      title: '  酒馆  ', kind: 'location', content: '热闹。', visibility: 'public',
    });
    expect(input.title).toBe('酒馆');
    expect(() => worldFactInputSchema.parse({
      title: '   ', kind: 'location', content: 'y', visibility: 'public',
    })).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => worldFactInputSchema.parse({
      title: 'x', kind: 'bogus', content: 'y', visibility: 'public',
    })).toThrow();
  });

  it('projects facts without internal json fields', () => {
    const projection = worldFactProjectionSchema.parse({
      facts: [{
        id: 'f1', campaignId: 'c1', title: 't', kind: 'lore', content: 'c',
        visibility: 'public', knownBy: [], createdAt: 'now', updatedAt: 'now',
      }],
    });
    expect(projection.facts[0].knownBy).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain('_json');
  });
});
