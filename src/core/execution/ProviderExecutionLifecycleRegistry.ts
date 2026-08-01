import { AsyncLocalStorage } from 'node:async_hooks';

import { toError } from '../../utils/error';
import type { ProviderId } from '../types/provider';
import type {
  ProviderExecutionBackend,
  ProviderSessionConfig,
} from './ProviderExecutionBackend';
import type { ProviderExecutionSession } from './ProviderExecutionSession';

export type ProviderExecutionOwnerKind =
  | 'chat'
  | 'title'
  | 'instruction'
  | 'inline-edit'
  | 'warmup';

export type ProviderExecutionInvalidationReason =
  | {
      readonly kind: 'provider-transition';
      readonly providerId: ProviderId;
      readonly generation: number;
    }
  | {
      readonly kind: 'registry-disposed';
      readonly providerId: ProviderId;
      readonly generation: number;
    };

export interface ProviderExecutionSessionLease {
  readonly generation: number;
  readonly session: ProviderExecutionSession;
  isCurrent(): boolean;
  onInvalidated(
    listener: (reason: ProviderExecutionInvalidationReason) => void,
  ): () => void;
  release(): Promise<void>;
}

export interface ProviderExecutionTransitionContext {
  readonly providerId: ProviderId;
  readonly generation: number;
}

type ProviderExecutionTransitionCallback = (
  context: ProviderExecutionTransitionContext,
) => void | Promise<void>;

export type ProviderExecutionTransitionHook =
  | {
      beforeTransition: ProviderExecutionTransitionCallback;
      afterTransition?: ProviderExecutionTransitionCallback;
    }
  | {
      beforeTransition?: ProviderExecutionTransitionCallback;
      afterTransition: ProviderExecutionTransitionCallback;
    };

export class ProviderExecutionTransitionError extends Error {
  readonly retryable = true;

  constructor(readonly providerId: ProviderId) {
    super(`Provider execution transition is active for "${providerId}"`);
    this.name = 'ProviderExecutionTransitionError';
  }
}

export class ProviderExecutionRegistryDisposedError extends Error {
  readonly retryable = false;

  constructor() {
    super('Provider execution lifecycle registry is disposed');
    this.name = 'ProviderExecutionRegistryDisposedError';
  }
}

interface ProviderLifecycleState {
  generation: number;
  transitionReservations: number;
  readonly leases: Set<ProviderExecutionSessionLeaseImpl>;
  readonly hooks: Set<ProviderExecutionTransitionHook>;
  readonly lock: AsyncLock;
}

interface ActiveProviderTransition {
  active: boolean;
  readonly providerIds: ReadonlySet<ProviderId>;
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    this.tail = previous.then(() => next);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseNext();
    };
  }
}

class ProviderExecutionSessionLeaseImpl
  implements ProviderExecutionSessionLease {
  private invalidationReason: ProviderExecutionInvalidationReason | null = null;
  private readonly invalidationListeners = new Set<
    (reason: ProviderExecutionInvalidationReason) => void
  >();
  private releasePromise: Promise<void> | null = null;
  private released = false;

  constructor(
    readonly generation: number,
    readonly session: ProviderExecutionSession,
    readonly owner: ProviderExecutionOwnerKind,
    private readonly state: ProviderLifecycleState,
  ) {}

  isCurrent(): boolean {
    return (
      !this.released &&
      this.invalidationReason === null &&
      this.state.generation === this.generation &&
      this.state.leases.has(this)
    );
  }

  onInvalidated(
    listener: (reason: ProviderExecutionInvalidationReason) => void,
  ): () => void {
    if (this.invalidationReason) {
      this.notifyListener(listener, this.invalidationReason);
      return () => undefined;
    }

    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;

    this.released = true;
    this.invalidationListeners.clear();
    let disposal: Promise<void>;
    try {
      disposal = this.session.dispose();
    } catch (error) {
      disposal = Promise.reject(toError(
        error,
        'Provider execution session disposal failed',
      ));
    }
    this.releasePromise = disposal.finally(() => {
      this.state.leases.delete(this);
    });
    return this.releasePromise;
  }

  invalidate(reason: ProviderExecutionInvalidationReason): void {
    if (this.invalidationReason || this.released) return;

    this.invalidationReason = reason;
    const listeners = [...this.invalidationListeners];
    this.invalidationListeners.clear();
    for (const listener of listeners) {
      this.notifyListener(listener, reason);
    }
  }

  private notifyListener(
    listener: (reason: ProviderExecutionInvalidationReason) => void,
    reason: ProviderExecutionInvalidationReason,
  ): void {
    try {
      listener(reason);
    } catch {
      // A feature listener cannot interfere with provider lifecycle cleanup.
    }
  }
}

/**
 * Application-scoped tracker and transition gate for every execution session.
 *
 * The registry owns discoverability, generation fencing, and forced quiescence.
 * Feature coordinators retain all workflow and session-reuse decisions.
 */
export class ProviderExecutionLifecycleRegistry {
  private readonly states = new Map<ProviderId, ProviderLifecycleState>();
  private readonly activeTransition =
    new AsyncLocalStorage<ActiveProviderTransition>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  acquire(
    backend: ProviderExecutionBackend,
    config: ProviderSessionConfig,
    owner: ProviderExecutionOwnerKind,
  ): ProviderExecutionSessionLease {
    this.assertAvailable();
    const state = this.getOrCreateState(backend.providerId);
    if (state.transitionReservations > 0) {
      throw new ProviderExecutionTransitionError(backend.providerId);
    }

    const session = backend.createSession(config);
    const lease = new ProviderExecutionSessionLeaseImpl(
      state.generation,
      session,
      owner,
      state,
    );
    state.leases.add(lease);
    return lease;
  }

