import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { RulesService } from './RulesService.js';

const hashA = 'ab'.repeat(32);
const hashB = 'cd'.repeat(32);
const hashC = 'ef'.repeat(32);

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'rules-owner@example.test', password: 'correct-password' });
  const player = await identity.register({ login: 'rules-player@example.test', password: 'correct-password' });
  const otherOwner = await identity.register({ login: 'rules-other@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '规则战役', ruleset: 'dnd5e' });
  await campaigns.join({ userId: player.userId }, created.campaign.id, created.inviteCode);
  const other = await campaigns.create(otherOwner.userId, { name: '其它战役', ruleset: 'dnd5e' });
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const playerCtx = await resolveCampaignContext(db, { userId: player.userId }, created.campaign.id);
  const otherCtx = await resolveCampaignContext(db, { userId: otherOwner.userId }, other.campaign.id);
  return { db, ownerCtx, playerCtx, otherCtx };
}

describe('rules service', () => {
  it('registers immutable metadata and lists only effective platform/campaign/owner-user sources', async () => {
    const { db, ownerCtx, otherCtx } = await makeFixture();
    try {
      const rules = new RulesService(db);
      const platform = await rules.registerPlatform({
        sourceName: 'Open Reference', version: '2024.1', license: 'CC-BY-4.0',
        attribution: 'Example Author', contentHash: hashA.toUpperCase(),
      });
      const campaign = await rules.register(ownerCtx, {
        sourceName: 'Campaign Notes', version: '1', license: 'Owner-created',
        attribution: 'rules-owner', contentHash: hashB, scope: 'campaign',
      });
      const user = await rules.register(ownerCtx, {
        sourceName: 'Personal Homebrew', version: '3', license: 'User-owned private content',
        attribution: 'rules-owner', contentHash: hashC, scope: 'user',
      });
      await rules.register(otherCtx, {
        sourceName: 'Other Campaign', version: '1', license: 'Owner-created',
        attribution: 'rules-other', contentHash: '12'.repeat(32), scope: 'campaign',
      });
      await rules.register(otherCtx, {
        sourceName: 'Other User', version: '1', license: 'User-owned private content',
        attribution: 'rules-other', contentHash: '34'.repeat(32), scope: 'user',
      });

      expect(platform).toMatchObject({ scope: 'platform', campaignId: null, contentHash: hashA });
      expect(campaign).toMatchObject({ scope: 'campaign', campaignId: ownerCtx.campaignId });
      expect(user).toMatchObject({ scope: 'user', campaignId: null });
      expect(await rules.listForOwner(ownerCtx)).toEqual(expect.arrayContaining([platform, campaign, user]));
      expect((await rules.listForOwner(ownerCtx)).map((source) => source.sourceName).sort()).toEqual([
        'Campaign Notes', 'Open Reference', 'Personal Homebrew',
      ]);

      const columns = await db.query<{ name: string }>('PRAGMA table_info(platform_rule_sources)');
      expect(columns.map((column) => column.name)).not.toContain('content');
    } finally {
      await db.close();
    }
  });

  it('maps malformed provenance and duplicate identities to INVALID_RULE_SOURCE', async () => {
    const { db, ownerCtx } = await makeFixture();
    try {
      const rules = new RulesService(db);
      await expect(rules.register(ownerCtx, {
        sourceName: 'Bad License', version: '1', license: '   ', attribution: 'owner',
        contentHash: hashA, scope: 'campaign',
      })).rejects.toMatchObject({ code: 'INVALID_RULE_SOURCE', status: 422 });
      await expect(rules.register(ownerCtx, {
        sourceName: 'Bad Hash', version: '1', license: 'CC0', attribution: 'owner',
        contentHash: 'not-a-sha256', scope: 'campaign',
      })).rejects.toMatchObject({ code: 'INVALID_RULE_SOURCE', status: 422 });

      const input = {
        sourceName: 'Duplicate', version: '1', license: 'CC0', attribution: 'owner',
        contentHash: hashA, scope: 'campaign' as const,
      };
      await rules.register(ownerCtx, input);
      await expect(rules.register(ownerCtx, { ...input, contentHash: hashB }))
        .rejects.toMatchObject({ code: 'INVALID_RULE_SOURCE' });
      await expect(rules.register(ownerCtx, { ...input, sourceName: 'Renamed', version: '2' }))
        .rejects.toMatchObject({ code: 'INVALID_RULE_SOURCE' });
    } finally {
      await db.close();
    }
  });

  it('keeps both listing and registration owner-only', async () => {
    const { db, playerCtx } = await makeFixture();
    try {
      const rules = new RulesService(db);
      await expect(rules.listForOwner(playerCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(rules.register(playerCtx, {
        sourceName: 'Player source', version: '1', license: 'User-owned', attribution: 'player',
        contentHash: hashA, scope: 'user',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await db.close();
    }
  });
});
