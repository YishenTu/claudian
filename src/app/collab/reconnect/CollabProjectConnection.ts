import type { CollabConnectionStatus } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type CollabEventConnectionState = 'connecting' | 'connected' | 'unsubscribed' | CollabError;

export interface CollabProjectConnectionOptions {
  readonly onStatusChange: (status: CollabConnectionStatus) => void;
  readonly reconnect: (signal: AbortSignal, eventsRequired: boolean) => Promise<'connected' | 'retry' | 'unavailable'>;
}

function isRetryableConnectionFailure(error: unknown): boolean {
  return error instanceof CollabError
    && error.code !== 'tls-ca-mismatch' && error.code !== 'tls-untrusted'
    && (error.group === 'connectivity' || error.code === 'operation-timeout'
      || error.code === 'operation-failed');
}

export class CollabProjectConnection {
  private readonly controller = new AbortController();
  private pending: Promise<boolean> | null = null;
  private attemptController: AbortController | null = null;
  private eventsRequired = false;
  private eventsConverged = false;
  private retryTimer: number | null = null;
  private retryAttempt = 0;
  private retryRequested = false;
  private revision = 0;
  private successRevision = 0;
  private lastFailure: CollabError | null = null;
  private observedStatus: CollabConnectionStatus = 'offline';

  constructor(private readonly options: CollabProjectConnectionOptions) {}

  get status(): CollabConnectionStatus {
    return this.observedStatus;
  }

  get failure(): CollabError | null {
    return this.lastFailure;
  }

  reconnect(): Promise<boolean> {
    if (this.controller.signal.aborted || this.observedStatus === 'needs-attention') return Promise.resolve(false);
    if (this.pending) return this.pending;
    this.#clearRetry();
    const attemptController = new AbortController();
    this.attemptController = attemptController;
    const revision = this.revision;
    const successRevision = this.successRevision;
    const pending = Promise.resolve().then(() => (
      attemptController.signal.aborted ? 'unavailable' : this.options.reconnect(attemptController.signal, this.eventsRequired)
    )).then(result => {
      if (attemptController.signal.aborted) return false;
      if (revision === this.revision) {
        if (result === 'connected') this.observeSuccess();
        else if (result === 'retry') {
          this.retryRequested = true;
          this.#setStatus('offline');
        } else {
          this.retryRequested = false;
        }
      }
      return result === 'connected' && this.observedStatus === 'connected';
    }, error => {
      if (!attemptController.signal.aborted && (revision === this.revision
        || (!isRetryableConnectionFailure(error) && successRevision === this.successRevision))) {
        this.observeFailure(error);
      }
      if (isRetryableConnectionFailure(error)) return false;
      throw error;
    }).finally(() => {
      if (this.pending === pending) {
        this.pending = null;
        this.attemptController = null;
        if (this.retryRequested) this.#scheduleRetry();
      }
    });
    this.pending = pending;
    return pending;
  }

  observeControlSuccess(): void {
    if (!this.pending && !this.retryRequested && !this.eventsRequired) this.observeSuccess();
  }

  observeSuccess(): void {
    if (this.controller.signal.aborted || (this.eventsRequired && !this.eventsConverged)) return;
    this.revision += 1;
    this.successRevision += 1;
    this.lastFailure = null;
    this.retryAttempt = 0;
    this.retryRequested = false;
    this.#clearRetry();
    this.#setStatus('connected');
  }

  requireEvents(): void {
    if (!this.controller.signal.aborted) this.eventsRequired = true;
  }

  releaseEvents(): void {
    this.eventsRequired = false;
    this.eventsConverged = false;
    this.retryRequested = false;
    this.#clearRetry();
    this.attemptController?.abort();
  }

  observeEvents(state: CollabEventConnectionState): void {
    if (this.controller.signal.aborted) return;
    if (state === 'unsubscribed') { this.releaseEvents(); return; }
    this.eventsRequired = true;
    this.eventsConverged = state === 'connected';
    if (state instanceof CollabError) this.observeFailure(state);
    else if (state === 'connected') this.observeSuccess();
    else if (state === 'connecting' && this.observedStatus !== 'needs-attention') this.#setStatus('offline');
  }

  invalidate(preserveAttempt = false): void {
    if (this.controller.signal.aborted) return;
    if (!preserveAttempt) {
      this.revision += 1;
      this.attemptController?.abort();
    }
    this.lastFailure = null;
    this.eventsConverged = false;
    this.retryRequested = true;
    this.#clearRetry();
    this.#setStatus('offline');
    this.#scheduleRetry();
  }

  observeFailure(error: unknown): void {
    if (this.controller.signal.aborted) return;
    if (error instanceof CollabError && error.code === 'cancelled') return;
    if (!(error instanceof CollabError)) return;
    if (error.group !== 'connectivity' && error.code !== 'operation-timeout'
      && error.code !== 'operation-failed' && error.code !== 'protocol-payload-invalid'
      && error.code !== 'protocol-version-unsupported'
      && error.group !== 'authorization' && error.group !== 'integrity') return;
    const retryable = isRetryableConnectionFailure(error);
    if (retryable && this.observedStatus === 'needs-attention') return;
    this.lastFailure = error;
    if (!retryable) this.revision += 1;
    if (retryable) {
      this.retryRequested = true;
      this.#setStatus('offline');
      this.#scheduleRetry();
    } else {
      this.#clearRetry();
      this.retryRequested = false;
      this.#setStatus('needs-attention');
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    this.attemptController?.abort();
    this.#clearRetry();
    await this.pending?.catch(() => undefined);
  }

  #scheduleRetry(): void {
    if (!this.eventsRequired || this.pending || this.retryTimer !== null || this.controller.signal.aborted) return;
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
