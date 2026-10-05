import { holdResponse } from '@test/helpers/ConversationPorts';
import { createMockEl } from '@test/helpers/MockElement';

import { ChatState } from '@/features/chat/state/ChatState';
import { ThinkingIndicator } from '@/features/chat/turns/ThinkingIndicator';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';

const originalWindow = (globalThis as { window?: Window }).window;

function installTestWindow(): void {
  const testWindow = {
    setTimeout: (callback: () => void, timeout: number): number =>
      globalThis.setTimeout(callback, timeout) as unknown as number,
    clearTimeout: (handle: number): void => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    setInterval: (callback: () => void, timeout: number): number =>
      globalThis.setInterval(callback, timeout) as unknown as number,
    clearInterval: (handle: number): void => {
      globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
    },
  } as Window;
  Object.defineProperty(globalThis, 'window', { value: testWindow, configurable: true });
}

function restoreTestWindow(): void {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
    return;
  }
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
}

describe('ThinkingIndicator', () => {
  let turns: TurnCoordinator;
  let state: ChatState;
  let updateQueueIndicator: jest.Mock;
  let scrollToBottom: jest.Mock;
  let indicator: ThinkingIndicator;

  beforeEach(() => {
    jest.useFakeTimers();
    installTestWindow();
    turns = new TurnCoordinator();
    state = new ChatState({}, undefined, turns);
    state.currentContentEl = createMockEl();
    const messagesEl = createMockEl();
    updateQueueIndicator = jest.fn();
    scrollToBottom = jest.fn();
    indicator = new ThinkingIndicator({
      state,
      getMessagesEl: () => messagesEl,
      updateQueueIndicator,
      scrollToBottom,
    });
  });

  afterEach(() => {
    state.clearThinkingIndicatorTimeout();
    state.clearFlavorTimerInterval();
    restoreTestWindow();
    jest.useRealTimers();
  });

  it('appears after its debounce delay and scrolls it into view', () => {
    indicator.show();
    jest.advanceTimersByTime(399);
    expect(state.thinkingEl).toBeNull();
    expect(scrollToBottom).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(state.thinkingEl).not.toBeNull();
    expect(state.waitingStatus).not.toBeNull();
    expect(scrollToBottom).toHaveBeenCalled();
  });

  it('returns after a text pause only while the response streams', async () => {
    indicator.afterTextPause();
    jest.advanceTimersByTime(2_000);
    expect(state.thinkingEl).toBeNull();

    const finish = holdResponse(turns);
    indicator.afterTextPause();
    jest.advanceTimersByTime(400);
    expect(state.thinkingEl).toBeNull();
    jest.advanceTimersByTime(1_100);
    expect(state.thinkingEl).not.toBeNull();
    await finish();
  });

  it('resumes only while the response streams', async () => {
    indicator.resume(state.streamGeneration);
    jest.advanceTimersByTime(500);
    expect(state.thinkingEl).toBeNull();

    const finish = holdResponse(turns);
    indicator.resume(state.streamGeneration);
    jest.advanceTimersByTime(500);
    expect(state.thinkingEl).not.toBeNull();
    await finish();
  });

  it('does not resume an old prompt into a replacement response', async () => {
    const finish = holdResponse(turns);
    const generation = state.streamGeneration;
    indicator.hide();
    await finish();
    const finishNext = holdResponse(turns);
    indicator.resume(generation);
    jest.advanceTimersByTime(500);
    expect(state.thinkingEl).toBeNull();
    await finishNext();
  });

  describe('a prompt from an earlier response settling while the current indicator is withheld', () => {
    async function withholdCurrentIndicator() {
      const finishEarlier = holdResponse(turns);
      const earlier = state.streamGeneration;
      await finishEarlier();
      const finishCurrent = holdResponse(turns);
      state.beginActionRequired('prompt');
      indicator.show();
      jest.advanceTimersByTime(500);
      expect(state.thinkingEl).toBeNull();
      state.endActionRequired('prompt');
      return { earlier, finishCurrent };
    }

    it('shows the current response indicator', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      indicator.resume(earlier);
      jest.advanceTimersByTime(500);
      expect(state.thinkingEl).not.toBeNull();
      await finishCurrent();
    });

    it('stays hidden once the current response produced output', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      indicator.hide();
      indicator.resume(earlier);
      jest.advanceTimersByTime(500);
      expect(state.thinkingEl).toBeNull();
      await finishCurrent();
    });

    it('stays hidden after the current response finished', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      await finishCurrent();
      indicator.resume(earlier);
      jest.advanceTimersByTime(500);
      expect(state.thinkingEl).toBeNull();
    });
  });

  it('should clear timer interval when hiding thinking indicator', () => {
    state.responseStartTime = performance.now();

    indicator.show();
    jest.advanceTimersByTime(500);
    expect(state.flavorTimerInterval).not.toBeNull();

    indicator.hide();

    expect(state.flavorTimerInterval).toBeNull();
    expect(state.thinkingEl).toBeNull();
    expect(state.waitingStatus).toBeNull();
  });

  it('uses the content owner window for thinking timers', () => {
    const ownerSetTimeout = jest.fn<ReturnType<Window['setTimeout']>, Parameters<Window['setTimeout']>>(
      (callback, timeout) => globalThis.setTimeout(callback, timeout) as unknown as number,
    );
    const ownerClearTimeout = jest.fn<void, [number]>((handle) => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });
    const ownerSetInterval = jest.fn<ReturnType<Window['setInterval']>, Parameters<Window['setInterval']>>(
      (callback, timeout) => globalThis.setInterval(callback, timeout) as unknown as number,
    );
    const ownerClearInterval = jest.fn<void, [number]>((handle) => {
      globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
    });
    const ownerWindow = {
      ...state.currentContentEl!.ownerDocument.defaultView,
      setTimeout: ownerSetTimeout,
      clearTimeout: ownerClearTimeout,
      setInterval: ownerSetInterval,
      clearInterval: ownerClearInterval,
    };
    Object.defineProperty(state.currentContentEl!.ownerDocument, 'defaultView', {
      configurable: true,
      value: ownerWindow,
    });

    state.responseStartTime = performance.now();

    indicator.show();
    expect(ownerSetTimeout).toHaveBeenCalledWith(expect.any(Function), 400);

    indicator.hide();
    expect(ownerClearTimeout).toHaveBeenCalled();

    indicator.show();
    jest.advanceTimersByTime(500);
    expect(ownerSetInterval).toHaveBeenCalledWith(expect.any(Function), 1000);

    indicator.hide();
    expect(ownerClearInterval).toHaveBeenCalled();
  });

  it('should not show indicator when no currentContentEl', () => {
    state.currentContentEl = null;

    indicator.show();
    jest.advanceTimersByTime(500);

    expect(state.thinkingEl).toBeNull();
  });

  it('should not show indicator when currentThinkingState is active', () => {
    state.currentThinkingState = { content: 'thinking...', container: {}, contentEl: {}, startTime: Date.now() } as any;

    indicator.show();
    jest.advanceTimersByTime(500);

    expect(state.thinkingEl).toBeNull();
  });

  it('keeps an explicit status across hide and resume until it ends', () => {
    indicator.show('Compacting...', 'claudian-thinking--compact');
    jest.advanceTimersByTime(500);
    expect(state.waitingStatus).toBe('Compacting...');

    indicator.hide();
    indicator.show();
    jest.advanceTimersByTime(500);
    expect(state.waitingStatus).toBe('Compacting...');

    indicator.endExplicit();
    expect(state.thinkingEl).toBeNull();
    indicator.show();
    jest.advanceTimersByTime(500);
    expect(state.waitingStatus).not.toBeNull();
    expect(state.waitingStatus).not.toBe('Compacting...');
  });

  it('ignores indicator work left over from a superseded stream', async () => {
    // A newer response takes over the stream presentation.
    const supersede = () => holdResponse(turns)();
    indicator.show();
    await supersede();
    jest.advanceTimersByTime(500);
    expect(state.thinkingEl).toBeNull();
    expect(state.waitingStatus).toBeNull();

    indicator.show();
    jest.advanceTimersByTime(500);
    const staleEl = state.thinkingEl;
    expect(staleEl).not.toBeNull();
    await supersede();

    indicator.show();
    jest.advanceTimersByTime(500);
    expect(state.thinkingEl).not.toBeNull();
    expect(state.thinkingEl).not.toBe(staleEl);
  });

  it('keeps the pending delay when asked to show again before it elapses', () => {
    indicator.show();
    jest.advanceTimersByTime(300);
    indicator.show();
    jest.advanceTimersByTime(300);
    indicator.show();
    jest.advanceTimersByTime(100);

    expect(state.thinkingEl).not.toBeNull();
  });

  it('should re-append existing indicator to bottom when called again', () => {
    state.responseStartTime = performance.now();

    indicator.show();
    jest.advanceTimersByTime(500);

    const thinkingEl = state.thinkingEl;
    const firstInterval = state.flavorTimerInterval;
    expect(thinkingEl).not.toBeNull();
    expect(firstInterval).not.toBeNull();

    indicator.show();

    expect(state.thinkingEl).toBe(thinkingEl);
    expect(updateQueueIndicator).toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(state.flavorTimerInterval).toBe(firstInterval);
  });

  it('should clear interval when timerSpan becomes disconnected from DOM', () => {
    // Use a non-zero value: with fake timers, performance.now() starts at 0,
    // and !0 is truthy which would cause updateTimer to return early.
    jest.advanceTimersByTime(1);
    state.responseStartTime = performance.now();

    indicator.show();
    jest.advanceTimersByTime(500);

    expect(state.flavorTimerInterval).not.toBeNull();
    const thinkingEl = state.thinkingEl;
    expect(thinkingEl).not.toBeNull();

    // The timer span is the second child (first is flavor text, second is hint)
    const timerSpan = thinkingEl!.children[1];
    expect(timerSpan).toBeDefined();

    // Mock elements don't have isConnected by default (undefined = falsy),
    // so first set it to true so the timer runs normally on its first tick.
    Object.defineProperty(timerSpan, 'isConnected', { value: true, writable: true, configurable: true });

    jest.advanceTimersByTime(1000);
    expect(state.flavorTimerInterval).not.toBeNull();
    expect((timerSpan as any).textContent).toContain('esc to interrupt');

    (timerSpan as any).isConnected = false;
    jest.advanceTimersByTime(1000);

    expect(state.flavorTimerInterval).toBeNull();
  });

  it('should clear pre-existing interval before creating new one', () => {
    jest.advanceTimersByTime(1);
    state.responseStartTime = performance.now();
    const activeWindow = state.currentContentEl!.ownerDocument.defaultView!;
    const clearIntervalSpy = jest.spyOn(activeWindow, 'clearInterval');

    state.setFlavorTimerInterval(activeWindow.setInterval(() => {}, 9999), activeWindow);

    indicator.show();
    jest.advanceTimersByTime(500);

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(state.flavorTimerInterval).not.toBeNull();

    clearIntervalSpy.mockRestore();
  });

  it('should not update timer text when responseStartTime is null', () => {
    jest.advanceTimersByTime(1);
    state.responseStartTime = performance.now();

    indicator.show();
    jest.advanceTimersByTime(500);

    expect(state.thinkingEl).not.toBeNull();

    const timerSpan = state.thinkingEl!.children[1];
    Object.defineProperty(timerSpan, 'isConnected', { value: true, configurable: true });
    timerSpan.setText('Existing timer text');

    state.responseStartTime = null;
    jest.advanceTimersByTime(1000);

    expect(timerSpan.textContent).toBe('Existing timer text');
    // The interval is not cleared by the null check.
    expect(state.flavorTimerInterval).not.toBeNull();
  });
});
