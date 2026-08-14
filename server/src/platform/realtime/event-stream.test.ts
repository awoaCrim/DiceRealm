import { describe, expect, it } from 'vitest';
import type { CampaignEvent, EventViewer } from '@dnd/contracts';
import type { OutboxEventRow } from '../events/OutboxRepository.js';
import { EventProjectionError, projectEvent } from './EventProjection.js';
import { EventStreamService, TransactionalOutboxTailReader, type EventAuthorityChecker, type EventBatchReader, type EventFrame } from './EventStreamService.js';
import type { SessionAuthorityBinding } from '../../modules/identity/SessionAuthority.js';

function row(sequence: number, event: CampaignEvent): OutboxEventRow {
  return {
    id: `evt-${sequence}`,
    campaign_id: event.campaignId,
    sequence,
    event_type: event.type,
    visibility: 'public',
    target_player_id: null,
    payload_json: JSON.stringify(event),
    published_at: null,
    created_at: '2026-08-09T00:00:00.000Z',
  };
}

const owner: EventViewer = { role: 'owner', playerId: null };
const playerA: EventViewer = { role: 'player', playerId: 'pA' };
const playerB: EventViewer = { role: 'player', playerId: 'pB' };
const authorityBinding: SessionAuthorityBinding = {
  internalSessionId: 'session-1',
  userId: 'user-1',
  authRevision: 0,
  revokeEpoch: 0,
  campaignId: 'c1',
  viewer: owner,
};

/** 构造 helper。 */
function preview(sequence: number): OutboxEventRow {
  return row(sequence, { type: 'ai.preview.started', campaignId: 'c1', runId: `r-${sequence}` });
}
function debug(sequence: number): OutboxEventRow {
  return row(sequence, { type: 'owner.debug', campaignId: 'c1', runId: 'r1', kind: 'result' });
}
function interaction(sequence: number, targetPlayerId: string): OutboxEventRow {
  return row(sequence, { type: 'interaction.requested', campaignId: 'c1', requestId: 'req1', targetPlayerId });
}

class StubReader implements EventBatchReader {
  calls: Array<{ after: number; limit: number }> = [];
  constructor(private readonly batches: OutboxEventRow[][], private readonly delayMs = 0) {}
  async listAfter(_campaignId: string, after: number, limit: number): Promise<OutboxEventRow[]> {
    this.calls.push({ after, limit });
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    for (const batch of this.batches) {
      if (batch.length > 0 && after < batch[0].sequence) {
        return batch;
      }
    }
    return [];
  }
}

describe('projectEvent', () => {
  it('owner sees everything; players see public + own private; debug stays owner-only', () => {
    expect(projectEvent(owner, preview(1))?.type).toBe('ai.preview.started');
    expect(projectEvent(owner, debug(2))?.type).toBe('owner.debug');
    expect(projectEvent(playerA, preview(1))?.type).toBe('ai.preview.started');
    expect(projectEvent(playerA, interaction(3, 'pA'))?.type).toBe('interaction.requested');
    expect(projectEvent(playerA, interaction(4, 'pB'))).toBeNull();
    expect(projectEvent(playerB, interaction(3, 'pA'))).toBeNull();
    expect(projectEvent(playerA, debug(2))).toBeNull();
  });

  it('throws a controlled projection error without raw payload on parse failure', () => {
    const bad: OutboxEventRow = {
      ...preview(7),
      payload_json: '{not json',
    };
    expect(() => projectEvent(owner, bad)).toThrow(EventProjectionError);
    try {
      projectEvent(owner, bad);
    } catch (error) {
      expect(error).toBeInstanceOf(EventProjectionError);
      expect((error as EventProjectionError).sequence).toBe(7);
      expect(String(error)).not.toContain('{not json');
    }
  });

  it('throws a controlled projection error on campaign/type mismatch', () => {
    const mismatchCampaign = { ...preview(8), campaign_id: 'c-other' };
    expect(() => projectEvent(owner, mismatchCampaign)).toThrow(EventProjectionError);
    const mismatchType = { ...preview(9), event_type: 'turn.resolved' };
    expect(() => projectEvent(owner, mismatchType)).toThrow(EventProjectionError);
  });
});

