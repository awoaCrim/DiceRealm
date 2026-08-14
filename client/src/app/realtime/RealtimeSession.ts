import type { QueryClient } from '@tanstack/react-query';
import type { CampaignEvent } from '@dnd/contracts';
import { parseCampaignEvent, parseSequence } from '../../api/realtime/realtimeEvents';
import {
  campaignAiRunKey,
  campaignDetailKey,
  campaignQueryPrefix,
  campaignTurnsKey,
  campaignTurnKey,
} from '../../shared/lib/queryKeys';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'retrying';

export interface RealtimeSnapshot {
  status: RealtimeStatus;
  attempts: number;
  lastSeenSequence: number;
  previews: ReadonlyMap<string, string>;
  previewError: { runId: string; code: string } | null;
  interactionNoticeCount: number;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface RealtimeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;
const JITTER_MS = 200;

const defaultTimers: RealtimeTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * RealtimeSession 深模块：per-campaign SSE 连接、sequence 去重、指数退避重连
 * （URL 带 ?after=lastSeen）、AI preview buffer 生命周期与事件 → Query Cache 失效。
 * 外部只暴露 start/stop/subscribe/getSnapshot。
 */
export class RealtimeSession {
  private readonly queryClient: QueryClient;
  private readonly eventSourceFactory: EventSourceFactory;
  private readonly timers: RealtimeTimers;
  private campaignId: string | null = null;
  private source: EventSourceLike | null = null;
  private reconnectTimer: unknown = null;
  private attempts = 0;
  private stopped = true;
  private generation = 0;
  /** per-campaign 高水位：切换战役后回到同一战役可续传；stop/刷新按计划回退到 0。 */
  private readonly lastSeenByCampaign = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private snapshot: RealtimeSnapshot = {
    status: 'idle',
    attempts: 0,
    lastSeenSequence: 0,
    previews: new Map(),
    previewError: null,
    interactionNoticeCount: 0,
  };

  constructor(
    queryClient: QueryClient,
    eventSourceFactory: EventSourceFactory = defaultEventSourceFactory,
    timers: RealtimeTimers = defaultTimers,
  ) {
    this.queryClient = queryClient;
    this.eventSourceFactory = eventSourceFactory;
    this.timers = timers;
  }

  start(campaignId: string): void {
    if (!this.stopped && this.campaignId === campaignId) {
      return;
    }
    this.stop();
    this.campaignId = campaignId;
    this.stopped = false;
    this.attempts = 0;
    const watermark = this.lastSeenByCampaign.get(campaignId) ?? 0;
    this.update({ lastSeenSequence: watermark });
    this.connect();
  }

