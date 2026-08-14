import { describe, expect, it } from 'vitest';
import {
  archiveSnapshotSchema,
  archiveSnapshotV1Schema,
  archiveSnapshotV2Schema,
  manualArchiveInputSchema,
} from './index';

describe('archive contracts', () => {
  it('parses a complete schemaVersion=1 snapshot', () => {
    const snapshot = archiveSnapshotSchema.parse({
      schemaVersion: 1,
      campaignId: 'c1',
      ruleset: 'dnd5e',
      characters: [{
        id: 'char-1', campaignId: 'c1', playerId: 'p1', name: '薇拉', status: 'approved',
        sheet: { ac: 14 }, derived: { ac: { value: 14, sources: ['base'] } },
        submittedAt: '2026-08-02T00:00:00.000Z', approvedAt: '2026-08-02T00:00:00.000Z',
        createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
      }],
      worldFacts: [{
        id: 'f1', campaignId: 'c1', title: '酒馆', kind: 'location', content: '热闹。',
        visibility: 'public', knownBy: [], createdAt: 'now', updatedAt: 'now',
      }],
      currentTurn: {
        turn: {
          id: 't1', campaignId: 'c1', number: 1, status: 'completed', lockedAt: 'now',
          completedAt: 'now', createdAt: 'now', updatedAt: 'now',
        },
        actions: [{
          id: 'a1', turnId: 't1', campaignId: 'c1', playerId: 'p1', body: '我搜索房间。',
          submittedAt: 'now', updatedAt: 'now',
        }],
        requirements: [{ playerId: 'p1', submitted: true }, { playerId: 'p2', submitted: true }],
      },
      watermarks: { outboxSequence: 4, aiRunCampaignSequence: 1, turnNumber: 1 },
    });
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.currentTurn?.turn.status).toBe('completed');
    expect(snapshot.watermarks.outboxSequence).toBe(4);
    expect(snapshot.watermarks.turnNumber).toBe(1);
    // 快照不得包含审计 / password / invite / *_json 内部字段。
    expect(JSON.stringify(snapshot)).not.toContain('_json');
    expect(JSON.stringify(snapshot)).not.toContain('password');
    expect(JSON.stringify(snapshot)).not.toContain('invite');
  });

  it('parses a setup snapshot without a current turn', () => {
    const snapshot = archiveSnapshotSchema.parse({
      schemaVersion: 1, campaignId: 'c1', ruleset: 'dnd5e',
      characters: [], worldFacts: [], currentTurn: null,
      watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    });
    expect(snapshot.currentTurn).toBeNull();
  });

  it('rejects a snapshot with unknown schemaVersion', () => {
    expect(() => archiveSnapshotSchema.parse({
      schemaVersion: 99, campaignId: 'c1', ruleset: 'dnd5e', characters: [], worldFacts: [],
      currentTurn: null, watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    })).toThrow();
  });

  it('trims and requires a manual archive label', () => {
    expect(manualArchiveInputSchema.parse({ label: '  进入矿洞前  ' }).label).toBe('进入矿洞前');
    expect(() => manualArchiveInputSchema.parse({ label: '   ' })).toThrow();
  });

  it('keeps the v1 schema exported and parsing standalone v1 snapshots', () => {
    const v1 = archiveSnapshotV1Schema.parse({
      schemaVersion: 1, campaignId: 'c1', ruleset: 'dnd5e',
      characters: [], worldFacts: [], currentTurn: null,
      watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    });
    expect(v1.schemaVersion).toBe(1);
  });

  it('parses a schemaVersion=2 snapshot with encounters via the union', () => {
    const snapshot = archiveSnapshotSchema.parse({
      schemaVersion: 2, campaignId: 'c1', ruleset: 'dnd5e',
      characters: [], worldFacts: [], currentTurn: null,
      encounters: [{
        encounter: {
          id: 'enc-1', campaignId: 'c1', name: '地窖遭遇', status: 'active',
          activeCombatantId: 'cbt-1', round: 2,
          createdAt: 'now', updatedAt: 'now',
        },
        combatants: [{
          id: 'cbt-1', encounterId: 'enc-1', campaignId: 'c1', name: '战士',
          characterId: 'char-1', initiative: 18, initiativeBonus: 2,
          hpCurrent: 9, hpMax: 12, ac: 16, conditions: ['中毒'],
          visibility: 'public', targetPlayerId: null, position: 0,
          createdAt: 'now', updatedAt: 'now',
        }],
      }],
      watermarks: { outboxSequence: 4, aiRunCampaignSequence: 1, turnNumber: 1 },
    });
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.encounters).toHaveLength(1);
    expect(snapshot.encounters[0].encounter.round).toBe(2);
    expect(snapshot.encounters[0].combatants[0].visibility).toBe('public');
  });

  it('rejects a schemaVersion=2 snapshot missing encounters', () => {
    expect(() => archiveSnapshotSchema.parse({
      schemaVersion: 2, campaignId: 'c1', ruleset: 'dnd5e',
      characters: [], worldFacts: [], currentTurn: null,
      watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    })).toThrow();
    expect(() => archiveSnapshotV2Schema.parse({
      schemaVersion: 2, campaignId: 'c1', ruleset: 'dnd5e',
      characters: [], worldFacts: [], currentTurn: null,
      watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    })).toThrow();
  });

  it('enforces strict combatant payloads inside v2 snapshots', () => {
    const base = {
      schemaVersion: 2, campaignId: 'c1', ruleset: 'dnd5e',
      characters: [], worldFacts: [], currentTurn: null,
      watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    };
    // 未知额外字段必须被拒绝（strict）。
    expect(() => archiveSnapshotSchema.parse({
      ...base,
      encounters: [{
        encounter: {
          id: 'enc-1', campaignId: 'c1', name: 'x', status: 'preparation',
          activeCombatantId: null, round: 1, createdAt: 'now', updatedAt: 'now',
        },
        combatants: [{
          id: 'cbt-1', encounterId: 'enc-1', campaignId: 'c1', name: 'x',
          characterId: null, initiative: null, initiativeBonus: 0,
          hpCurrent: 1, hpMax: 1, ac: 10, conditions: [],
          visibility: 'public', targetPlayerId: null, position: 0,
          createdAt: 'now', updatedAt: 'now', bonus: 99,
        }],
      }],
    })).toThrow();
    // player_private combatant 缺少 targetPlayerId 必须被拒绝。
    expect(() => archiveSnapshotSchema.parse({
      ...base,
      encounters: [{
        encounter: {
          id: 'enc-1', campaignId: 'c1', name: 'x', status: 'preparation',
          activeCombatantId: null, round: 1, createdAt: 'now', updatedAt: 'now',
        },
        combatants: [{
          id: 'cbt-1', encounterId: 'enc-1', campaignId: 'c1', name: 'x',
          characterId: null, initiative: null, initiativeBonus: 0,
          hpCurrent: 1, hpMax: 1, ac: 10, conditions: [],
          visibility: 'player_private', targetPlayerId: null, position: 0,
          createdAt: 'now', updatedAt: 'now',
        }],
      }],
    })).toThrow();
  });
});
