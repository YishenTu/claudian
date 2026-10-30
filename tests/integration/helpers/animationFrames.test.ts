/** @vitest-environment jsdom */
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { createPopoutDocument } from '@test/helpers/dom/popoutDocument';

it('delivers frames asynchronously in registration order on the next task, respecting cancellation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const restore = useNextTaskAnimationFrames();
  try {
    const calls: Array<[string, number]> = [];
    const unrelatedTask = vi.fn();
    window.cancelAnimationFrame(window.setTimeout(unrelatedTask, 0));
    window.requestAnimationFrame(time => {
      calls.push(['first', time]);
      window.cancelAnimationFrame(cancelDuringFrame);
      window.requestAnimationFrame(nextTime => calls.push(['nested', nextTime]));
    });
    const cancelled = window.requestAnimationFrame(time => calls.push(['cancelled', time]));
    window.cancelAnimationFrame(cancelled);
    window.requestAnimationFrame(time => calls.push(['second', time]));
    const cancelDuringFrame = window.requestAnimationFrame(time => calls.push(['cancelled during frame', time]));
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([['first', performance.now()], ['second', performance.now()]]);
    expect(unrelatedTask).toHaveBeenCalledOnce();
    await vi.advanceTimersToNextTimerAsync();
    expect(calls).toEqual([['first', 0], ['second', 0], ['nested', performance.now()]]);
  } finally {
    restore();
    vi.useRealTimers();
  }
});

it('keeps popout schedules independent and restores methods while cancelling pending work', async () => {
  const popout = createPopoutDocument();
  const target = popout.defaultView!;
  const originalRequest = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  const popoutRequest = Object.getOwnPropertyDescriptor(target, 'requestAnimationFrame');
  const popoutCancel = Object.getOwnPropertyDescriptor(target, 'cancelAnimationFrame');
  const restoreMain = useNextTaskAnimationFrames();
  const restorePopout = useNextTaskAnimationFrames(target);
  try {
    const mainCallback = vi.fn();
    const popoutCallback = vi.fn();
    const cancelledMain = window.requestAnimationFrame(mainCallback);
    const popoutDelivered = new Promise<void>(resolve => target.requestAnimationFrame(time => {
      popoutCallback(time);
      resolve();
    }));
    window.cancelAnimationFrame(cancelledMain);
    await popoutDelivered;
    expect(mainCallback).not.toHaveBeenCalled();
    expect(popoutCallback).toHaveBeenCalledOnce();
    expect(popoutCallback.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
    expect(popoutCallback.mock.calls[0][0]).toBeLessThanOrEqual(target.performance.now());
    window.requestAnimationFrame(mainCallback);
    target.requestAnimationFrame(popoutCallback);
    restoreMain();
    restorePopout();
    await new Promise<void>(resolve => target.setTimeout(resolve, 0));
    expect(mainCallback).not.toHaveBeenCalled();
    expect(popoutCallback).toHaveBeenCalledOnce();
    expect(window.requestAnimationFrame).toBe(originalRequest);
    expect(window.cancelAnimationFrame).toBe(originalCancel);
    expect(Object.getOwnPropertyDescriptor(target, 'requestAnimationFrame')).toEqual(popoutRequest);
    expect(Object.getOwnPropertyDescriptor(target, 'cancelAnimationFrame')).toEqual(popoutCancel);
  } finally {
    restoreMain();
    restorePopout();
    target.frameElement?.remove();
  }
});

it('automatically restores the window and cancels pending callbacks when the test finishes', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const original = window.requestAnimationFrame;
  const pending = vi.fn();
  // Test-finished callbacks unwind in reverse registration order.
  onTestFinished(async () => {
    try {
      expect(window.requestAnimationFrame).toBe(original);
      await vi.runAllTimersAsync();
      expect(pending).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  useNextTaskAnimationFrames();
  window.requestAnimationFrame(pending);
});
