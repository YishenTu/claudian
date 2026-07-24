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
    const loader = jest.fn().mockReturnValue(response.promise);
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
    const loader = jest.fn().mockResolvedValue({ status: 'empty' });
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
    const loader = jest.fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ status: 'ready', items: ['fresh'] });
    const store = new ProviderCommandDiscoveryStore(loader);

    const staleLoad = store.load();
    store.invalidate();
    const freshLoad = store.load();
    await freshLoad;

    stale.resolve({ status: 'ready', items: ['stale'] });
    await staleLoad;

    expect(store.getSnapshot()).toEqual({ status: 'ready', items: ['fresh'] });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps errors cached until retry is requested', async () => {
    const loader = jest.fn()
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
    const loader = jest.fn()
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

  it('turns an unresponsive load into a retryable timeout', async () => {
    jest.useFakeTimers();
    try {
      const store = new ProviderCommandDiscoveryStore<string>(
        () => new Promise(() => undefined),
        { timeoutMs: 100 },
      );

      const load = store.load();
      await jest.advanceTimersByTimeAsync(100);
      await load;

      expect(store.getSnapshot()).toEqual({
        status: 'error',
        message: 'Provider command discovery timed out',
        retryable: true,
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
