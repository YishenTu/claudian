import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

interface TestResource {
  readonly id: number;
}

function createRegistry(
  dispose: (resource: TestResource) => Promise<void> | void = () => undefined,
): OwnedProbeRegistry<TestResource> {
  return new OwnedProbeRegistry({
    dispose,
    unavailableError: () => new Error('Registry unavailable'),
  });
}

describe('OwnedProbeRegistry', () => {
  it('tracks concurrent probes and disposes every resource exactly once', async () => {
    const firstQuery = new Deferred<string>();
    const secondQuery = new Deferred<string>();
    const dispose = jest.fn();
    const registry = createRegistry(dispose);

    const first = registry.run({
      create: () => ({ id: 1 }),
      query: () => firstQuery.promise,
    });
    const second = registry.run({
      create: () => ({ id: 2 }),
      query: () => secondQuery.promise,
    });
    firstQuery.resolve('first');
    secondQuery.resolve('second');

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose.mock.calls.map(([resource]) => resource.id)).toEqual([1, 2]);
    await registry.quiesce();
  });

  it('propagates caller cancellation and removes its abort listener', async () => {
    const dispose = jest.fn();
    const registry = createRegistry(dispose);
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    let ownedSignal!: AbortSignal;
    const queryStarted = new Deferred<void>();
    const failure = new Error('caller cancelled');

    const run = registry.run({
      create: () => ({ id: 1 }),
      query: (_resource, signal) => {
        ownedSignal = signal;
        queryStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }, controller.signal);
    await queryStarted.promise;
    controller.abort(failure);

    await expect(run).rejects.toBe(failure);
    expect(ownedSignal.aborted).toBe(true);
    expect(ownedSignal.reason).toBe(failure);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans up initialization and query failures and remains usable after creation failure', async () => {
    const dispose = jest.fn();
    const registry = createRegistry(dispose);

    await expect(registry.run({
      create: () => { throw new Error('create failed'); },
      query: async () => 'unused',
    })).rejects.toThrow('create failed');
    expect(dispose).not.toHaveBeenCalled();

    await expect(registry.run({
      create: () => ({ id: 1 }),
      initialize: async () => { throw new Error('initialize failed'); },
      query: async () => 'unused',
    })).rejects.toThrow('initialize failed');
    await expect(registry.run({
      create: () => ({ id: 2 }),
      query: async () => { throw new Error('query failed'); },
    })).rejects.toThrow('query failed');

    expect(dispose).toHaveBeenCalledTimes(2);
    await registry.quiesce();
  });

  it('suppresses cleanup failure while preserving exactly-once disposal', async () => {
    const dispose = jest.fn(async () => { throw new Error('cleanup failed'); });
    const registry = createRegistry(dispose);

    await expect(registry.run({
      create: () => ({ id: 1 }),
      query: async () => 'result',
    })).resolves.toBe('result');
    await registry.quiesce();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts active operations and waits for cleanup and completion during quiescence', async () => {
    const cleanup = new Deferred<void>();
    const registry = createRegistry(() => cleanup.promise);
    const queryStarted = new Deferred<void>();

    const run = registry.run({
      create: () => ({ id: 1 }),
      query: (_resource, signal) => {
        queryStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    await queryStarted.promise;

    let quiesced = false;
    const quiescence = registry.quiesce().then(() => { quiesced = true; });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    cleanup.resolve();
    await expect(run).rejects.toThrow('aborted');
    await quiescence;
    expect(quiesced).toBe(true);
  });

  it('safely disposes during an active probe and rejects future runs', async () => {
    const cleanup = new Deferred<void>();
    const disposeResource = jest.fn(() => cleanup.promise);
    const registry = createRegistry(disposeResource);
    const queryStarted = new Deferred<void>();
    const run = registry.run({
      create: () => ({ id: 1 }),
      query: (_resource, signal) => {
        queryStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('disposed')), { once: true });
        });
      },
    });
    await queryStarted.promise;

    const firstDispose = registry.dispose();
    const secondDispose = registry.dispose();
    cleanup.resolve();

    await expect(run).rejects.toThrow('disposed');
    await expect(Promise.all([firstDispose, secondDispose])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(disposeResource).toHaveBeenCalledTimes(1);
    await expect(registry.run({
      create: () => ({ id: 2 }),
      query: async () => 'unused',
    })).rejects.toThrow('Registry unavailable');
  });
});
