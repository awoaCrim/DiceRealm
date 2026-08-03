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

  it('rejects a private update targeting a non-member', async () => {
    const { db, campaignId, ghostId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', stateChanges: [], diceResults: [], interactionRequests: [],
      privateUpdates: [{ playerId: ghostId, content: '给幽灵' }],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
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

  it('rejects malformed output with AI_OUTPUT_INVALID', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, { bad: true } as never)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
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
});
