import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
} from '@/utils/animationFrame';

describe('animationFrame scheduling', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('schedules and cancels RAF on the owner window', () => {
    const callback = jest.fn();
    const ownerRequestAnimationFrame = jest.fn<ReturnType<Window['requestAnimationFrame']>, Parameters<Window['requestAnimationFrame']>>()
      .mockReturnValue(123);
    const ownerCancelAnimationFrame = jest.fn<void, [number]>();
    const globalRequestAnimationFrame = jest.spyOn(window, 'requestAnimationFrame');
    const globalCancelAnimationFrame = jest.spyOn(window, 'cancelAnimationFrame');
    const ownerWindow = {
      requestAnimationFrame: ownerRequestAnimationFrame,
      cancelAnimationFrame: ownerCancelAnimationFrame,
    } as unknown as Window;

    const frame = scheduleAnimationFrame(callback, ownerWindow);

    expect(frame).toEqual({ kind: 'raf', id: 123, ownerWindow });
    expect(ownerRequestAnimationFrame).toHaveBeenCalledWith(expect.any(Function));
    expect(globalRequestAnimationFrame).not.toHaveBeenCalled();

    cancelScheduledAnimationFrame(frame);

    expect(ownerCancelAnimationFrame).toHaveBeenCalledWith(123);
    expect(globalCancelAnimationFrame).not.toHaveBeenCalled();
  });

  it('schedules and clears timeout fallback on the owner window', () => {
    const callback = jest.fn();
    const ownerSetTimeout = jest.fn<ReturnType<Window['setTimeout']>, Parameters<Window['setTimeout']>>()
      .mockReturnValue(456);
    const ownerClearTimeout = jest.fn<void, [number]>();
    const globalSetTimeout = jest.spyOn(window, 'setTimeout');
    const globalClearTimeout = jest.spyOn(window, 'clearTimeout');
    const ownerWindow = {
      requestAnimationFrame: undefined,
      setTimeout: ownerSetTimeout,
      clearTimeout: ownerClearTimeout,
    } as unknown as Window;

    const frame = scheduleAnimationFrame(callback, ownerWindow);

    expect(frame).toEqual({ kind: 'timeout', id: 456, ownerWindow });
    expect(ownerSetTimeout).toHaveBeenCalledWith(callback, 16);
    expect(globalSetTimeout).not.toHaveBeenCalled();

    cancelScheduledAnimationFrame(frame);

    expect(ownerClearTimeout).toHaveBeenCalledWith(456);
    expect(globalClearTimeout).not.toHaveBeenCalled();
  });
});
