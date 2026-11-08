/** @vitest-environment jsdom */

import { holdResponse } from '@test/helpers/ConversationPorts';
import type { Mock } from 'vitest';

import { ChatState } from '@/features/chat/state/ChatState';
import { ThinkingIndicator } from '@/features/chat/turns/ThinkingIndicator';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';

describe('ThinkingIndicator', () => {
  let turns: TurnCoordinator;
  let state: ChatState;
  let updateQueueIndicator: Mock;
  let scrollToBottom: Mock;
  let indicator: ThinkingIndicator;
  let contentEl: HTMLElement;
  const shown = (): HTMLElement | null => contentEl.querySelector<HTMLElement>('.claudian-thinking');

  beforeEach(() => {
    vi.useFakeTimers();
    turns = new TurnCoordinator();
    state = new ChatState({}, undefined, turns);
    const messagesEl = document.body.createDiv();
    contentEl = messagesEl.createDiv();
    state.currentContentEl = contentEl;
    updateQueueIndicator = vi.fn();
    scrollToBottom = vi.fn();
    indicator = new ThinkingIndicator({
      state,
      getMessagesEl: () => messagesEl,
      updateQueueIndicator,
      scrollToBottom,
    });
  });

  afterEach(() => {
    indicator.dispose();
    state.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('appears after its debounce delay and scrolls it into view', () => {
    indicator.show();
    vi.advanceTimersByTime(399);
    expect(shown()).toBeNull();
    expect(scrollToBottom).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(shown()).not.toBeNull();
    expect(state.waitingStatus).not.toBeNull();
    expect(scrollToBottom).toHaveBeenCalled();
  });

  it('returns after a text pause only while the response streams', async () => {
    indicator.afterTextPause();
    vi.advanceTimersByTime(2_000);
    expect(shown()).toBeNull();

    const finish = holdResponse(turns);
    indicator.afterTextPause();
    vi.advanceTimersByTime(400);
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(1_100);
    expect(shown()).not.toBeNull();
    await finish();
  });

  it('resumes only while the response streams', async () => {
    indicator.resume(state.streamGeneration);
    vi.advanceTimersByTime(500);
    expect(shown()).toBeNull();

    const finish = holdResponse(turns);
    indicator.resume(state.streamGeneration);
    vi.advanceTimersByTime(500);
    expect(shown()).not.toBeNull();
    await finish();
  });

  it('does not resume an old prompt into a replacement response', async () => {
    const finish = holdResponse(turns);
    const generation = state.streamGeneration;
    indicator.hide();
    await finish();
    const finishNext = holdResponse(turns);
    indicator.resume(generation);
    vi.advanceTimersByTime(500);
    expect(shown()).toBeNull();
    await finishNext();
  });

  describe('a prompt from an earlier response settling while the current indicator is withheld', () => {
    async function withholdCurrentIndicator() {
      const finishEarlier = holdResponse(turns);
      const earlier = state.streamGeneration;
      await finishEarlier();
      const finishCurrent = holdResponse(turns);
      state.setActionRequired(true);
      indicator.show();
      vi.advanceTimersByTime(500);
      expect(shown()).toBeNull();
      state.setActionRequired(false);
      return { earlier, finishCurrent };
    }

    it('shows the current response indicator', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      indicator.resume(earlier);
      vi.advanceTimersByTime(500);
      expect(shown()).not.toBeNull();
      await finishCurrent();
    });

    it('stays hidden once the current response produced output', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      indicator.hide();
      indicator.resume(earlier);
      vi.advanceTimersByTime(500);
      expect(shown()).toBeNull();
      await finishCurrent();
    });

    it('stays hidden after the current response finished', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      await finishCurrent();
      indicator.resume(earlier);
      vi.advanceTimersByTime(500);
      expect(shown()).toBeNull();
    });
  });

  it('should clear timer interval when hiding thinking indicator', () => {
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);
    expect(shown()).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    indicator.hide();

    expect(vi.getTimerCount()).toBe(0);
    expect(shown()).toBeNull();
    expect(state.waitingStatus).toBeNull();
  });

  it('uses the content owner window for thinking timers', () => {
    const ownerSetTimeout = vi.fn<(...args: Parameters<Window['setTimeout']>) => ReturnType<Window['setTimeout']>>(
      (callback, timeout) => globalThis.setTimeout(callback, timeout) as unknown as number,
    );
    const ownerClearTimeout = vi.fn<(...args: [number | undefined]) => void>((handle) => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });
    const ownerSetInterval = vi.fn<(...args: Parameters<Window['setInterval']>) => ReturnType<Window['setInterval']>>(
      (callback, timeout) => globalThis.setInterval(callback, timeout) as unknown as number,
    );
    const ownerClearInterval = vi.fn<(...args: [number | undefined]) => void>((handle) => {
      globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
    });
    const frame = document.body.appendChild(document.createElement('iframe'));
    frame.contentDocument!.body.appendChild(state.currentContentEl!);
    const ownerWindow = frame.contentWindow!;
    vi.spyOn(ownerWindow, 'setTimeout').mockImplementation(ownerSetTimeout);
    vi.spyOn(ownerWindow, 'clearTimeout').mockImplementation(ownerClearTimeout);
    vi.spyOn(ownerWindow, 'setInterval').mockImplementation(ownerSetInterval);
    vi.spyOn(ownerWindow, 'clearInterval').mockImplementation(ownerClearInterval);

    state.responseStartTime = performance.now();

    indicator.show();
    expect(ownerSetTimeout).toHaveBeenCalledWith(expect.any(Function), 400);

    indicator.hide();
    expect(ownerClearTimeout).toHaveBeenCalled();

    indicator.show();
    vi.advanceTimersByTime(500);
    expect(ownerSetInterval).toHaveBeenCalledWith(expect.any(Function), 1000);

    indicator.hide();
    expect(ownerClearInterval).toHaveBeenCalled();
  });

  it('should not show indicator when no currentContentEl', () => {
    state.currentContentEl = null;

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(shown()).toBeNull();
  });

  it('should not show indicator when a thinking block is active', () => {
    state.currentThinkingBlock = { content: 'thinking...', startTime: Date.now() };

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(shown()).toBeNull();
  });

  it('keeps an explicit status across hide and resume until it ends', () => {
    indicator.show('Compacting...', 'claudian-thinking--compact');
    vi.advanceTimersByTime(500);
    expect(state.waitingStatus).toBe('Compacting...');

    indicator.hide();
    indicator.show();
    vi.advanceTimersByTime(500);
    expect(state.waitingStatus).toBe('Compacting...');

    indicator.endExplicit();
    expect(shown()).toBeNull();
    indicator.show();
    vi.advanceTimersByTime(500);
    expect(state.waitingStatus).not.toBeNull();
    expect(state.waitingStatus).not.toBe('Compacting...');
  });

  it('ignores indicator work left over from a superseded stream', async () => {
    // A newer response takes over the stream presentation.
    const supersede = () => holdResponse(turns)();
    indicator.show();
    await supersede();
    vi.advanceTimersByTime(500);
    expect(shown()).toBeNull();
    expect(state.waitingStatus).toBeNull();

    indicator.show();
    vi.advanceTimersByTime(500);
    const staleEl = shown();
    expect(staleEl).not.toBeNull();
    await supersede();

    indicator.show();
    vi.advanceTimersByTime(500);
    expect(shown()).not.toBeNull();
    expect(shown()).not.toBe(staleEl);
    expect(staleEl!.isConnected).toBe(false);
    // Only the replacement indicator's elapsed-time tick remains.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps the pending delay when asked to show again before it elapses', () => {
    indicator.show();
    vi.advanceTimersByTime(300);
    indicator.show();
    vi.advanceTimersByTime(300);
    indicator.show();
    vi.advanceTimersByTime(100);

    expect(shown()).not.toBeNull();
  });

  it('should re-append existing indicator to bottom when called again', () => {
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);

    const thinkingEl = shown();
    expect(thinkingEl).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    indicator.show();

    expect(shown()).toBe(thinkingEl);
    expect(updateQueueIndicator).toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(contentEl.querySelectorAll('.claudian-thinking')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('should clear interval when timerSpan becomes disconnected from DOM', () => {
    // Use a non-zero value: with fake timers, performance.now() starts at 0,
    // and !0 is truthy which would cause updateTimer to return early.
    vi.advanceTimersByTime(1);
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(vi.getTimerCount()).toBe(1);
    const thinkingEl = shown();
    expect(thinkingEl).not.toBeNull();

    // The timer span is the second child (first is flavor text, second is hint)
    const timerSpan = thinkingEl!.children[1];
    expect(timerSpan).toBeDefined();

    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(1);
    expect(timerSpan.textContent).toContain('esc to interrupt');

    timerSpan.remove();
    vi.advanceTimersByTime(1000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('should not update timer text when responseStartTime is null', () => {
    vi.advanceTimersByTime(1);
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(shown()).not.toBeNull();

    const timerSpan = shown()!.children[1];
    timerSpan.setText('Existing timer text');

    state.responseStartTime = null;
    vi.advanceTimersByTime(1000);

    expect(timerSpan.textContent).toBe('Existing timer text');
    // The interval is not cleared by the null check.
    expect(vi.getTimerCount()).toBe(1);
  });
});