describe('EventStreamService', () => {
  it('authority checker rejection closes the subscription and reports the failure', async () => {
    const service = new EventStreamService(
      new StubReader([[preview(1)]]),
      { pollIntervalMs: 5 },
      { isCurrent: async () => false },
    );
    const frames: EventFrame[] = [];
    const errors: unknown[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, authorityBinding, after: 0,
      onFrame: (frame) => { frames.push(frame); },
      onError: (error) => { errors.push(error); },
    });
    await sub.flush();
    expect(frames).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('a synchronous runtime revoke during the final authority await cannot dispatch the frame', async () => {
    const reader = new StubReader([[preview(1)]]);
    let releaseFrameCheck!: () => void;
    const release = new Promise<void>((resolve) => { releaseFrameCheck = resolve; });
    let frameCheckStarted!: () => void;
    const started = new Promise<void>((resolve) => { frameCheckStarted = resolve; });
    let checks = 0;
    const checker: EventAuthorityChecker = {
      isCurrent: async () => {
        checks += 1;
        if (checks === 2) {
          frameCheckStarted();
          await release;
        }
        return true;
      },
    };
    const service = new EventStreamService(reader, { pollIntervalMs: 5 }, checker);
    const frames: EventFrame[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, authorityBinding, after: 0,
      onFrame: (frame) => { frames.push(frame); },
    });
    await started;
    sub.close(); // commit notifier synchronously closes/drops pending delivery
    releaseFrameCheck();
    await sub.flush();
    expect(frames).toEqual([]);
  });

  it('revalidates before the batch read and immediately before every frame dispatch', async () => {
    const reader = new StubReader([[preview(1), preview(2)]]);
    let checks = 0;
    let releaseSecondFrame!: () => void;
    const secondFrameCheck = new Promise<void>((resolve) => { releaseSecondFrame = resolve; });
    let secondFrameReached!: () => void;
    const atSecondFrame = new Promise<void>((resolve) => { secondFrameReached = resolve; });
    let current = true;
    const checker: EventAuthorityChecker = {
      isCurrent: async () => {
        checks += 1;
        if (checks === 3) {
          secondFrameReached();
          await secondFrameCheck;
        }
        return current;
      },
    };
    const service = new EventStreamService(reader, { pollIntervalMs: 5 }, checker);
    const frames: EventFrame[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, authorityBinding, after: 0,
      onFrame: (frame) => { frames.push(frame); },
    });
    await atSecondFrame;
    current = false; // deterministic revocation commit while the next frame is paused
    releaseSecondFrame();
    await sub.flush();

    expect(reader.calls).toHaveLength(1); // check 1 happened before the batch read
    expect(frames.map((frame) => frame.id)).toEqual([1]);
    expect(checks).toBe(3); // batch + frame 1 + frame 2
    sub.close();
  });

  it('replays events after a cursor and skips invisible rows while advancing the cursor', async () => {
    const events = [
      preview(1), interaction(2, 'pA'), preview(3), debug(4), preview(5),
    ];
    const reader = new StubReader([events]);
    const service = new EventStreamService(reader, { pollIntervalMs: 5 });
    const frames: EventFrame[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: playerA, after: 0,
      onFrame: (frame) => { frames.push(frame); },
    });
    await sub.flush();
    // playerA 只看到 public preview + 自己的 interaction；debug 与 pB 的 interaction 被跳过但 cursor 前进。
    expect(frames.map((f) => f.id)).toEqual([1, 2, 3, 5]);
    expect(frames.every((f) => f.event === 'campaign')).toBe(true);
    // 下一 poll 必须从 5 之后继续：不再重读已跳过行（断言前不 close）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reader.calls[reader.calls.length - 1].after).toBe(5);
    sub.close();
  });

  it('returns an empty tail when after is beyond max and keeps polling', async () => {
    const events = [preview(1), preview(2)];
    const reader = new StubReader([events]);
    const service = new EventStreamService(reader, { pollIntervalMs: 5 });
    const frames: EventFrame[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, after: 99,
      onFrame: (frame) => { frames.push(frame); },
    });
    await sub.flush();
    expect(frames).toEqual([]);
    sub.close();
  });

  it('reports a poison row sequence, skips it, and continues delivering later valid events', async () => {
    const poison: OutboxEventRow = { ...preview(2), payload_json: 'broken' };
    const batches = [[preview(1), poison, preview(3), preview(4)]];
    const reader = new StubReader(batches);
    const service = new EventStreamService(reader, { pollIntervalMs: 5 });
    const frames: EventFrame[] = [];
    const errors: number[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, after: 0,
      onFrame: (frame) => { frames.push(frame); },
      onProjectionError: (sequence) => { errors.push(sequence); },
    });
    await sub.flush();
    expect(errors).toEqual([2]);
    expect(frames.map((f) => f.id)).toEqual([1, 3, 4]);
    // 等下一次 poll 发起后断言它从 4 之后继续（不重读已跳过的坏行）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reader.calls[reader.calls.length - 1].after).toBe(4);
    sub.close();
  });

  it('polls single-flight: no overlapping listAfter even with a delayed reader', async () => {
    const events = [preview(1)];
    const reader = new StubReader([events], 20);
    const service = new EventStreamService(reader, { pollIntervalMs: 1 });
    const frames: EventFrame[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, after: 0,
      onFrame: (frame) => { frames.push(frame); },
    });
    // 等待足够多次 poll settle，确认任何时刻都没有并行 listAfter。
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (let i = 1; i < reader.calls.length; i += 1) {
      // settle-then-setTimeout 保证后一次调用只在先前 settle 后发起。
      expect(reader.calls[i].after).toBeGreaterThanOrEqual(reader.calls[i - 1].after);
    }
    expect(frames.map((f) => f.id)).toEqual([1]);
    sub.close();
  });

  it('stops timers and delivery after close', async () => {
    const events = [preview(1), preview(2)];
    const reader = new StubReader([events]);
    const service = new EventStreamService(reader, { pollIntervalMs: 5 });
    const frames: EventFrame[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, after: 0,
      onFrame: (frame) => { frames.push(frame); },
    });
    await sub.flush();
    sub.close();
    const callsAfterClose = reader.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reader.calls.length).toBe(callsAfterClose); // 不再轮询
    expect(frames).toHaveLength(2);
  });

  it('closes on backpressure (onFrame returns false)', async () => {
    const events = [preview(1), preview(2), preview(3)];
    const reader = new StubReader([events]);
    const service = new EventStreamService(reader, { pollIntervalMs: 5 });
    const frames: EventFrame[] = [];
    const sub = service.subscribe({
      campaignId: 'c1', viewer: owner, after: 0,
      onFrame: (frame) => { frames.push(frame); return false; },
    });
    await sub.flush();
    expect(frames).toHaveLength(1);
    const calls = reader.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.calls.length).toBe(calls); // backpressure 后不再轮询
    sub.close();
  });

  it('closeAll closes every subscription idempotently', async () => {
    const reader = new StubReader([[preview(1)]]);
    const service = new EventStreamService(reader, { pollIntervalMs: 5 });
    const subA = service.subscribe({ campaignId: 'c1', viewer: owner, after: 0, onFrame: () => {} });
    const subB = service.subscribe({ campaignId: 'c1', viewer: playerA, after: 0, onFrame: () => {} });
    await subA.flush();
    await subB.flush();
    service.closeAll();
    service.closeAll(); // 幂等
    const calls = reader.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.calls.length).toBe(calls);
  });
});

