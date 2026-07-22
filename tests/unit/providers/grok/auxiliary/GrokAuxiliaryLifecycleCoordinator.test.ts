import { GrokAuxiliaryLifecycleCoordinator } from '@/providers/grok/auxiliary/GrokAuxiliaryLifecycleCoordinator';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}

describe('GrokAuxiliaryLifecycleCoordinator', () => {
  it('blocks a runner registered during quiescence until the transition lease releases', async () => {
    const shutdown = deferred();
    const oldRunner = {
      quiesceForEnvironmentChange: jest.fn(() => shutdown.promise),
    };
    const newRunner = {
      quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    await lifecycle.acquire(oldRunner);

    const transitionPromise = lifecycle.beginEnvironmentChange();
    await Promise.resolve();
    const acquisition = lifecycle.acquire(newRunner);
    let acquired = false;
    void acquisition.then(() => { acquired = true; });

    expect(oldRunner.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    expect(acquired).toBe(false);
    shutdown.resolve();
    const transition = await transitionPromise;
    await Promise.resolve();
    expect(acquired).toBe(false);

    await transition.release();
    await acquisition;
    expect(acquired).toBe(true);

    const nextTransition = await lifecycle.beginEnvironmentChange();
    expect(newRunner.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    await nextTransition.release();
  });

  it('opens the gate after quiescence fails', async () => {
    const failedRunner = {
      quiesceForEnvironmentChange: jest.fn().mockRejectedValue(new Error('shutdown failed')),
    };
    const nextRunner = {
      quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    await lifecycle.acquire(failedRunner);

    await expect(lifecycle.beginEnvironmentChange()).rejects.toThrow('shutdown failed');
    await expect(lifecycle.acquire(nextRunner)).resolves.toBeUndefined();
  });

  it('serializes concurrent transitions without admitting runners between held leases', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const first = await lifecycle.beginEnvironmentChange();
    const secondPromise = lifecycle.beginEnvironmentChange();
    const runner = {
      quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    };
    const acquisition = lifecycle.acquire(runner);
    let acquired = false;
    void acquisition.then(() => { acquired = true; });

    await first.release();
    const second = await secondPromise;
    expect(runner.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    await second.release();
    await acquisition;
    expect(acquired).toBe(true);
  });
});
