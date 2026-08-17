import { campaignEventSchema, type AiRunView } from '@dnd/contracts';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { AppError } from '../../platform/http/AppError.js';
import { NarrativeWorkCoordinator } from './NarrativeWorkCoordinator.js';

/** Production default: work signals are level-triggered, not a timing authority. */
export const NARRATIVE_WORK_POLL_INTERVAL_MS = 250;
export const NARRATIVE_WORK_CONSUMER_NAME = 'narrative-work';
const NARRATIVE_WORK_EVENT_TYPE = 'narrative.round.work_available';
const NARRATIVE_WORK_BATCH_SIZE = 200;

export interface NarrativeDecisionWorker {
  resolveDecisionInternal(
    campaignId: string,
    roundId: string,
    decisionId: string,
    input: { idempotencyKey: string },
  ): Promise<{ created: boolean; run: AiRunView }>;
}

/**
 * Production outbox -> Provider bridge for live NarrativeRound decisions.
 *
 * The outbox signal only wakes the runtime. Before every Provider call it
 * re-queries the authoritative earliest Decision, and the resolver owns the
 * only claim transaction. This keeps delivery order, duplicate events and a
 * delayed poll from becoming a second claim authority.
 */
export class NarrativeWorkRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly activeRounds = new Set<string>();

  constructor(
    private readonly database: DatabasePort,
    private readonly coordinator: NarrativeWorkCoordinator,
    private readonly worker: NarrativeDecisionWorker,
    private readonly intervalMs = NARRATIVE_WORK_POLL_INTERVAL_MS,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) await this.inFlight;
  }

  /** Deterministic test/diagnostic seam; production uses start(). */
  async runOnce(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const work = (async () => {
      try {
        await this.pollOnce();
      } catch (error) {
        this.report(error);
      }
    })();
    this.inFlight = work;
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
    await work;
  }

  private async pollOnce(): Promise<void> {
    const rows = await this.database.readCommitted((reader) =>
      new OutboxRepository(reader).listPendingByConsumer(
        NARRATIVE_WORK_EVENT_TYPE,
        NARRATIVE_WORK_CONSUMER_NAME,
        NARRATIVE_WORK_BATCH_SIZE,
      ),
    );

    for (const row of rows) {
      const event = parseWorkAvailable(row.payload_json);
      if (!event) {
        await this.markHandled(row.id);
        continue;
      }
      if (this.activeRounds.has(event.roundId)) continue;

      const candidate = await this.coordinator.peekNext(event.campaignId, event.roundId);
      if (!candidate) {
        // A stale wake-up can also be the last signal after a terminal
        // narration/skip. Let the coordinator re-check the required Decision
        // boundary and close the Round idempotently when appropriate.
        await this.advanceAfterDecision(event, row.id);
        continue;
      }
      if (candidate.status !== 'submitted' && candidate.status !== 'processing') {
        // needs_owner_attention is a deliberate blocked prefix. It must not
        // close the Round, but a terminal predecessor's wake-up can still be
        // acknowledged after this check.
        await this.advanceAfterDecision(event, row.id);
        continue;
      }

      this.activeRounds.add(event.roundId);
      const idempotencyKey = `narrative-work:${row.id}:${candidate.id}`;
      try {
        await this.worker.resolveDecisionInternal(
          event.campaignId,
          event.roundId,
          candidate.id,
          { idempotencyKey },
        );
        await this.advanceAfterDecision(event, row.id);
      } catch (error) {
        // A narration failure is terminal for scheduling even though its
        // mechanics run remains retryable. Provider/claim failures retain the
        // older terminal-run and retry semantics.
        const disposition = await this.advanceAfterDecision(event, row.id);
        if (disposition === 'error' && (await this.hasTerminalRun(event.campaignId, idempotencyKey)
          || isTerminalNoWorkError(error))) {
          await this.markHandled(row.id);
        } else if (disposition === 'error' && !(error instanceof AppError && error.code === 'STATE_CONFLICT')) {
          this.report(error);
        }
      } finally {
        this.activeRounds.delete(event.roundId);
      }
    }
  }

  private async advanceAfterDecision(
    event: { campaignId: string; roundId: string; decisionId: string },
    eventId: string,
  ): Promise<'handled' | 'retry' | 'error'> {
    try {
      const advancement = await this.coordinator.advanceAfterDecision(
        event.campaignId,
        event.roundId,
        event.decisionId,
      );
      if (!advancement.presentationTerminal) {
        if (advancement.retainSignal) return 'retry';
        await this.markHandled(eventId);
        return 'handled';
      }
      await this.markHandled(eventId);
      return 'handled';
    } catch (error) {
      this.report(error);
      return 'error';
    }
  }

  private async hasTerminalRun(campaignId: string, idempotencyKey: string): Promise<boolean> {
    const rows = await this.database.readCommitted((reader) => reader.query<{ status: string }>(
      'SELECT status FROM platform_ai_runs WHERE campaign_id = ? AND idempotency_key = ?',
      [campaignId, idempotencyKey],
    ));
    return rows[0]?.status === 'succeeded' || rows[0]?.status === 'failed';
  }

  private async markHandled(eventId: string): Promise<void> {
    await this.database.transaction((tx) =>
      new OutboxRepository(tx).markConsumerReceiptIn(
        tx,
        NARRATIVE_WORK_CONSUMER_NAME,
        eventId,
      ),
    );
  }

  private report(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Diagnostics must never stop the outbox consumer.
    }
  }
}

function parseWorkAvailable(payloadJson: string):
  { campaignId: string; roundId: string; decisionId: string } | null {
  try {
    const parsed = campaignEventSchema.safeParse(JSON.parse(payloadJson));
    if (!parsed.success || parsed.data.type !== NARRATIVE_WORK_EVENT_TYPE) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function isTerminalNoWorkError(error: unknown): boolean {
  return error instanceof AppError
    && (error.code === 'NOT_FOUND'
      || error.code === 'CAMPAIGN_NOT_FOUND'
      || error.code === 'TURN_NOT_ACTIVE'
      || error.code === 'TURN_LOCKED');
}
