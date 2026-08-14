import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { TurnResolutionValidator } from './TurnResolutionValidator.js';

async function makeDb() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const ghost = await identity.register({ login: 'ghost@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
  return { db, campaignId: created.campaign.id, playerA: a.userId, ghostId: ghost.userId };
}

describe('turn resolution validator', () => {
  it('parses a valid resolution and checks member targets', async () => {
    const { db, campaignId, playerA } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    const result = await validator.validate(campaignId, {
      publicNarrative: '雨停了。',
      privateUpdates: [{ playerId: playerA, content: '你发现了暗门。' }],
      diceResults: [{ id: 'd1', formula: '1d20', total: 7, visibility: 'public', targetPlayerId: null }],
      stateChanges: [],
      interactionRequests: [{ id: 'i1', targetPlayerId: playerA, prompt: '回答？' }],
    });
    expect(result.privateUpdates[0].playerId).toBe(playerA);
    await db.close();
  });

  it('rejects a private update targeting a non-member without echoing the Provider value', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    const providerValue = `not-a-member-${'secret'.repeat(100)}`;
    let caught: unknown;
    try {
      await validator.validate(campaignId, {
        publicNarrative: 'x',
        privateUpdates: [{ playerId: providerValue, content: '给幽灵' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'AI_OUTPUT_INVALID',
      message: 'AI 输出不符合结构化结算契约。',
      diagnostic: {
        kind: 'turn_resolution_domain_validation',
        issues: [{ path: ['privateUpdates', 0, 'playerId'], code: 'not_campaign_member' }],
        truncated: false,
      },
    });
    expect(JSON.stringify(caught)).not.toContain(providerValue);
    await db.close();
  });

  it('rejects an empty publicNarrative as invalid output (independent of combat gate)', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects an interaction targeting a non-member', async () => {
    const { db, campaignId, ghostId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [],
      interactionRequests: [{ id: 'i1', targetPlayerId: ghostId, prompt: 'x' }],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects malformed output with bounded path-only schema diagnostics', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    const secretValue = 'private-provider-value-must-not-persist';
    let caught: unknown;
    try {
      await validator.validate(campaignId, {
        publicNarrative: '雨停了。',
        privateUpdates: Array.from({ length: 25 }, (_, index) => ({
          playerId: `player-${index}`,
          content: { secretValue },
        })),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'AI_OUTPUT_INVALID',
      diagnostic: {
        kind: 'turn_resolution_schema_validation',
        issues: expect.arrayContaining([
          { path: ['privateUpdates', 0, 'content'], code: 'invalid_type' },
        ]),
        truncated: true,
      },
    });
    const diagnostic = (caught as { diagnostic: { issues: unknown[] } }).diagnostic;
    expect(diagnostic.issues).toHaveLength(20);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(secretValue);
    expect(serialized.length).toBeLessThan(4096);
    await db.close();
  });

  it('rejects duplicate dice result ids before touching the database', async () => {
    const { db, campaignId, playerA } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], stateChanges: [],
      diceResults: [
        { id: 'd1', formula: '1d20', total: 7, visibility: 'public', targetPlayerId: null },
        { id: 'd1', formula: '1d20', total: 9, visibility: 'public', targetPlayerId: null },
      ],
      interactionRequests: [{ id: 'i1', targetPlayerId: playerA, prompt: 'x' }],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects duplicate interaction request ids before touching the database', async () => {
    const { db, campaignId, playerA } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [],
      interactionRequests: [
        { id: 'i1', targetPlayerId: playerA, prompt: 'x' },
        { id: 'i1', targetPlayerId: playerA, prompt: 'y' },
      ],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('pre-validates combat targets by campaign ownership', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    // 不存在/跨战役 encounter → AI_OUTPUT_INVALID。
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], diceResults: [],
      stateChanges: [{ kind: 'combat', targetId: 'no-such-enc', patch: { command: 'advance_turn' }, visibility: 'public' }],
      interactionRequests: [],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('accepts worldFactCreations and a single encounterStart', async () => {
    const { db, campaignId, playerA } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    const result = await validator.validate(campaignId, {
      publicNarrative: '战斗开始。',
      privateUpdates: [],
      diceResults: [],
      stateChanges: [],
      interactionRequests: [],
      worldFactCreations: [
        { title: '密道', kind: 'location', content: '石墙后藏着通道。', visibility: 'player_private', knownBy: [playerA] },
      ],
      encounterStarts: [{
        name: '伏击',
        combatants: [
          { name: '哥布林', characterId: null, initiativeBonus: 2, hpCurrent: 9, hpMax: 9, ac: 13, conditions: [], visibility: 'public', targetPlayerId: null },
        ],
      }],
    });
    expect(result.worldFactCreations).toHaveLength(1);
    expect(result.encounterStarts).toHaveLength(1);
    expect(result.encounterStarts[0].rollInitiative).toBe(true);
    await db.close();
  });

  it('rejects more than one encounterStart per resolution as invalid output', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
      encounterStarts: [
        { name: '甲', combatants: [{ name: 'a', characterId: null, initiativeBonus: 0, hpCurrent: 5, hpMax: 5, ac: 10, conditions: [], visibility: 'public', targetPlayerId: null }] },
        { name: '乙', combatants: [{ name: 'b', characterId: null, initiativeBonus: 0, hpCurrent: 5, hpMax: 5, ac: 10, conditions: [], visibility: 'public', targetPlayerId: null }] },
      ],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('leaves creation membership/character validity to the formal apply layer (schema parses non-member targetPlayerId)', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    // 校验器不做 knownBy/characterId 的成员/归属预检：这些在 formal apply 内以 AI_OUTPUT_INVALID 拒绝。
    const result = await validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
      worldFactCreations: [
        { title: '私密', kind: 'lore', content: '幽灵所知。', visibility: 'player_private', knownBy: ['not-a-member'] },
      ],
      encounterStarts: [{
        name: '伏击',
        combatants: [
          { name: '哥布林', characterId: 'ch-from-another-campaign', initiativeBonus: 0, hpCurrent: 5, hpMax: 5, ac: 10, conditions: [], visibility: 'public', targetPlayerId: null },
        ],
      }],
    });
    expect(result.worldFactCreations[0].knownBy).toEqual(['not-a-member']);
    expect(result.encounterStarts[0].combatants[0].characterId).toBe('ch-from-another-campaign');
    await db.close();
  });
});