describe('EventStreamService with real SQLite adapter (visibility regression)', () => {
  it('never delivers outbox rows from a paused, rolled-back transaction', async () => {
    const { createSqliteDatabase } = await import('../database/SqliteDatabaseAdapter.js');
    const { OutboxRepository } = await import('../events/OutboxRepository.js');
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u-vis', 'vis-user', 'hash']);
      await db.execute('INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['c-vis', 'u-vis', '可见性', 'dnd5e', 'active', new Date().toISOString(), new Date().toISOString()]);
      // 业务事务写入 outbox 后暂停，然后 rollback。
      const writer = db.transaction(async (tx) => {
        await new OutboxRepository(tx).publishIn(tx, { type: 'ai.preview.started', campaignId: 'c-vis', runId: 'r-vis' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error('rollback-vis');
      });
      // 并发 flush 不得投递未提交行。
      const service = new EventStreamService(new TransactionalOutboxTailReader(db), { pollIntervalMs: 5 });
      const frames: EventFrame[] = [];
      const sub = service.subscribe({ campaignId: 'c-vis', viewer: owner, after: 0, onFrame: (frame) => { frames.push(frame); } });
      await sub.flush();
      expect(frames).toEqual([]); // 回滚前 flush 不得看到未提交行
      await expect(writer).rejects.toThrow('rollback-vis');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(frames).toEqual([]); // 回滚后仍不投递
      sub.close();
    } finally {
      await db.close();
    }
  });

  it('delivers committed outbox rows only after the writer transaction commits', async () => {
    const { createSqliteDatabase } = await import('../database/SqliteDatabaseAdapter.js');
    const { OutboxRepository } = await import('../events/OutboxRepository.js');
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u-vis2', 'vis-user-2', 'hash']);
      await db.execute('INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['c-vis2', 'u-vis2', '可见性2', 'dnd5e', 'active', new Date().toISOString(), new Date().toISOString()]);
      const writer = db.transaction(async (tx) => {
        await new OutboxRepository(tx).publishIn(tx, { type: 'ai.preview.started', campaignId: 'c-vis2', runId: 'r-vis2' });
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
      });
      const service = new EventStreamService(new TransactionalOutboxTailReader(db), { pollIntervalMs: 5 });
      const frames: EventFrame[] = [];
      const sub = service.subscribe({ campaignId: 'c-vis2', viewer: owner, after: 0, onFrame: (frame) => { frames.push(frame); } });
      // SQLite FIFO：flush 排在 writer 之后，writer commit 前 flush 不 resolve、不投递；
      // commit 后（writer settle）flush 才返回并只投递已提交行。
      await sub.flush();
      await writer;
      expect(frames.map((f) => f.id)).toEqual([1]); // commit 后才投递
      sub.close();
    } finally {
      await db.close();
    }
  });
});
