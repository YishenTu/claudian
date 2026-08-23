import type { CollabProjectId } from '@claudian-collab/protocol';

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1_000;
const RETRY_DELAY_MS = 60_000;
type TimerHandle = number;

export interface RetirementResponderExpirySchedulerOptions {
  readonly cancel?: (handle: TimerHandle) => void;
  readonly now?: () => Date;
  readonly schedule?: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
}

export class RetirementResponderExpiryScheduler {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly cancelTimer: (handle: TimerHandle) => void;
  private readonly now: () => Date;
  private readonly scheduleTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly timers = new Map<CollabProjectId, TimerHandle>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly onExpire: (projectId: CollabProjectId) => Promise<void>,
    options: RetirementResponderExpirySchedulerOptions = {},
  ) {
    this.cancelTimer = options.cancel ?? (handle => window.clearTimeout(handle));
    this.now = options.now ?? (() => new Date());
    this.scheduleTimer = options.schedule ?? ((callback, delayMs) => (
      window.setTimeout(callback, delayMs)
    ));
  }

  schedule(projectId: CollabProjectId, expiresAt: string): void {
    if (this.closed) return;
    this.cancel(projectId);
    this.arm(projectId, expiresAt);
  }

  cancel(projectId: CollabProjectId): void {
    const timer = this.timers.get(projectId);
    if (timer === undefined) return;
    this.timers.delete(projectId);
    this.cancelTimer(timer);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const projectId of [...this.timers.keys()]) this.cancel(projectId);
    this.closePromise = Promise.allSettled([...this.inFlight]).then(() => undefined);
    return this.closePromise;
  }

  private arm(
    projectId: CollabProjectId,
    expiresAt: string,
    retry = false,
  ): void {
    if (this.closed) return;
    const remaining = Date.parse(expiresAt) - this.now().getTime();
    const delayMs = retry
      ? RETRY_DELAY_MS
      : Math.min(Math.max(remaining, 0), MAX_TIMER_DELAY_MS);
    const timer = this.scheduleTimer(() => {
      if (this.timers.get(projectId) !== timer) return;
      this.timers.delete(projectId);
      if (Date.parse(expiresAt) > this.now().getTime()) {
        this.arm(projectId, expiresAt);
        return;
      }
      const expiring = Promise.resolve().then(() => this.onExpire(projectId)).catch(() => {
        if (!this.closed) this.arm(projectId, expiresAt, true);
      });
      this.inFlight.add(expiring);
      const clear = () => this.inFlight.delete(expiring);
      void expiring.then(clear, clear);
    }, delayMs);
    this.timers.set(projectId, timer);
  }
}
