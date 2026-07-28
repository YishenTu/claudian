import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
  scheduleDelayedFrame,
} from '../../../utils/animationFrame';

export interface StreamingRenderCoordinatorOptions<TSnapshot> {
  render: (snapshot: TSnapshot) => Promise<void>;
  getOwnerWindow: () => Window | null;
  minIntervalMs: number;
}

interface RenderWaiter {
  version: number;
  resolve: () => void;
}

export class StreamingRenderCoordinator<TSnapshot> {
  private readonly render: (snapshot: TSnapshot) => Promise<void>;
  private readonly getOwnerWindow: () => Window | null;
  private readonly minIntervalMs: number;

  private latestSnapshot: TSnapshot | null = null;
  private requestedVersion = 0;
  private renderedVersion = 0;
  private forceThroughVersion = 0;
  private lastRenderCompletedAt = Number.NEGATIVE_INFINITY;
  private scheduledFrame: ScheduledAnimationFrame | null = null;
  private renderRunning = false;
  private available = true;
  private bypassThrottle = false;
  private generation = 0;
  private disposed = false;
  private waiters: RenderWaiter[] = [];

  constructor(options: StreamingRenderCoordinatorOptions<TSnapshot>) {
    this.render = options.render;
    this.getOwnerWindow = options.getOwnerWindow;
    this.minIntervalMs = options.minIntervalMs;
  }

  request(snapshot: TSnapshot): void {
    if (this.disposed) return;

    this.latestSnapshot = snapshot;
    this.requestedVersion += 1;
    this.schedule();
  }

  setAvailable(available: boolean): void {
    if (this.disposed || this.available === available) return;

    this.available = available;
    if (!available) {
      if (this.forceThroughVersion <= this.renderedVersion) {
        this.cancelScheduledFrame();
      }
      return;
    }

    this.schedule(true);
  }

  async flush(): Promise<void> {
    if (this.disposed || this.requestedVersion <= this.renderedVersion) return;

    const targetVersion = this.requestedVersion;
    this.forceThroughVersion = Math.max(this.forceThroughVersion, targetVersion);
    this.bypassThrottle = true;
    this.cancelScheduledFrame();

    const completion = this.waitForVersion(targetVersion);
    if (!this.renderRunning) {
      void this.runRender();
    }
    await completion;
  }

  cancel(): void {
    this.generation += 1;
    this.cancelScheduledFrame();
    this.latestSnapshot = null;
    this.requestedVersion = 0;
    this.renderedVersion = 0;
    this.forceThroughVersion = 0;
    this.lastRenderCompletedAt = Number.NEGATIVE_INFINITY;
    this.bypassThrottle = false;
    this.resolveAllWaiters();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private schedule(bypassThrottle = false): void {
    if (this.disposed || this.renderRunning || this.scheduledFrame) return;
    if (!this.latestSnapshot || this.requestedVersion <= this.renderedVersion) return;

    const forcePending = this.forceThroughVersion > this.renderedVersion;
    if (!this.available && !forcePending) return;

    this.bypassThrottle ||= bypassThrottle;
    const ownerWindow = this.getOwnerWindow();
    if (!ownerWindow) {
      void this.runRender();
      return;
    }

    this.scheduledFrame = scheduleAnimationFrame(() => {
      this.scheduledFrame = null;
      void this.runRender();
    }, ownerWindow);
  }

  private async runRender(): Promise<void> {
    if (this.disposed || this.renderRunning) return;
    if (!this.latestSnapshot || this.requestedVersion <= this.renderedVersion) {
      this.resolveCompletedWaiters();
      return;
    }

    const forcePending = this.forceThroughVersion > this.renderedVersion;
    if (!this.available && !forcePending) return;

    const throttleWait = this.minIntervalMs - (Date.now() - this.lastRenderCompletedAt);
    if (!forcePending && !this.bypassThrottle && throttleWait > 0) {
      const ownerWindow = this.getOwnerWindow();
      if (!ownerWindow) {
        this.bypassThrottle = true;
        void this.runRender();
        return;
      }

      this.scheduledFrame = scheduleDelayedFrame(() => {
        this.scheduledFrame = null;
        this.schedule();
      }, throttleWait, ownerWindow);
      return;
    }

    this.bypassThrottle = false;
    const snapshot = this.latestSnapshot;
    const version = this.requestedVersion;
    const renderGeneration = this.generation;
    this.renderRunning = true;

    try {
      await this.render(snapshot);
    } catch {
      // Rendering owns user-visible fallback. Treat the snapshot as consumed so
      // a renderer failure cannot stall stream finalization.
    } finally {
      this.renderRunning = false;
    }

    if (renderGeneration !== this.generation) {
      this.schedule(true);
      return;
    }

    this.renderedVersion = Math.max(this.renderedVersion, version);
    this.lastRenderCompletedAt = Date.now();
    if (this.forceThroughVersion <= this.renderedVersion) {
      this.forceThroughVersion = 0;
    }
    this.resolveCompletedWaiters();

    if (this.requestedVersion > this.renderedVersion) {
      if (this.forceThroughVersion > this.renderedVersion) {
        void this.runRender();
      } else {
        this.schedule();
      }
    }
  }

  private waitForVersion(version: number): Promise<void> {
    if (version <= this.renderedVersion) return Promise.resolve();

    return new Promise(resolve => {
      this.waiters.push({ version, resolve });
    });
  }

  private resolveCompletedWaiters(): void {
    const pending: RenderWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.version <= this.renderedVersion) {
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    this.waiters = pending;
  }

  private resolveAllWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private cancelScheduledFrame(): void {
    if (!this.scheduledFrame) return;

    cancelScheduledAnimationFrame(this.scheduledFrame);
    this.scheduledFrame = null;
  }
}
