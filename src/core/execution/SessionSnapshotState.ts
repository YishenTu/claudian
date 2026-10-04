import type { ProviderId } from '../types/provider';
import type {
  ProviderSessionEvent,
  ProviderSessionEventScope,
  WithoutEventScope,
} from './ProviderExecutionEvent';
import type {
  ProviderSessionInvalidation,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
} from './ProviderSessionSnapshot';

type ProviderStateRecord = Record<string, unknown>;

export interface SessionSnapshotStateOptions {
  readonly providerId: ProviderId;
  readonly sessionInstanceId: string;
  /** Initial opaque provider state; copied, never retained. */
  readonly providerState?: Readonly<ProviderStateRecord>;
  /** Native session identity at snapshot time. */
  readonly readProviderSessionId: () => string | null | undefined;
  /**
   * Overlays provider-owned fields onto a private copy of the stored state at
   * snapshot time. Recorded deletions still apply to the projected result.
   */
  readonly projectProviderState?: (state: ProviderStateRecord) => ProviderStateRecord;
}

/**
 * Status, revision, invalidation, opaque provider state, and session-channel
 * fan-out behind `ProviderExecutionSession.getSnapshot()`/`onEvent()`.
 *
 * Revisions change only through status updates or `bumpRevision()`, so a
 * provider can batch provider-state edits into one revision. Snapshots are
 * immutable copies; listener failures never reach the provider lifecycle.
 */
export class SessionSnapshotState {
  readonly #options: SessionSnapshotStateOptions;
  readonly #providerState: ProviderStateRecord;
  readonly #providerStateDeletes = new Set<string>();
  readonly #listeners = new Set<(event: ProviderSessionEvent) => void>();
  #status: ProviderSessionStatus = 'idle';
  #invalidation: ProviderSessionInvalidation | undefined;
  #revision = 0;
  #sequence = 0;

  constructor(options: SessionSnapshotStateOptions) {
    this.#options = options;
    this.#providerState = { ...(options.providerState ?? {}) };
  }

  get status(): ProviderSessionStatus {
    return this.#status;
  }

  get invalidation(): ProviderSessionInvalidation | undefined {
    return this.#invalidation;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Live stored provider state, before projection. */
  get providerState(): Readonly<ProviderStateRecord> {
    return this.#providerState;
  }

  setStatus(status: Exclude<ProviderSessionStatus, 'invalidated'>): void {
    this.#status = status;
    this.#invalidation = undefined;
    this.#revision += 1;
  }

  invalidate(invalidation: ProviderSessionInvalidation): void {
    this.#status = 'invalidated';
    this.#invalidation = Object.freeze({ ...invalidation });
    this.#revision += 1;
  }

  bumpRevision(): void {
    this.#revision += 1;
  }

  hasProviderStateValue(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#providerState, key);
  }

  setProviderStateValue(key: string, value: unknown): void {
    this.#providerState[key] = value;
    this.#providerStateDeletes.delete(key);
  }

  /** Removes the key and records it so persistence deletes it too. */
  deleteProviderStateValue(key: string): void {
    delete this.#providerState[key];
    this.#providerStateDeletes.add(key);
  }

  getSnapshot(): ProviderSessionSnapshot {
    const stored = structuredClone(this.#providerState);
    const providerState = this.#options.projectProviderState?.(stored) ?? stored;
    for (const key of this.#providerStateDeletes) {
      delete providerState[key];
    }
    const providerStateDeletes = [...this.#providerStateDeletes];
    const providerSessionId = this.#options.readProviderSessionId();
    const base = {
      providerId: this.#options.providerId,
      revision: this.#revision,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(Object.keys(providerState).length > 0
        ? { providerState: Object.freeze(providerState) }
        : {}),
      ...(providerStateDeletes.length > 0
        ? { providerStateDeletes: Object.freeze(providerStateDeletes) }
        : {}),
    };
    if (this.#status === 'invalidated') {
      return Object.freeze({
        ...base,
        status: 'invalidated' as const,
        invalidation: this.#invalidation ?? Object.freeze({
          reason: 'provider-error' as const,
          recoverable: true,
        }),
      });
    }
    return Object.freeze({ ...base, status: this.#status });
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Delivers an out-of-turn event under the next session-channel sequence. */
  emit(event: WithoutEventScope<ProviderSessionEvent>): ProviderSessionEventScope {
    const scope: ProviderSessionEventScope = Object.freeze({
      kind: 'session',
      sessionInstanceId: this.#options.sessionInstanceId,
      sequence: ++this.#sequence,
    });
    this.notify({ ...event, scope } as ProviderSessionEvent);
    return scope;
  }

  /** Delivers an event whose provider already owns its scope, e.g. background turns. */
  notify(event: ProviderSessionEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Session listeners cannot interfere with the native provider lifecycle.
      }
    }
  }

  clearListeners(): void {
    this.#listeners.clear();
  }
}
