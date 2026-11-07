/** @vitest-environment jsdom */

import { holdResponse } from '@test/helpers/ConversationPorts';
import type { Mock } from 'vitest';

import { ChatState } from '@/features/chat/state/ChatState';
import { ThinkingIndicator } from '@/features/chat/turns/ThinkingIndicator';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { setLocale } from '@/i18n/i18n';

describe('ThinkingIndicator', () => {
  let turns: TurnCoordinator;
  let state: ChatState;
  let updateQueueIndicator: Mock;
  let scrollToBottom: Mock;
  let indicator: ThinkingIndicator;
  let messagesEl: HTMLElement;

  function createIndicator(): ThinkingIndicator {
    return new ThinkingIndicator({ state, getMessagesEl: () => messagesEl, updateQueueIndicator, scrollToBottom });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    turns = new TurnCoordinator();
    state = new ChatState({}, undefined, turns);
    messagesEl = document.body.createDiv();
    state.currentContentEl = messagesEl.createDiv();
    updateQueueIndicator = vi.fn();
    scrollToBottom = vi.fn();
    indicator = createIndicator();
  });

  afterEach(() => {
    state.clearThinkingIndicatorTimeout();
    state.clearFlavorTimerInterval();
    indicator.dispose();
    state.dispose();
    setLocale('en');
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function waiting() {
    return [state.thinkingEl?.firstElementChild?.textContent, state.waitingStatus];
  }

  it('preserves every English flavor and its selection bucket', () => {
    const english = [
      'Thinking...',
      'Pondering...',
      'Processing...',
      'Analyzing...',
      'Considering...',
      'Working on it...',
      'Vibing...',
      'One moment...',
      'On it...',
      'Ruminating...',
      'Contemplating...',
      'Reflecting...',
      'Mulling it over...',
      'Let me think...',
      'Hmm...',
      'Cogitating...',
      'Deliberating...',
      'Weighing options...',
      'Gathering thoughts...',
      'Brewing ideas...',
      'Connecting dots...',
      'Assembling thoughts...',
      'Spinning up neurons...',
      'Loading brilliance...',
      'Consulting the oracle...',
      'Summoning knowledge...',
      'Crunching thoughts...',
      'Dusting off neurons...',
      'Wrangling ideas...',
      'Herding thoughts...',
      'Juggling concepts...',
      'Untangling this...',
      'Piecing it together...',
      'Sipping coffee...',
      'Warming up...',
      'Getting cozy with this...',
      'Settling in...',
      'Making tea...',
      'Grabbing a snack...',
      'Parsing...',
      'Compiling thoughts...',
      'Running inference...',
      'Querying the void...',
      'Defragmenting brain...',
      'Allocating memory...',
      'Optimizing...',
      'Indexing...',
      'Syncing neurons...',
      'Breathing...',
      'Finding clarity...',
      'Channeling focus...',
      'Centering...',
      'Aligning chakras...',
      'Meditating on this...',
      'Asking the stars...',
      'Reading tea leaves...',
      'Shaking the magic 8-ball...',
      'Consulting ancient scrolls...',
      'Decoding the matrix...',
      'Communing with the ether...',
      'Peering into the abyss...',
      'Channeling the cosmos...',
      'Diving in...',
      'Rolling up sleeves...',
      'Getting to work...',
      'Tackling this...',
      'On the case...',
      'Investigating...',
      'Exploring...',
      'Digging deeper...',
      'Bear with me...',
      'Hang tight...',
      'Just a sec...',
      'Working my magic...',
      'Almost there...',
      'Give me a moment...',
    ];
    const random = vi.spyOn(Math, 'random');
    vi.advanceTimersByTime(1);
    state.responseStartTime = performance.now();

    for (const [index, expected] of english.entries()) {
      random.mockClear().mockReturnValue((index + 0.25) / 76);
      indicator.show();
      vi.advanceTimersByTime(399);
      expect(state.thinkingEl).toBeNull();
      expect(random).not.toHaveBeenCalled();
      expect(scrollToBottom).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(waiting()).toEqual([expected, expected]);
      expect(scrollToBottom).toHaveBeenCalledTimes(1);

      indicator.show();
      vi.advanceTimersByTime(1_000);
      expect(random).toHaveBeenCalledTimes(1);
      indicator.hide();
      scrollToBottom.mockClear();
    }
  });

  it.each([
    [0, 'Thinking...'],
    [0.01, 'Thinking...'],
    [0.014, 'Pondering...'],
    [0.9999999999999999, 'Give me a moment...'],
  ])('selects the original flavor at random value %s', (value, expected) => {
    vi.spyOn(Math, 'random').mockReturnValue(value);
    indicator.show();
    vi.advanceTimersByTime(400);
    expect(waiting()).toEqual([expected, expected]);
  });

  it.each([
    [0, '思考中…'],
    [8, '马上处理…'],
    [9, '反复推敲中…'],
    [18, '整理思路中…'],
    [19, '酝酿点子中…'],
    [32, '拼合思路中…'],
    [33, '喝口咖啡…'],
    [38, '拿点零食…'],
    [39, '解析中…'],
    [47, '同步神经元中…'],
    [48, '深呼吸…'],
    [53, '静心思考中…'],
    [54, '向星辰提问…'],
    [61, '连接宇宙灵感…'],
    [62, '深入探索中…'],
    [69, '深挖线索中…'],
    [70, '请稍等…'],
    [75, '给我一点时间…'],
  ])('localizes the flavor at group boundary index %s', (index, expected) => {
    setLocale('zh-CN');
    vi.spyOn(Math, 'random').mockReturnValue((index + 0.25) / 76);
    indicator.show();
    vi.advanceTimersByTime(400);
    expect(waiting()).toEqual([expected, expected]);
  });

  it('reads the active locale on each fresh show after import', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const observed = [];
    for (const locale of ['en', 'zh-CN', 'en'] as const) {
      setLocale(locale);
      indicator = createIndicator();
      indicator.show();
      vi.advanceTimersByTime(400);
      observed.push(waiting());
      indicator.dispose();
    }
    expect(observed).toEqual([
      ['Thinking...', 'Thinking...'],
      ['思考中…', '思考中…'],
      ['Thinking...', 'Thinking...'],
    ]);
  });

  it.each([
    ['en', 'Thinking...', ' (esc to interrupt · 0s)', ' (esc to interrupt · 59s)', ' (esc to interrupt · 1m 0s)'],
    ['zh-CN', '思考中…', '（按 esc 中断 · 0s）', '（按 esc 中断 · 59s）', '（按 esc 中断 · 1m 0s）'],
  ] as const)('formats the full interrupt hint in %s without changing elapsed time', (locale, flavor, initial, beforeMinute, afterMinute) => {
    setLocale(locale);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.advanceTimersByTime(1);
    state.responseStartTime = performance.now();
    indicator.show();
    vi.advanceTimersByTime(400);

    const hint = state.thinkingEl?.querySelector('.claudian-thinking-hint');
    const observed = [hint?.textContent];
    vi.advanceTimersByTime(59_000);
    observed.push(hint?.textContent);
    vi.advanceTimersByTime(1_000);
    observed.push(hint?.textContent);
    expect(observed).toEqual([initial, beforeMinute, afterMinute]);
    expect(waiting()).toEqual([flavor, flavor]);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('retains literal explicit text across hide and resume, then localizes ordinary waiting', async () => {
    setLocale('zh-CN');
    const finish = holdResponse(turns);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      indicator.show('Thinking...');
      vi.advanceTimersByTime(400);
      expect(waiting()).toEqual(['Thinking...', 'Thinking...']);
      indicator.hide();
      indicator.resume(state.streamGeneration);
      vi.advanceTimersByTime(400);
      expect(waiting()).toEqual(['Thinking...', 'Thinking...']);
      expect(random).not.toHaveBeenCalled();

      indicator.endExplicit();
      indicator.show();
      vi.advanceTimersByTime(400);
      expect(waiting()).toEqual(['思考中…', '思考中…']);
      expect(random).toHaveBeenCalledTimes(1);
    } finally {
      await finish();
    }
  });

  it('treats an empty override as ordinary waiting', () => {
    setLocale('zh-CN');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    indicator.show('');
    vi.advanceTimersByTime(400);
    expect(waiting()).toEqual(['思考中…', '思考中…']);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('returns after a text pause only while the response streams', async () => {
    indicator.afterTextPause();
    vi.advanceTimersByTime(2_000);
    expect(state.thinkingEl).toBeNull();

    const finish = holdResponse(turns);
    indicator.afterTextPause();
    vi.advanceTimersByTime(400);
    expect(state.thinkingEl).toBeNull();
    vi.advanceTimersByTime(1_100);
    expect(state.thinkingEl).not.toBeNull();
    await finish();
  });

  it('resumes only while the response streams', async () => {
    indicator.resume(state.streamGeneration);
    vi.advanceTimersByTime(500);
    expect(state.thinkingEl).toBeNull();

    const finish = holdResponse(turns);
    indicator.resume(state.streamGeneration);
    vi.advanceTimersByTime(500);
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
    vi.advanceTimersByTime(500);
    expect(state.thinkingEl).toBeNull();
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
      expect(state.thinkingEl).toBeNull();
      state.setActionRequired(false);
      return { earlier, finishCurrent };
    }

    it('shows the current response indicator', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      indicator.resume(earlier);
      vi.advanceTimersByTime(500);
      expect(state.thinkingEl).not.toBeNull();
      await finishCurrent();
    });

    it('stays hidden once the current response produced output', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      indicator.hide();
      indicator.resume(earlier);
      vi.advanceTimersByTime(500);
      expect(state.thinkingEl).toBeNull();
      await finishCurrent();
    });

    it('stays hidden after the current response finished', async () => {
      const { earlier, finishCurrent } = await withholdCurrentIndicator();
      await finishCurrent();
      indicator.resume(earlier);
      vi.advanceTimersByTime(500);
      expect(state.thinkingEl).toBeNull();
    });
  });

  it('should clear timer interval when hiding thinking indicator', () => {
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);
    expect(state.flavorTimerInterval).not.toBeNull();

    indicator.hide();

    expect(state.flavorTimerInterval).toBeNull();
    expect(state.thinkingEl).toBeNull();
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

    expect(state.thinkingEl).toBeNull();
  });

  it('should not show indicator when a thinking block is active', () => {
    state.currentThinkingBlock = { content: 'thinking...', startTime: Date.now() };

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(state.thinkingEl).toBeNull();
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
    expect(state.thinkingEl).toBeNull();
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
    expect(state.thinkingEl).toBeNull();
    expect(state.waitingStatus).toBeNull();

    indicator.show();
    vi.advanceTimersByTime(500);
    const staleEl = state.thinkingEl;
    expect(staleEl).not.toBeNull();
    await supersede();

    indicator.show();
    vi.advanceTimersByTime(500);
    expect(state.thinkingEl).not.toBeNull();
    expect(state.thinkingEl).not.toBe(staleEl);
  });

  it('keeps the pending delay when asked to show again before it elapses', () => {
    indicator.show();
    vi.advanceTimersByTime(300);
    indicator.show();
    vi.advanceTimersByTime(300);
    indicator.show();
    vi.advanceTimersByTime(100);

    expect(state.thinkingEl).not.toBeNull();
  });

  it('should re-append existing indicator to bottom when called again', () => {
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);

    const thinkingEl = state.thinkingEl;
    const firstInterval = state.flavorTimerInterval;
    expect(thinkingEl).not.toBeNull();
    expect(firstInterval).not.toBeNull();

    indicator.show();

    expect(state.thinkingEl).toBe(thinkingEl);
    expect(updateQueueIndicator).toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(state.flavorTimerInterval).toBe(firstInterval);
  });

  it('should clear interval when timerSpan becomes disconnected from DOM', () => {
    // Use a non-zero value: with fake timers, performance.now() starts at 0,
    // and !0 is truthy which would cause updateTimer to return early.
    vi.advanceTimersByTime(1);
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(state.flavorTimerInterval).not.toBeNull();
    const thinkingEl = state.thinkingEl;
    expect(thinkingEl).not.toBeNull();

    // The timer span is the second child (first is flavor text, second is hint)
    const timerSpan = thinkingEl!.children[1];
    expect(timerSpan).toBeDefined();

    vi.advanceTimersByTime(1000);
    expect(state.flavorTimerInterval).not.toBeNull();
    expect(timerSpan.textContent).toContain('esc to interrupt');

    timerSpan.remove();
    vi.advanceTimersByTime(1000);

    expect(state.flavorTimerInterval).toBeNull();
  });

  it('should clear pre-existing interval before creating new one', () => {
    vi.advanceTimersByTime(1);
    state.responseStartTime = performance.now();
    const activeWindow = state.currentContentEl!.ownerDocument.defaultView!;
    const clearIntervalSpy = vi.spyOn(activeWindow, 'clearInterval');

    state.setFlavorTimerInterval(activeWindow.setInterval(() => {}, 9999), activeWindow);

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(state.flavorTimerInterval).not.toBeNull();

    clearIntervalSpy.mockRestore();
  });

  it('should not update timer text when responseStartTime is null', () => {
    vi.advanceTimersByTime(1);
    state.responseStartTime = performance.now();

    indicator.show();
    vi.advanceTimersByTime(500);

    expect(state.thinkingEl).not.toBeNull();

    const timerSpan = state.thinkingEl!.children[1];
    timerSpan.setText('Existing timer text');

    state.responseStartTime = null;
    vi.advanceTimersByTime(1000);

    expect(timerSpan.textContent).toBe('Existing timer text');
    // The interval is not cleared by the null check.
    expect(state.flavorTimerInterval).not.toBeNull();
  });
});
