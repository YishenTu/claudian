import type { CollabConnectionStatus } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabProjectConnectionOptions {
  readonly onStatusChange: (status: CollabConnectionStatus) => void;
  readonly reconnect: (signal: AbortSignal) => Promise<'connected' | 'retry' | 'unavailable'>;
}

function isRetryableConnectionFailure(error: unknown): boolean {
  return error instanceof CollabError
    && error.code !== 'tls-ca-mismatch' && error.code !== 'tls-untrusted'
    && (error.group === 'connectivity' || error.code === 'operation-timeout');
}

export class CollabProjectConnection {
  private readonly controller = new AbortController();
  private pending: Promise<boolean> | null = null;
  private retryTimer: number | null = null;
  private retryAttempt = 0;
  private retryRequested = false;
  private revision = 0;
  private successRevision = 0;
  private observedStatus: CollabConnectionStatus = 'offline';

  constructor(private readonly options: CollabProjectConnectionOptions) {}

  get status(): CollabConnectionStatus {
    return this.observedStatus;
  }

  reconnect(): Promise<boolean> {
    if (this.controller.signal.aborted) return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.#clearRetry();
    const revision = this.revision;
    const successRevision = this.successRevision;
    const pending = Promise.resolve().then(() => (
      this.controller.signal.aborted ? 'unavailable' : this.options.reconnect(this.controller.signal)
    )).then(result => {
      if (this.controller.signal.aborted) return false;
      if (revision === this.revision) {
        if (result === 'connected') this.observeSuccess();
        else if (result === 'retry') {
          this.retryRequested = true;
          this.#setStatus('offline');
        } else {
          this.retryRequested = false;
        }
      }
      return result === 'connected';
    }, error => {
      if (!this.controller.signal.aborted && (revision === this.revision
        || (!isRetryableConnectionFailure(error) && successRevision === this.successRevision))) {
        this.observeFailure(error);
      }
      if (isRetryableConnectionFailure(error)) return false;
      throw error;
    }).finally(() => {
      if (this.pending === pending) {
        this.pending = null;
        if (this.retryRequested) this.#scheduleRetry();
      }
    });
    this.pending = pending;
    return pending;
  }

  observeSuccess(): void {
    if (this.controller.signal.aborted) return;
    this.revision += 1;
    this.successRevision += 1;
    this.retryAttempt = 0;
    this.retryRequested = false;
    this.#clearRetry();
    this.#setStatus('connected');
  }

  observeFailure(error: unknown): void {
    if (this.controller.signal.aborted) return;
    if (error instanceof CollabError && error.code === 'cancelled') return;
    if (!(error instanceof CollabError)) return;
    if (error.group !== 'connectivity' && error.code !== 'operation-timeout'
      && error.group !== 'authorization' && error.group !== 'integrity') return;
    const retryable = isRetryableConnectionFailure(error);
    if (retryable && this.observedStatus === 'needs-attention') return;
    this.revision += 1;
    this.#clearRetry();
    if (retryable) {
      this.retryRequested = true;
      this.#setStatus('offline');
      this.#scheduleRetry();
    } else {
      this.retryRequested = false;
      this.#setStatus('needs-attention');
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    this.#clearRetry();
    await this.pending?.catch(() => undefined);
  }

  #scheduleRetry(): void {
    if (this.pending || this.retryTimer !== null || this.controller.signal.aborted) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.retryAttempt++, 5));
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.reconnect().catch(() => undefined);
    }, delay);
  }

  #clearRetry(): void {
    if (this.retryTimer === null) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  #setStatus(status: CollabConnectionStatus): void {
    if (this.observedStatus === status) return;
    this.observedStatus = status;
    this.options.onStatusChange(status);
  }
}
