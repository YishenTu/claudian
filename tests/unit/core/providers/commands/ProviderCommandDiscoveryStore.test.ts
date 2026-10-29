import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from '@/core/providers/commands/ProviderCommandDiscoveryStore';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('ProviderCommandDiscoveryStore', () => {
  it('shares an in-flight load and caches its terminal result', async () => {
    const response = deferred<ProviderCommandDiscoveryResult<string>>();
    const loader = vi.fn().mockReturnValue(response.promise);
    const store = new ProviderCommandDiscoveryStore(loader);

    const first = store.load();
    const second = store.load();

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ status: 'loading' });

    response.resolve({ status: 'ready', items: ['review'] });
    await first;

    expect(store.getSnapshot()).toEqual({ status: 'ready', items: ['review'] });
    await store.load();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when loading and terminal state change', async () => {
    const loader = vi.fn().mockResolvedValue({ status: 'empty' });
    const store = new ProviderCommandDiscoveryStore<string>(loader);
    const statuses: string[] = [];
    const unsubscribe = store.subscribe(() => {
      statuses.push(store.getSnapshot().status);
    });

    await store.load();

    expect(statuses).toEqual(['loading', 'empty']);
    unsubscribe();
  });

  it('invalidates a cached result and ignores stale completion', async () => {
    const stale = deferred<ProviderCommandDiscoveryResult<string>>();
    const signals: AbortSignal[] = [];
    const loader = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1
        ? stale.promise
        : Promise.resolve({
          status: 'ready',
          items: ['fresh'],
        } as ProviderCommandDiscoveryResult<string>);
    });
    const store = new ProviderCommandDiscoveryStore(loader);

    const staleLoad = store.load();
    store.invalidate();
    expect(signals[0]?.aborted).toBe(true);

    const freshLoad = store.load();
    expect(signals[1]?.aborted).toBe(false);
    await freshLoad;

    stale.resolve({ status: 'ready', items: ['stale'] });
    await staleLoad;

    expect(store.getSnapshot()).toEqual({ status: 'ready', items: ['fresh'] });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps errors cached until retry is requested', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ status: 'ready', items: ['review'] });
    const store = new ProviderCommandDiscoveryStore<string>(loader);

    await store.load();
    expect(store.getSnapshot()).toEqual({
      status: 'error',
      message: 'Could not load provider commands',
      retryable: true,
    });

    await store.load();
    expect(loader).toHaveBeenCalledTimes(1);

    await store.retry();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({ status: 'ready', items: ['review'] });
  });

  it('prepares external cache state before notifying subscribers of a retry', async () => {
    let retryPrepared = false;
    const loader = vi.fn()
      .mockResolvedValueOnce({
        status: 'error',
        message: 'Offline',
        retryable: true,
      })
      .mockResolvedValueOnce({ status: 'empty' });
    const store = new ProviderCommandDiscoveryStore<string>(loader, {
      onBeforeRetry: () => {
        retryPrepared = true;
      },
    });
    const preparationStates: boolean[] = [];
    store.subscribe(() => {
      if (store.getSnapshot().status === 'idle') {
        preparationStates.push(retryPrepared);
      }
    });

    await store.load();
    await store.retry();

    expect(preparationStates).toEqual([true]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('renews ended observation on invalidation only while its caller lifetime remains active', async () => {
    const observations: { signal: AbortSignal; onChange(): void; finish(): void }[] = [];
    let commands = ['initial'];
    const loader = vi.fn(async () => ({ status: 'ready' as const, items: commands as [string, ...string[]] }));
    const store = new ProviderCommandDiscoveryStore(loader, {
      watchChanges: (signal, onChange) => new Promise<void>(finish => { observations.push({ signal, onChange, finish }); }),
    });
    const menu = new AbortController();
    try {
      await store.load();
      store.watch(menu.signal);
      observations[0].finish();
      await new Promise(resolve => setTimeout(resolve, 0));
      store.invalidate();
      expect(observations).toHaveLength(2);
      expect(observations[0].signal.aborted).toBe(true);
      expect(observations[1].signal.aborted).toBe(false);
      await store.load();
      commands = ['updated'];
      observations[1].onChange();
      await store.load();
      expect(store.getSnapshot()).toEqual({ status: 'ready', items: ['updated'] });
      menu.abort();
      store.invalidate();
      expect(observations[1].signal.aborted).toBe(true);
      expect(observations).toHaveLength(2);
      const calls = loader.mock.calls.length;
      observations[1].onChange();
      expect(loader).toHaveBeenCalledTimes(calls);
    } finally { menu.abort(); store.dispose(); for (const observation of observations) observation.finish(); }
  });

  it('turns an unresponsive load into a retryable timeout', async () => {
    vi.useFakeTimers();
    try {
      let loaderSignal: AbortSignal | null = null;
      const store = new ProviderCommandDiscoveryStore<string>(
        (signal) => {
          loaderSignal = signal;
          return new Promise(() => undefined);
        },
        { timeoutMs: 100 },
      );

      const load = store.load();
      await vi.advanceTimersByTimeAsync(100);
      await load;

      expect((loaderSignal as AbortSignal | null)?.aborted).toBe(true);
      expect(store.getSnapshot()).toEqual({
        status: 'error',
        message: 'Provider command discovery timed out',
        retryable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets provider-owned discovery outlive the shared deadline', async () => {
    vi.useFakeTimers();
    try {
      const response = deferred<ProviderCommandDiscoveryResult<string>>();
      let loaderSignal: AbortSignal | null = null;
      const store = new ProviderCommandDiscoveryStore<string>(
        (signal) => {
          loaderSignal = signal;
          return response.promise;
        },
        { resolveTimeoutMs: () => null },
      );

      const load = store.load();
      await vi.advanceTimersByTimeAsync(8_000);

      expect((loaderSignal as AbortSignal | null)?.aborted).toBe(false);
      expect(store.getSnapshot()).toEqual({ status: 'loading' });

      response.resolve({ status: 'ready', items: ['review'] });
      await expect(load).resolves.toEqual({ status: 'ready', items: ['review'] });
      expect(store.getSnapshot()).toEqual({ status: 'ready', items: ['review'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves the shared deadline again after invalidation', async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<ProviderCommandDiscoveryResult<string>>();
      let timeoutMs: number | null = null;
      const signals: AbortSignal[] = [];
      const store = new ProviderCommandDiscoveryStore<string>(
        (signal) => {
          signals.push(signal);
          return signals.length === 1
            ? first.promise
            : new Promise(() => undefined);
        },
        { resolveTimeoutMs: () => timeoutMs },
      );

      const firstLoad = store.load();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(store.getSnapshot()).toEqual({ status: 'loading' });

      store.invalidate();
      expect(signals[0]?.aborted).toBe(true);
      timeoutMs = 100;

      const secondLoad = store.load();
      await vi.advanceTimersByTimeAsync(100);
      await secondLoad;

      expect(signals[1]?.aborted).toBe(true);
      first.resolve({ status: 'ready', items: ['review'] });
      await firstLoad;
      expect(store.getSnapshot()).toEqual({
        status: 'error',
        message: 'Provider command discovery timed out',
        retryable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
