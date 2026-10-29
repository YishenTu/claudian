import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
} from '@/features/chat/utils/animationFrame';

describe('animationFrame scheduling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules and cancels RAF on the owner window', () => {
    const callback = vi.fn();
    const ownerRequestAnimationFrame = vi.fn<(...args: Parameters<Window['requestAnimationFrame']>) => ReturnType<Window['requestAnimationFrame']>>()
      .mockReturnValue(123);
    const ownerCancelAnimationFrame = vi.fn<(...args: [number]) => void>();
    const globalRequestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    const globalCancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame');
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
    const callback = vi.fn();
    const ownerSetTimeout = vi.fn<(...args: Parameters<Window['setTimeout']>) => ReturnType<Window['setTimeout']>>()
      .mockReturnValue(456);
    const ownerClearTimeout = vi.fn<(...args: [number]) => void>();
    const globalSetTimeout = vi.spyOn(window, 'setTimeout');
    const globalClearTimeout = vi.spyOn(window, 'clearTimeout');
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
