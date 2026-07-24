import type { ProviderCommandDiscoveryResult } from './ProviderCommandDiscoveryResult';

export type ProviderCommandDiscoverySnapshot<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | ProviderCommandDiscoveryResult<T>;

export interface ProviderCommandDiscoverySource<T> {
  getSnapshot(): ProviderCommandDiscoverySnapshot<T>;
  load(): Promise<ProviderCommandDiscoveryResult<T>>;
  retry(): Promise<ProviderCommandDiscoveryResult<T>>;
  subscribe(listener: () => void): () => void;
}

export interface ProviderCommandDiscoveryController<T>
  extends ProviderCommandDiscoverySource<T> {
  invalidate(): void;
}

export interface ProviderCommandDiscoveryStoreOptions {
  /** Evicts upstream discovery state before retry observers can start a new load. */
  onBeforeRetry?: () => void;
  timeoutMs?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000;

function cloneResult<T>(
  result: ProviderCommandDiscoveryResult<T>,
): ProviderCommandDiscoveryResult<T> {
  if (result.status !== 'ready') {
    return result;
  }

  return {
    status: 'ready',
    items: [...result.items] as [T, ...T[]],
  };
}

export class ProviderCommandDiscoveryStore<T>
implements ProviderCommandDiscoveryController<T> {
  private snapshot: ProviderCommandDiscoverySnapshot<T> = { status: 'idle' };
  private inFlight: Promise<ProviderCommandDiscoveryResult<T>> | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly onBeforeRetry: (() => void) | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly loader: () => Promise<ProviderCommandDiscoveryResult<T>>,
    options: ProviderCommandDiscoveryStoreOptions = {},
  ) {
    this.onBeforeRetry = options.onBeforeRetry;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  }

  getSnapshot(): ProviderCommandDiscoverySnapshot<T> {
    if (this.snapshot.status !== 'ready') {
      return this.snapshot;
    }

    return {
      status: 'ready',
      items: [...this.snapshot.items] as [T, ...T[]],
    };
  }

  load(): Promise<ProviderCommandDiscoveryResult<T>> {
    if (this.inFlight) {
      return this.inFlight;
    }
    if (this.snapshot.status !== 'idle' && this.snapshot.status !== 'loading') {
      return Promise.resolve(cloneResult(this.snapshot));
    }

    const generation = this.generation;
    const load = this.loadWithTimeout()
      .catch((): ProviderCommandDiscoveryResult<T> => ({
        status: 'error',
        message: 'Could not load provider commands',
        retryable: true,
      }))
      .then((result) => {
        if (this.generation === generation) {
          this.snapshot = cloneResult(result);
          this.notify();
        }
        return cloneResult(result);
      })
      .finally(() => {
        if (this.inFlight === load) {
          this.inFlight = null;
        }
      });

    this.inFlight = load;
    this.snapshot = { status: 'loading' };
    this.notify();
    return load;
  }

  retry(): Promise<ProviderCommandDiscoveryResult<T>> {
    this.onBeforeRetry?.();
    this.invalidate();
    return this.load();
  }

  invalidate(): void {
    this.generation++;
    this.inFlight = null;
    this.snapshot = { status: 'idle' };
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async loadWithTimeout(): Promise<ProviderCommandDiscoveryResult<T>> {
    let timeoutId: number | null = null;
    const timeout = new Promise<ProviderCommandDiscoveryResult<T>>(resolve => {
      timeoutId = window.setTimeout(() => resolve({
        status: 'error',
        message: 'Provider command discovery timed out',
        retryable: true,
      }), this.timeoutMs);
    });

    try {
      return await Promise.race([this.loader(), timeout]);
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One consumer must not prevent other discovery observers from updating.
      }
    }
  }
}