  getProviderGeneration(providerId: ProviderId): number {
    return this.states.get(providerId)?.generation ?? 0;
  }

  async runTransition<T>(
    providerIds: ProviderId[],
    mutation: () => Promise<T>,
  ): Promise<T> {
    this.assertAvailable();
    const orderedProviderIds = [...new Set(providerIds)].sort();
    const parentTransition = this.activeTransition.getStore();
    if (parentTransition?.active) {
      const rejectedProviderId =
        orderedProviderIds[0]
        ?? [...parentTransition.providerIds].sort()[0];
      if (rejectedProviderId) {
        throw new ProviderExecutionTransitionError(rejectedProviderId);
      }
    }

    const transition: ActiveProviderTransition = {
      active: true,
      providerIds: new Set([
        ...(parentTransition?.active ? parentTransition.providerIds : []),
        ...orderedProviderIds,
      ]),
    };
    try {
      return await this.activeTransition.run(transition, () =>
        this.runTransitionWithLocks(orderedProviderIds, mutation),
      );
    } finally {
      transition.active = false;
    }
  }

  private async runTransitionWithLocks<T>(
    orderedProviderIds: ProviderId[],
    mutation: () => Promise<T>,
  ): Promise<T> {
    const states = orderedProviderIds.map((providerId) => ({
      providerId,
      state: this.getOrCreateState(providerId),
    }));
    const releaseLocks: Array<() => void> = [];
    for (const { state } of states) {
      state.transitionReservations += 1;
    }

    try {
      for (const { state } of states) {
        releaseLocks.push(await state.lock.acquire());
      }

      this.assertAvailable();

      const contexts = states.map(({ providerId, state }) => {
        state.generation += 1;
        return {
          providerId,
          generation: state.generation,
        } satisfies ProviderExecutionTransitionContext;
      });

      const errors: unknown[] = [];
      let result: T | undefined;
      let hasResult = false;
      const transitionHooks = states.map(({ state }) => [...state.hooks]);

      try {
        const leases = states.flatMap(({ providerId, state }) => {
          const reason: ProviderExecutionInvalidationReason = {
            kind: 'provider-transition',
            providerId,
            generation: state.generation,
          };
          return [...state.leases].map((lease) => {
            lease.invalidate(reason);
            return lease;
          });
        });
        errors.push(...await settleFailures(leases.map((lease) => lease.release())));

        if (errors.length === 0) {
          for (let index = 0; index < states.length; index += 1) {
            for (const hook of transitionHooks[index]) {
              if (!hook.beforeTransition) continue;
              try {
                await hook.beforeTransition(contexts[index]);
              } catch (error) {
                errors.push(error);
              }
            }
          }

          if (errors.length === 0) {
            result = await mutation();
            hasResult = true;
          }
        }
      } catch (error) {
        errors.push(error);
      } finally {
        for (let index = states.length - 1; index >= 0; index -= 1) {
          const hooks = [...transitionHooks[index]].reverse();
          for (const hook of hooks) {
            if (!hook.afterTransition) continue;
            try {
              await hook.afterTransition(contexts[index]);
            } catch (error) {
              errors.push(error);
            }
          }
        }
      }

      if (errors.length > 0) {
        throw combineErrors(errors, 'Provider execution transition failed');
      }
      if (!hasResult) {
        throw new Error('Provider execution transition completed without a result');
      }
      return result as T;
    } finally {
      for (const { state } of states) {
        state.transitionReservations -= 1;
      }
      for (let index = releaseLocks.length - 1; index >= 0; index -= 1) {
        releaseLocks[index]();
      }
    }
  }

  registerTransitionHook(
    providerId: ProviderId,
    hook: ProviderExecutionTransitionHook,
  ): () => void {
    this.assertAvailable();
    const state = this.getOrCreateState(providerId);
    state.hooks.add(hook);

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      state.hooks.delete(hook);
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this.disposed = true;
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  private async disposeAll(): Promise<void> {
    const states = [...this.states.entries()]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([providerId, state]) => ({ providerId, state }));
    const releaseLocks: Array<() => void> = [];
    const errors: unknown[] = [];

    try {
      for (const { state } of states) {
        releaseLocks.push(await state.lock.acquire());
      }

      const leases = states.flatMap(({ providerId, state }) => {
        state.transitionReservations += 1;
        state.generation += 1;
        const reason: ProviderExecutionInvalidationReason = {
          kind: 'registry-disposed',
          providerId,
          generation: state.generation,
        };
        return [...state.leases].map((lease) => {
          lease.invalidate(reason);
          return lease;
        });
      });

      errors.push(...await settleFailures(leases.map((lease) => lease.release())));
    } finally {
      for (let index = releaseLocks.length - 1; index >= 0; index -= 1) {
        releaseLocks[index]();
      }
    }

    if (errors.length > 0) {
      throw combineErrors(errors, 'Provider execution registry disposal failed');
    }
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new ProviderExecutionRegistryDisposedError();
    }
  }

  private getOrCreateState(providerId: ProviderId): ProviderLifecycleState {
    let state = this.states.get(providerId);
    if (!state) {
      state = {
        generation: 0,
        transitionReservations: 0,
        leases: new Set(),
        hooks: new Set(),
        lock: new AsyncLock(),
      };
      this.states.set(providerId, state);
    }
    return state;
  }
}

async function settleFailures(promises: Promise<void>[]): Promise<unknown[]> {
  const results = await Promise.allSettled(promises);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      failures.push(reason);
    }
  }
  return failures;
}

function combineErrors(errors: unknown[], prefix: string): unknown {
  if (errors.length === 1) return errors[0];
  const firstMessage =
    errors[0] instanceof Error ? errors[0].message : String(errors[0]);
  return new AggregateError(errors, `${prefix}: ${firstMessage}`);
}