  stop(): void {
    this.generation += 1;
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
    this.campaignId = null;
    this.update({
      status: 'idle',
      attempts: 0,
      lastSeenSequence: 0,
      previews: new Map(),
      previewError: null,
      interactionNoticeCount: 0,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 状态不变时保持引用稳定，满足 useSyncExternalStore 契约。 */
  getSnapshot(): RealtimeSnapshot {
    return this.snapshot;
  }

  private connect(): void {
    if (this.stopped || !this.campaignId) {
      return;
    }
    const campaignId = this.campaignId;
    const generation = ++this.generation;
    this.update({ status: this.attempts > 0 ? 'retrying' : 'connecting', attempts: this.attempts });
    const url = `/api/campaigns/${encodeURIComponent(campaignId)}/events?after=${this.snapshot.lastSeenSequence}`;
    const source = this.eventSourceFactory(url);
    if (this.stopped || this.campaignId !== campaignId || this.generation !== generation) {
      source.close();
      return;
    }
    this.source = source;
    source.addEventListener('campaign', (event) => {
      if (!this.isCurrentConnection(source, campaignId, generation)) return;
      this.handleMessage(event as MessageEvent, campaignId);
    });
    source.onopen = () => {
      if (!this.isCurrentConnection(source, campaignId, generation)) {
        return;
      }
      this.attempts = 0;
      this.update({ status: 'connected', attempts: 0 });
    };
    source.onerror = () => {
      if (!this.isCurrentConnection(source, campaignId, generation)) {
        return;
      }
      // 关闭已断开的流：本模块自管重连，不让原生 EventSource 内部自动重连。
      source.close();
      this.source = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    this.attempts += 1;
    const exponential = BACKOFF_BASE_MS * 2 ** Math.min(this.attempts - 1, 4);
    const delay = Math.min(exponential, BACKOFF_MAX_MS) + Math.floor(Math.random() * JITTER_MS);
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
    }
    this.update({ status: 'disconnected', attempts: this.attempts });
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(event: MessageEvent, campaignId: string): void {
    if (this.stopped || this.campaignId !== campaignId) {
      return;
    }
    const sequence = parseSequence(event.lastEventId);
    if (sequence === null || sequence <= this.snapshot.lastSeenSequence) {
      return;
    }
    // 先推进 lastSeen，再解析 payload：poison row 不会在每次 reconnect 永久重放。
    this.update({ lastSeenSequence: sequence });
    this.lastSeenByCampaign.set(campaignId, sequence);
    const campaignEvent = parseCampaignEvent(event.data);
    if (!campaignEvent) {
      return;
    }
    if (campaignEvent.campaignId !== campaignId) {
      return;
    }
    this.dispatch(campaignEvent);
  }

  private isCurrentConnection(source: EventSourceLike, campaignId: string, generation: number): boolean {
    return !this.stopped
      && this.source === source
      && this.campaignId === campaignId
      && this.generation === generation;
  }

  private dispatch(event: CampaignEvent): void {
    const campaignId = event.campaignId;
    switch (event.type) {
      case 'player.joined':
        this.invalidate([...campaignDetailKey(campaignId)]);
        break;
      case 'turn.action_submitted':
      case 'turn.locked':
        this.invalidate([...campaignTurnsKey(campaignId)]);
        this.invalidate([...campaignTurnKey(campaignId, event.turnId)]);
        break;
      case 'ai.preview.started': {
        const previews = new Map(this.snapshot.previews);
        previews.set(event.runId, '');
        this.update({ previews });
        break;
      }
      case 'ai.preview.delta': {
        const previews = new Map(this.snapshot.previews);
        previews.set(event.runId, `${previews.get(event.runId) ?? ''}${event.text}`);
        this.update({ previews });
        break;
      }
      case 'ai.preview.failed': {
        const previews = new Map(this.snapshot.previews);
        previews.delete(event.runId);
        this.update({ previews, previewError: { runId: event.runId, code: event.code } });
        this.invalidate([...campaignTurnsKey(campaignId)]);
        // 事件不携带 turnId：按 ai-runs 前缀失效（覆盖该 campaign 全部 turn 的 runs）。
        this.invalidate([...campaignQueryPrefix(campaignId), 'ai-runs']);
        break;
      }
      case 'turn.resolved':
        this.update({ previews: new Map(), previewError: null });
        this.invalidateAll(campaignId);
        break;
      case 'combat.updated':
        this.invalidate([...campaignQueryPrefix(campaignId), 'combat']);
        break;
      case 'interaction.requested':
        this.update({ interactionNoticeCount: this.snapshot.interactionNoticeCount + 1 });
        break;
      case 'archive.restored':
        this.update({ previews: new Map(), previewError: null, interactionNoticeCount: 0 });
        this.invalidateAll(campaignId);
        break;
      case 'owner.debug':
        // owner-only：只失效 run list/detail，不渲染 payload。
        this.invalidate([...campaignQueryPrefix(campaignId), 'ai-runs']);
        this.invalidate([...campaignAiRunKey(campaignId, event.runId)]);
        break;
    }
  }

  private invalidate(queryKey: string[]): void {
    void this.queryClient.invalidateQueries({ queryKey });
  }

  private invalidateAll(campaignId: string): void {
    void this.queryClient.invalidateQueries({ queryKey: campaignQueryPrefix(campaignId) });
  }

  private update(patch: Partial<RealtimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function defaultEventSourceFactory(url: string): EventSourceLike {
  return new EventSource(url);
}
