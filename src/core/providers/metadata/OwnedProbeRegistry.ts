import { throwIfAborted, toAbortError } from '../../../utils/abort';

export interface OwnedProbeRegistryOptions<TResource> {
  readonly abortMessage?: string;
  readonly dispose: (resource: TResource) => Promise<void> | void;
  readonly unavailableError?: () => Error;
}

export interface OwnedProbeOperation<TResource, TResult> {
  readonly create: (signal: AbortSignal) => Promise<TResource> | TResource;
  readonly initialize?: (
    resource: TResource,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly query: (
    resource: TResource,
    signal: AbortSignal,
  ) => Promise<TResult>;
}

interface ActiveProbe<TResource> {
  cleanupFlight: Promise<void> | null;
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  hasResource: boolean;
  resolveCompletion(): void;
  resource?: TResource;
}

const DEFAULT_ABORT_MESSAGE = 'Provider metadata probe aborted';

export class OwnedProbeRegistry<TResource> {
  private readonly abortMessage: string;
  private readonly activeProbes = new Set<ActiveProbe<TResource>>();
  private disposed = false;
  private disposeFlight: Promise<void> | null = null;

  constructor(private readonly options: OwnedProbeRegistryOptions<TResource>) {
    this.abortMessage = options.abortMessage ?? DEFAULT_ABORT_MESSAGE;
  }

  async run<TResult>(
    operation: OwnedProbeOperation<TResource, TResult>,
    callerSignal?: AbortSignal,
  ): Promise<TResult> {
    if (this.disposed) throw this.createUnavailableError();
    throwIfAborted(callerSignal, this.abortMessage);

    let resolveCompletion!: () => void;
    const entry: ActiveProbe<TResource> = {
      cleanupFlight: null,
      completion: new Promise(resolve => { resolveCompletion = resolve; }),
      controller: new AbortController(),
      hasResource: false,
      resolveCompletion: () => resolveCompletion(),
    };
    const onAbort = (): void => {
      entry.controller.abort(toAbortError(callerSignal!, this.abortMessage));
      void this.cleanupProbe(entry);
    };
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    this.activeProbes.add(entry);
    if (callerSignal?.aborted) onAbort();

    try {
      entry.controller.signal.throwIfAborted();
      const created = operation.create(entry.controller.signal);
      entry.resource = isPromiseLike<TResource>(created)
        ? await created
        : created;
      entry.hasResource = true;
      entry.controller.signal.throwIfAborted();
      const initialization = operation.initialize?.(
        entry.resource,
        entry.controller.signal,
      );
      if (initialization) await initialization;
      entry.controller.signal.throwIfAborted();
      const query = operation.query(entry.resource, entry.controller.signal);
      const result = await query;
      entry.controller.signal.throwIfAborted();
      return result;
    } finally {
      callerSignal?.removeEventListener('abort', onAbort);
      await this.cleanupProbe(entry);
      this.activeProbes.delete(entry);
      entry.resolveCompletion();
    }
  }

  async quiesce(): Promise<void> {
    const active = [...this.activeProbes];
    for (const entry of active) entry.controller.abort();
    await Promise.all(active.map(entry => this.cleanupProbe(entry)));
    await Promise.all(active.map(entry => entry.completion));
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.disposed = true;
    this.disposeFlight = this.quiesce();
    return this.disposeFlight;
  }

  private cleanupProbe(entry: ActiveProbe<TResource>): Promise<void> {
    if (entry.cleanupFlight) return entry.cleanupFlight;
    if (!entry.hasResource) return Promise.resolve();
    const resource = entry.resource as TResource;
    entry.hasResource = false;
    entry.resource = undefined;
    entry.cleanupFlight = Promise.resolve()
      .then(() => this.options.dispose(resource))
      .catch(() => undefined);
    return entry.cleanupFlight;
  }

  private createUnavailableError(): Error {
    return this.options.unavailableError?.()
      ?? new Error('Provider metadata probe registry is disposed.');
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}
