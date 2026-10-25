import type {
  ProviderExecutionBackend,
  ProviderExecutionInvalidationReason,
  ProviderExecutionLifecycleRegistry,
  ProviderExecutionSession,
  ProviderExecutionSessionLease,
  ProviderSessionConfig,
  ProviderSessionEvent,
} from '@/core/execution';

export interface SupervisedExecutionSession {
  readonly generation: number;
  readonly session: ProviderExecutionSession;
}

interface CurrentSession extends SupervisedExecutionSession {
  readonly lease: ProviderExecutionSessionLease;
  unsubscribeSessionEvents: () => void;
}

/**
 * Owns one lifecycle-registry lease and makes invalidation synchronous from the
 * feature's perspective. Chat workflow and binding decisions remain outside.
 */
export class ExecutionSessionSupervisor {
  private active: CurrentSession | null = null;
  private releasePromise: Promise<void> | null = null;

  constructor(
    private readonly lifecycleRegistry: ProviderExecutionLifecycleRegistry,
  ) {}

  get current(): SupervisedExecutionSession | null {
    return this.active;
  }

  acquire(
    backend: ProviderExecutionBackend,
    config: ProviderSessionConfig,
    onInvalidated: (reason: ProviderExecutionInvalidationReason, released: Promise<void>) => void,
    onSessionEvent?: (event: ProviderSessionEvent) => void,
  ): SupervisedExecutionSession {
    if (this.active) return this.active;

    const lease = this.lifecycleRegistry.acquire(backend, config, 'chat');
    const current: CurrentSession = {
      generation: lease.generation,
      session: lease.session,
      lease,
      unsubscribeSessionEvents: () => undefined,
    };
    this.active = current;
    if (onSessionEvent) {
      current.unsubscribeSessionEvents = lease.session.onEvent((event) => {
        if (this.active !== current || !lease.isCurrent()) return;
        onSessionEvent(event);
      });
    }
    lease.onInvalidated((reason) => {
      if (this.active !== current) return;
      this.active = null;
      current.unsubscribeSessionEvents();
      // The registry releases an invalidated lease in the same turn; joining that release (after it starts)
      // lets the owner settle what the session announces while it shuts down. The registry reports failures.
      onInvalidated(reason, this.#track(Promise.resolve().then(() => current.lease.release()).catch(() => undefined)));
    });
    return current;
  }

  isCurrent(session: ProviderExecutionSession, generation: number): boolean {
    return (
      this.active?.session === session
      && this.active.generation === generation
      && this.active.lease.isCurrent()
    );
  }

  release(): Promise<void> {
    const current = this.active;
    if (!current) return this.releasePromise ?? Promise.resolve();

    this.active = null;
    current.unsubscribeSessionEvents();
    return this.#track(current.lease.release());
  }

  #track(release: Promise<void>): Promise<void> {
    const trackedRelease = release.finally(() => {
      if (this.releasePromise === trackedRelease) {
        this.releasePromise = null;
      }
    });
    this.releasePromise = trackedRelease;
    return trackedRelease;
  }
}
