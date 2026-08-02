import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';

describe('ProviderTransitionFence', () => {
  it('keeps nested transitions unavailable until the final end', async () => {
    const fence = new ProviderTransitionFence();

    fence.endTransition();
    fence.beginTransition();
    fence.beginTransition();
    expect(fence.isUnavailable()).toBe(true);

    let settled = false;
    const availability = fence.waitUntilAvailable().then((value) => {
      settled = true;
      return value;
    });
    fence.endTransition();
    await Promise.resolve();
    expect(settled).toBe(false);

    fence.endTransition();
    await expect(availability).resolves.toBe(true);
    expect(fence.isUnavailable()).toBe(false);
    fence.endTransition();
  });

  it('rechecks availability when another transition begins before a waiter resumes', async () => {
    const fence = new ProviderTransitionFence();
    fence.beginTransition();

    let settled = false;
    const availability = fence.waitUntilAvailable().then((value) => {
      settled = true;
      return value;
    });
    fence.endTransition();
    fence.beginTransition();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    fence.endTransition();
    await expect(availability).resolves.toBe(true);
  });

  it('rejects an already-aborted waiter with the configured fallback', async () => {
    const fence = new ProviderTransitionFence({
      abortMessage: 'Metadata wait aborted',
    });
    const controller = new AbortController();
    controller.abort('caller cancelled');

    await expect(fence.waitUntilAvailable(controller.signal)).rejects.toMatchObject({
      cause: 'caller cancelled',
      message: 'Metadata wait aborted',
    });
  });

  it('removes the abort listener when a transition or abort settles the waiter', async () => {
    const fence = new ProviderTransitionFence({
      abortMessage: 'Metadata wait aborted',
    });
    const releasedController = new AbortController();
    const abortedController = new AbortController();
    const releasedRemove = jest.spyOn(releasedController.signal, 'removeEventListener');
    const abortedRemove = jest.spyOn(abortedController.signal, 'removeEventListener');
    fence.beginTransition();

    const released = fence.waitUntilAvailable(releasedController.signal);
    const aborted = fence.waitUntilAvailable(abortedController.signal);
    abortedController.abort(new Error('stop'));
    fence.endTransition();

    await expect(released).resolves.toBe(true);
    await expect(aborted).rejects.toThrow('stop');
    expect(releasedRemove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(abortedRemove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('releases waiters as unavailable when disposed during a nested transition', async () => {
    const fence = new ProviderTransitionFence();
    fence.beginTransition();
    fence.beginTransition();

    const first = fence.waitUntilAvailable();
    const second = fence.waitUntilAvailable();
    fence.dispose();
    fence.dispose();
    fence.endTransition();

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    await expect(fence.waitUntilAvailable()).resolves.toBe(false);
    expect(fence.isUnavailable()).toBe(true);
  });
});
