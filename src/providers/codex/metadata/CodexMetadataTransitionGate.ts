export class CodexMetadataTransitionGate {
  private transitionDepth = 0;
  private transitionPromise: Promise<void> | null = null;
  private releaseTransition: (() => void) | null = null;
  private disposed = false;

  beginTransition(): void {
    if (this.disposed) return;
    this.transitionDepth += 1;
    if (this.transitionDepth > 1) return;

    this.transitionPromise = new Promise<void>((resolve) => {
      this.releaseTransition = resolve;
    });
  }

  endTransition(): void {
    if (this.disposed || this.transitionDepth === 0) return;
    this.transitionDepth -= 1;
    if (this.transitionDepth === 0) this.releaseWaiters();
  }

  isUnavailable(): boolean {
    return this.disposed || this.transitionPromise !== null;
  }

  async waitUntilAvailable(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    while (!this.disposed && this.transitionPromise) {
      await this.waitForTransition(this.transitionPromise, signal);
    }
    return !this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transitionDepth = 0;
    this.releaseWaiters();
  }

  private async waitForTransition(
    transition: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!signal) {
      await transition;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void transition.then(resolve).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private releaseWaiters(): void {
    const release = this.releaseTransition;
    this.releaseTransition = null;
    this.transitionPromise = null;
    release?.();
  }
}
