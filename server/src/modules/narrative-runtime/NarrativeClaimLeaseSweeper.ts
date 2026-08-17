import { NarrativeWorkCoordinator } from './NarrativeWorkCoordinator.js';

/** Keep the orphan-claim recovery independent from Provider/HTTP traffic. */
export const NARRATIVE_CLAIM_SWEEP_INTERVAL_MS = 30_000;

/**
 * Small process-local scheduler for the claim-recovery sweep. The database CAS
 * remains the authority, so multiple server instances would still be safe if
 * deployment ever moves beyond the current instance lock.
 */
export class NarrativeClaimLeaseSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly coordinator: NarrativeWorkCoordinator,
    private readonly intervalMs = NARRATIVE_CLAIM_SWEEP_INTERVAL_MS,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.trigger();
    this.timer = setInterval(() => this.trigger(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) await this.inFlight;
  }

  private trigger(): void {
    if (this.inFlight !== null) return;
    const run = this.coordinator.sweepExpiredClaims().then(() => undefined).catch((error: unknown) => {
      try {
        this.onError(error);
      } catch {
        // Observability hooks must not break the background scheduler.
      }
    });
    this.inFlight = run.finally(() => {
      this.inFlight = null;
    });
  }
}
