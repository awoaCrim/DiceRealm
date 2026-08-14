import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RealtimeSession, type EventSourceFactory, type EventSourceLike } from './RealtimeSession';
import {
  campaignAiRunKey,
  campaignCombatKey,
  campaignDetailKey,
  campaignQueryPrefix,
  campaignTurnKey,
  campaignTurnsKey,
} from '../../shared/lib/queryKeys';

/** 可控 EventSource 替身：记录 URL、可手动 open/error/emit campaign frame。 */
class FakeSource implements EventSourceLike {
  static instances: FakeSource[] = [];
  url: string;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn(() => {
    this.closed = true;
  });
  private readonly listeners = new Map<string, EventListener>();

  constructor(url: string) {
    this.url = url;
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: string, lastEventId: string): void {
    const listener = this.listeners.get(type);
    if (listener) {
      listener(new MessageEvent(type, { data, lastEventId }));
    }
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  error(): void {
    this.onerror?.(new Event('error'));
  }
}

function frame(payload: unknown, seq: number): { data: string; lastEventId: string } {
  return { data: JSON.stringify(payload), lastEventId: String(seq) };
}

const E = {
  playerJoined: (campaignId = 'c1', playerId = 'p2') => ({ type: 'player.joined' as const, campaignId, playerId }),
  actionSubmitted: (campaignId = 'c1', turnId = 't1', playerId = 'p1') => ({ type: 'turn.action_submitted' as const, campaignId, turnId, playerId }),
  locked: (campaignId = 'c1', turnId = 't1') => ({ type: 'turn.locked' as const, campaignId, turnId }),
  previewStarted: (campaignId = 'c1', runId = 'r1') => ({ type: 'ai.preview.started' as const, campaignId, runId }),
  previewDelta: (campaignId = 'c1', runId = 'r1', text = 'a') => ({ type: 'ai.preview.delta' as const, campaignId, runId, text }),
  previewFailed: (campaignId = 'c1', runId = 'r1', code = 'AI_OUTPUT_INVALID') => ({ type: 'ai.preview.failed' as const, campaignId, runId, code }),
  resolved: (campaignId = 'c1', turnId = 't1') => ({ type: 'turn.resolved' as const, campaignId, turnId, archiveId: 'a1' }),
  combatUpdated: (campaignId = 'c1', encounterId = 'e1') => ({ type: 'combat.updated' as const, campaignId, encounterId }),
  interactionRequested: (campaignId = 'c1', requestId = 'i1', targetPlayerId = 'p1') => ({ type: 'interaction.requested' as const, campaignId, requestId, targetPlayerId }),
  archiveRestored: (campaignId = 'c1', archiveId = 'a1', version = 2) => ({ type: 'archive.restored' as const, campaignId, archiveId, version }),
  ownerDebug: (campaignId = 'c1', runId = 'r1') => ({ type: 'owner.debug' as const, campaignId, runId, kind: 'context' }),
};

describe('RealtimeSession', () => {
  let queryClient: QueryClient;
  let session: RealtimeSession;
  let factory: Mock<EventSourceFactory>;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient();
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined as never);
    FakeSource.instances = [];
    factory = vi.fn<EventSourceFactory>((url: string) => new FakeSource(url));
    session = new RealtimeSession(queryClient, factory);
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function current(): FakeSource {
    return FakeSource.instances[FakeSource.instances.length - 1];
  }

  it('start 建立连接并带 after=0，open 后 connected', () => {
    session.start('c1');
    expect(factory).toHaveBeenCalledWith('/api/campaigns/c1/events?after=0');
    expect(session.getSnapshot().status).toBe('connecting');
    current().open();
    expect(session.getSnapshot().status).toBe('connected');
  });

  it('同一 campaign 重复 start 不重建连接', () => {
    session.start('c1');
    session.start('c1');
    expect(FakeSource.instances).toHaveLength(1);
  });

  it('a synchronous campaign switch inside the factory cannot install or receive from the superseded source', () => {
    let switched = false;
    let localSession!: RealtimeSession;
    const switchingFactory = vi.fn<EventSourceFactory>((url: string) => {
      const source = new FakeSource(url);
      if (!switched && url.includes('/c1/')) {
        switched = true;
        localSession.start('c2');
      }
      return source;
    });
    localSession = new RealtimeSession(queryClient, switchingFactory);
    localSession.start('c1');

    const old = FakeSource.instances.find((source) => source.url.includes('/c1/'))!;
    const next = FakeSource.instances.find((source) => source.url.includes('/c2/'))!;
    old.emit('campaign', frame(E.previewStarted('c1', 'old'), 9).data, '9');
    next.emit('campaign', frame(E.previewStarted('c2', 'new'), 1).data, '1');

    expect(old.close).toHaveBeenCalled();
    expect(localSession.getSnapshot().lastSeenSequence).toBe(1);
    expect(localSession.getSnapshot().previews.has('old')).toBe(false);
    expect(localSession.getSnapshot().previews.has('new')).toBe(true);
    localSession.stop();
  });

  it('late frames and callbacks from an old source/campaign cannot mutate the new generation', () => {
    vi.useFakeTimers();
    session.start('c1');
    const old = current();
    old.emit('campaign', frame(E.previewStarted('c1', 'old-run'), 3).data, '3');
    session.start('c2');
    const next = current();

    old.emit('campaign', frame(E.previewDelta('c1', 'old-run', 'late'), 99).data, '99');
    old.error();
    old.open();

    expect(session.getSnapshot().lastSeenSequence).toBe(0);
    expect(session.getSnapshot().previews.size).toBe(0);
    expect(session.getSnapshot().status).toBe('connecting');
    vi.advanceTimersByTime(100_000);
    expect(FakeSource.instances).toHaveLength(2);

    next.emit('campaign', frame(E.previewStarted('c2', 'new-run'), 1).data, '1');
    expect(session.getSnapshot().lastSeenSequence).toBe(1);
    expect(session.getSnapshot().previews.has('new-run')).toBe(true);
  });

  it('c1 → c2 → c1 preserves independent campaign watermarks', () => {
    session.start('c1');
    current().emit('campaign', frame(E.previewStarted('c1', 'c1-run'), 7).data, '7');
    session.start('c2');
    expect(factory).toHaveBeenLastCalledWith('/api/campaigns/c2/events?after=0');
    current().emit('campaign', frame(E.previewStarted('c2', 'c2-run'), 3).data, '3');
    session.start('c1');
    expect(factory).toHaveBeenLastCalledWith('/api/campaigns/c1/events?after=7');
    expect(session.getSnapshot().lastSeenSequence).toBe(7);
    session.start('c2');
    expect(factory).toHaveBeenLastCalledWith('/api/campaigns/c2/events?after=3');
    expect(session.getSnapshot().lastSeenSequence).toBe(3);
  });

  it('切换 campaign 关闭旧连接并以 after=0 新连接', () => {
    session.start('c1');
    const first = current();
    session.start('c2');
    expect(first.close).toHaveBeenCalled();
    expect(factory).toHaveBeenLastCalledWith('/api/campaigns/c2/events?after=0');
  });

  it('stop 关闭连接、清 timer、重置 snapshot 为 idle 且 lastSeen=0', () => {
    vi.useFakeTimers();
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.previewStarted(), 3).data, '3');
    src.error(); // 触发重连 timer
    session.stop();
    expect(src.close).toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('idle');
    expect(session.getSnapshot().lastSeenSequence).toBe(0);
    expect(session.getSnapshot().previews.size).toBe(0);
    vi.advanceTimersByTime(100_000);
    expect(FakeSource.instances).toHaveLength(1); // stop 后不再重连
  });

  it('同一 campaign 重新 start 沿用 session 内高水位（?after=3）', () => {
    session.start('c1');
    current().emit('campaign', frame(E.previewStarted(), 3).data, '3');
    session.stop();
    expect(session.getSnapshot().lastSeenSequence).toBe(0);
    session.start('c1');
    expect(factory).toHaveBeenLastCalledWith('/api/campaigns/c1/events?after=3');
  });

  it('重复与乱序 sequence 去重，不重复追加', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.previewStarted(), 1).data, '1');
    src.emit('campaign', frame(E.previewDelta('c1', 'r1', 'a'), 2).data, '2');
    src.emit('campaign', frame(E.previewDelta('c1', 'r1', 'b'), 2).data, '2'); // duplicate
    src.emit('campaign', frame(E.previewDelta('c1', 'r1', 'c'), 1).data, '1'); // stale
    expect(session.getSnapshot().previews.get('r1')).toBe('a');
    expect(session.getSnapshot().lastSeenSequence).toBe(2);
  });

  it('非法 lastEventId 被丢弃且不推进', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.previewStarted(), 1).data, 'not-a-number');
    expect(session.getSnapshot().previews.size).toBe(0);
    expect(session.getSnapshot().lastSeenSequence).toBe(0);
  });

  it('poison payload 仍推进 lastSeen，重连不会永久重放', () => {
    vi.useFakeTimers();
    session.start('c1');
    const src = current();
    src.emit('campaign', '{not-json', '7');
    expect(session.getSnapshot().lastSeenSequence).toBe(7);
    src.error();
    vi.advanceTimersByTime(1200); // 1s 指数退避 + jitter
    expect(FakeSource.instances).toHaveLength(2);
    expect(factory).toHaveBeenLastCalledWith('/api/campaigns/c1/events?after=7');
  });

  it('非法 contract payload 被跳过（不渲染）但推进 sequence', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', JSON.stringify({ hello: 'world' }), '2');
    expect(session.getSnapshot().previews.size).toBe(0);
    expect(session.getSnapshot().lastSeenSequence).toBe(2);
  });

  it('preview started/delta 追加文本；failed 移除并记录错误且失效 turns/ai-runs', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.previewStarted(), 1).data, '1');
    src.emit('campaign', frame(E.previewDelta('c1', 'r1', '你好'), 2).data, '2');
    src.emit('campaign', frame(E.previewDelta('c1', 'r1', '世界'), 3).data, '3');
    expect(session.getSnapshot().previews.get('r1')).toBe('你好世界');
    src.emit('campaign', frame(E.previewFailed(), 4).data, '4');
    const snap = session.getSnapshot();
    expect(snap.previews.has('r1')).toBe(false);
    expect(snap.previewError).toEqual({ runId: 'r1', code: 'AI_OUTPUT_INVALID' });
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignTurnsKey('c1') }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['campaign', 'c1', 'ai-runs'] }));
  });

  it('turn.resolved 清空 preview 并失效整个 campaign 前缀', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.previewStarted(), 1).data, '1');
    src.emit('campaign', frame(E.previewDelta('c1', 'r1', 'x'), 2).data, '2');
    src.emit('campaign', frame(E.resolved(), 3).data, '3');
    const snap = session.getSnapshot();
    expect(snap.previews.size).toBe(0);
    expect(snap.previewError).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignQueryPrefix('c1') }));
  });

  it('player.joined 失效 campaign detail', () => {
    session.start('c1');
    current().emit('campaign', frame(E.playerJoined(), 1).data, '1');
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignDetailKey('c1') }));
  });

  it('turn.action_submitted / turn.locked 失效 turns 与 turn detail', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.actionSubmitted(), 1).data, '1');
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignTurnsKey('c1') }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignTurnKey('c1', 't1') }));
    invalidateSpy.mockClear();
    src.emit('campaign', frame(E.locked(), 2).data, '2');
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignTurnsKey('c1') }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignTurnKey('c1', 't1') }));
  });

  it('combat.updated 失效 combat 前缀', () => {
    session.start('c1');
    current().emit('campaign', frame(E.combatUpdated(), 1).data, '1');
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignCombatKey('c1') }));
  });

  it('interaction.requested 累加 notice 计数且不渲染 prompt', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.interactionRequested(), 1).data, '1');
    src.emit('campaign', frame(E.interactionRequested('c1', 'i2'), 2).data, '2');
    expect(session.getSnapshot().interactionNoticeCount).toBe(2);
  });

  it('archive.restored 清空实时临时状态并失效整个 campaign 前缀', () => {
    session.start('c1');
    const src = current();
    src.emit('campaign', frame(E.previewStarted(), 1).data, '1');
    src.emit('campaign', frame(E.interactionRequested(), 2).data, '2');
    src.emit('campaign', frame(E.archiveRestored(), 3).data, '3');
    const snap = session.getSnapshot();
    expect(snap.previews.size).toBe(0);
    expect(snap.interactionNoticeCount).toBe(0);
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignQueryPrefix('c1') }));
  });

  it('owner.debug 只失效 ai-runs/run detail，不渲染 payload', () => {
    session.start('c1');
    current().emit('campaign', frame(E.ownerDebug(), 1).data, '1');
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['campaign', 'c1', 'ai-runs'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: campaignAiRunKey('c1', 'r1') }));
  });

  it('retry backoff progresses exponentially and caps at 15 seconds before jitter', () => {
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    const timers = {
      setTimeout: (callback: () => void, ms: number) => {
        callbacks.push(callback);
        delays.push(ms);
        return callbacks.length;
      },
      clearTimeout: vi.fn(),
    };
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const local = new RealtimeSession(queryClient, factory, timers);
    local.start('c1');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      current().error();
      callbacks.shift()?.();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    expect(local.getSnapshot().attempts).toBe(6);
    local.stop();
  });

  it('断开后退避重连；open 重置 attempts；stopped 后回调无效', () => {
    vi.useFakeTimers();
    session.start('c1');
    current().open();
    current().error();
    expect(session.getSnapshot().status).toBe('disconnected');
    expect(session.getSnapshot().attempts).toBe(1);
    vi.advanceTimersByTime(1200);
    expect(FakeSource.instances).toHaveLength(2);
    expect(session.getSnapshot().status).toBe('retrying');
    current().open();
    expect(session.getSnapshot().status).toBe('connected');
    expect(session.getSnapshot().attempts).toBe(0);
  });

  it('状态不变时 getSnapshot 引用稳定（useSyncExternalStore 契约）', () => {
    const before = session.getSnapshot();
    expect(session.getSnapshot()).toBe(before);
    session.start('c1');
    expect(session.getSnapshot()).not.toBe(before);
    const afterStart = session.getSnapshot();
    expect(session.getSnapshot()).toBe(afterStart);
  });

  it('subscribe 通知 listener；unsubscribe 后不再通知', () => {
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    session.start('c1');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const calls = listener.mock.calls.length;
    session.stop();
    expect(listener.mock.calls.length).toBe(calls);
  });
});
