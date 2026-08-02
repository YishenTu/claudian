import { throwIfAborted, toAbortError } from '../../../utils/abort';

export interface ProviderTransitionFenceOptions {
  readonly abortMessage?: string;
}

interface TransitionWaiter {
  readonly onAbort?: () => void;
  readonly reject: (error: unknown) => void;
  readonly resolve: (available: boolean) => void;
  readonly signal?: AbortSignal;
}

const DEFAULT_ABORT_MESSAGE = 'Provider transition wait aborted';

export class ProviderTransitionFence {
  private readonly abortMessage: string;
  private disposed = false;
  private transitionDepth = 0;
  private readonly waiters = new Set<TransitionWaiter>();

  constructor(options: ProviderTransitionFenceOptions = {}) {
    this.abortMessage = options.abortMessage ?? DEFAULT_ABORT_MESSAGE;
  }

  beginTransition(): void {
    if (this.disposed) return;
    this.transitionDepth += 1;
  }

  endTransition(): void {
    if (this.disposed || this.transitionDepth === 0) return;
    this.transitionDepth -= 1;
    if (this.transitionDepth === 0) this.releaseWaiters(true);
  }

  isUnavailable(): boolean {
    return this.disposed || this.transitionDepth > 0;
  }

  async waitUntilAvailable(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal, this.abortMessage);
    if (this.disposed) return false;
    if (this.transitionDepth === 0) return true;

    return await new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.waiters.delete(waiter)) return;
        this.removeAbortListener(waiter);
        reject(toAbortError(signal!, this.abortMessage));
      };
      const waiter: TransitionWaiter = {
        reject,
        resolve,
        ...(signal ? { onAbort, signal } : {}),
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transitionDepth = 0;
    this.releaseWaiters(false);
  }

  private releaseWaiters(available: boolean): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      this.removeAbortListener(waiter);
      waiter.resolve(available);
    }
  }

  private removeAbortListener(waiter: TransitionWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}
