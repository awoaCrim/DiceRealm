import type { CampaignEvent, EventViewer } from '@dnd/contracts';
import type { DatabasePort } from '../database/DatabasePort.js';
import { OutboxRepository, type OutboxEventRow } from '../events/OutboxRepository.js';
import type { SessionAuthorityBinding } from '../../modules/identity/SessionAuthority.js';
import { EventProjectionError, projectEvent } from './EventProjection.js';

export interface EventStreamOptions {
  /** production default 250ms */
  pollIntervalMs?: number;
  /** 每批读取上限（默认 200） */
  batchSize?: number;
  /** route production default 15s；测试可注入短间隔验证 heartbeat */
  heartbeatIntervalMs?: number;
}

export interface EventAuthorityChecker {
  isCurrent(binding: SessionAuthorityBinding): Promise<boolean>;
}

export interface EventFrame {
  event: 'campaign';
  id: number;
  data: CampaignEvent;
}

export interface EventSubscription {
  close(): void;
  /** 确定性测试：等待当前 in-flight poll settle（不含下一次 setTimeout）。 */
  flush(): Promise<void>;
}

export interface EventBatchReader {
  listAfter(campaignId: string, after: number, limit: number): Promise<OutboxEventRow[]>;
}

/** 事务安全 outbox tail reader：每个批次经 DatabasePort.readCommitted 读 committed snapshot。 */
export class TransactionalOutboxTailReader implements EventBatchReader {
  constructor(private readonly executor: DatabasePort) {}

  listAfter(campaignId: string, after: number, limit: number): Promise<OutboxEventRow[]> {
    return this.executor.readCommitted((reader) =>
      new OutboxRepository(reader).listAfter(campaignId, after, limit),
    );
  }
}

export interface EventStreamRuntime {
  service: EventStreamService;
  closeAll(): void;
  /**
   * Provisionally registers an SSE binding before the route's final authority await. Runtime
   * invalidation may call close/destroy immediately; route callbacks decide whether that only
   * tombstones a pre-header request or closes an already-started response.
   */
  registerClient(client: {
    campaignId: string;
    viewer: EventViewer;
    authorityBinding?: SessionAuthorityBinding;
    close(): void;
    destroy(): void;
  }): () => void;
  /** 关闭并断开匹配 campaign/viewer 的活跃 SSE 客户端；返回关闭数量（浏览器断连实测用）。 */
  closeViewer?(campaignId: string, viewer: EventViewer): number;
  revokeSession(internalSessionId: string): number;
  revokeUser(userId: string): number;
  closeAllForMaintenance(): number;
}

interface SubscriptionState {
  campaignId: string;
  viewer: EventViewer;
  authorityBinding?: SessionAuthorityBinding;
  cursor: number;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  closed: boolean;
}

/**
 * 深模块 SSE 数据流：每订阅 single-flight 轮询（首次立即 poll，每次 settle 后 setTimeout 调度下一次，
 * 禁止 setInterval / 并行 listAfter）。投递 at-least-once：客户端按 SSE id 去重。
 * 每批读取前记住批次最后一个 sequence 并对所有读取行推进 cursor（含不可见/损坏行），
 * 防止私密事件或 poison row 让连接永久重复读取同一尾部。
 */
export class EventStreamService {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly subscriptions = new Set<SubscriptionState>();

  constructor(
    private readonly reader: EventBatchReader,
    options: EventStreamOptions = {},
    private readonly authorityChecker?: EventAuthorityChecker,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.batchSize = options.batchSize ?? 200;
  }

  subscribe(input: {
    campaignId: string;
    viewer: EventViewer;
    authorityBinding?: SessionAuthorityBinding;
    after: number;
    /** 每订阅轮询间隔覆盖（测试注入短间隔；默认取 service options）。 */
    pollIntervalMs?: number;
    /** false = backpressure，立即关闭，客户端重连补发 */
    onFrame(frame: EventFrame): boolean | void;
    /** 仅诊断，不带 payload */
    onProjectionError?(sequence: number): void;
    /** reader/timer fatal error */
    onError?(error: unknown): void;
  }): EventSubscription {
    const state: SubscriptionState = {
      campaignId: input.campaignId,
      viewer: input.viewer,
      authorityBinding: input.authorityBinding,
      cursor: input.after,
      timer: null,
      inFlight: null,
      closed: false,
    };
    this.subscriptions.add(state);
    const pollIntervalMs = input.pollIntervalMs ?? this.pollIntervalMs;

    const poll = (): void => {
      if (state.closed) return;
      const work = this.pollOnce(state, input);
      state.inFlight = work;
      work
        .catch((error) => {
          if (!state.closed) {
            this.closeState(state);
            input.onError?.(error);
          }
        })
        .finally(() => {
          state.inFlight = null;
          if (!state.closed) {
            state.timer = setTimeout(poll, pollIntervalMs);
          }
        });
    };
    poll();

    return {
      close: () => this.closeState(state),
      flush: async () => {
        while (state.inFlight) {
          await state.inFlight;
        }
      },
    };
  }

  async isCurrent(binding: SessionAuthorityBinding): Promise<boolean> {
    if (!this.authorityChecker) return true;
    return this.authorityChecker.isCurrent(binding);
  }

  private async pollOnce(
    state: SubscriptionState,
    input: {
      campaignId: string;
      viewer: EventViewer;
      onFrame(frame: EventFrame): boolean | void;
      onProjectionError?(sequence: number): void;
      onError?(error: unknown): void;
    },
  ): Promise<void> {
    if (!(await this.ensureCurrent(state))) {
      input.onError?.(new Error('SSE session authority is no longer current.'));
      return;
    }
    const rows = await this.reader.listAfter(state.campaignId, state.cursor, this.batchSize);
    if (rows.length === 0) return;
    // 先记住批次最后一个 sequence：即使某行损坏/不可见也推进到它。
    const batchLast = rows[rows.length - 1].sequence;
    for (const row of rows) {
      let event: CampaignEvent | null;
      try {
        event = projectEvent(state.viewer, row);
      } catch (error) {
        if (error instanceof EventProjectionError) {
          input.onProjectionError?.(row.sequence);
          continue; // 跳过坏行，继续投递同批后续合法事件
        }
        throw error;
      }
      if (state.closed) return;
      if (event === null) continue; // 不可见事件：推进 cursor 但不投递
      if (!(await this.ensureCurrent(state))) {
        input.onError?.(new Error('SSE session authority is no longer current.'));
        return;
      }
      const keepGoing = input.onFrame({ event: 'campaign', id: row.sequence, data: event });
      if (keepGoing === false || state.closed) {
        this.closeState(state);
        return;
      }
    }
    state.cursor = Math.max(state.cursor, batchLast);
  }

  private async ensureCurrent(state: SubscriptionState): Promise<boolean> {
    if (state.closed) return false;
    if (!state.authorityBinding || !this.authorityChecker) return true;
    const current = await this.isCurrent(state.authorityBinding);
    if (state.closed) return false;
    if (!current) this.closeState(state);
    return current;
  }

  private closeState(state: SubscriptionState): void {
    state.closed = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.subscriptions.delete(state);
  }

  /** 幂等关闭全部 active subscriptions（test harness / 生产 shutdown 在关 DB 前调用）。 */
  closeAll(): void {
    for (const state of [...this.subscriptions]) {
      this.closeState(state);
    }
  }
}
