import { ChatState } from '@/features/chat/state/ChatState';

describe('ChatState', () => {
  const originalWindow = (globalThis as { window?: Window }).window;

  beforeAll(() => {
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

    Object.defineProperty(globalThis, 'window', {
      value: testWindow,
      configurable: true,
    });
  });

  afterAll(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
      return;
    }

    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
    });
  });

  describe('messages', () => {
    it('returns a copy of messages', () => {
      const chatState = new ChatState();
      const msg = { id: '1', role: 'user' as const, content: 'hi', timestamp: 1 };
      chatState.addMessage(msg);

      const msgs = chatState.messages;
      msgs.push({ id: '2', role: 'user' as const, content: 'bye', timestamp: 2 });

      expect(chatState.messages).toHaveLength(1);
    });

    it('clears messages', () => {
      const chatState = new ChatState();
      const message = { id: '1', role: 'user' as const, content: 'hi', timestamp: 1 };
      chatState.addMessage(message);
      expect(chatState.messages).toEqual([message]);

      chatState.clearMessages();

      expect(chatState.messages).toHaveLength(0);
    });
  });

  describe('streaming control', () => {
    it('fires onStreamingStateChanged when isStreaming changes', () => {
      const onStreamingStateChanged = jest.fn();
      const chatState = new ChatState({ onStreamingStateChanged });

      chatState.isStreaming = true;

      expect(onStreamingStateChanged).toHaveBeenCalledWith(true);
    });

    it('bumpStreamGeneration increments and returns the new value', () => {
      const chatState = new ChatState();

      expect(chatState.streamGeneration).toBe(0);
      const gen1 = chatState.bumpStreamGeneration();
      expect(gen1).toBe(1);
      expect(chatState.streamGeneration).toBe(1);

      const gen2 = chatState.bumpStreamGeneration();
      expect(gen2).toBe(2);
    });

  });

  describe('conversation', () => {
    it('fires onConversationChanged for a value and when cleared', () => {
      const onConversationChanged = jest.fn();
      const chatState = new ChatState({ onConversationChanged });
      chatState.currentConversationId = 'conv-1';
      expect(onConversationChanged).toHaveBeenCalledWith('conv-1');

      chatState.currentConversationId = null;

      expect(onConversationChanged).toHaveBeenCalledWith(null);
    });
  });

  describe('queued message', () => {
    it('stores and retrieves queued message', () => {
      const chatState = new ChatState();
      const queued = { content: 'queued', editorContext: null, canvasContext: null };

      chatState.queuedMessage = queued;

      expect(chatState.queuedMessage).toBe(queued);
    });
  });

  describe('streaming DOM state', () => {
    it('stores currentContentEl', () => {
      const chatState = new ChatState();
      const el = {} as HTMLElement;
      chatState.currentContentEl = el;
      expect(chatState.currentContentEl).toBe(el);
    });

    it('stores currentTextEl', () => {
      const chatState = new ChatState();
      const el = {} as HTMLElement;
      chatState.currentTextEl = el;
      expect(chatState.currentTextEl).toBe(el);
    });

    it('stores currentTextContent', () => {
      const chatState = new ChatState();
      chatState.currentTextContent = 'hello';
      expect(chatState.currentTextContent).toBe('hello');
    });

    it('stores currentThinkingState', () => {
      const chatState = new ChatState();
      const state = { content: 'thinking' } as any;
      chatState.currentThinkingState = state;
      expect(chatState.currentThinkingState).toBe(state);
    });

    it('stores thinkingEl', () => {
      const chatState = new ChatState();
      const el = {} as HTMLElement;
      chatState.thinkingEl = el;
      expect(chatState.thinkingEl).toBe(el);
    });

    it('stores queueIndicatorEl', () => {
      const chatState = new ChatState();
      const el = {} as HTMLElement;
      chatState.queueIndicatorEl = el;
      expect(chatState.queueIndicatorEl).toBe(el);
    });
  });

  describe('tool tracking maps', () => {
    it('returns mutable toolCallElements map', () => {
      const chatState = new ChatState();
      const el = {} as HTMLElement;
      chatState.toolCallElements.set('tool-1', el);
      expect(chatState.toolCallElements.get('tool-1')).toBe(el);
    });

    it('returns mutable writeEditStates map', () => {
      const chatState = new ChatState();
      const state = {} as any;
      chatState.writeEditStates.set('we-1', state);
      expect(chatState.writeEditStates.get('we-1')).toBe(state);
    });

    it('returns mutable pendingTools map', () => {
      const chatState = new ChatState();
      const pt = { toolCall: {} as any, parentEl: null };
      chatState.pendingTools.set('pt-1', pt);
      expect(chatState.pendingTools.get('pt-1')).toBe(pt);
    });
  });

  describe('usage', () => {
    it('fires onUsageChanged for a value and when cleared', () => {
      const onUsageChanged = jest.fn();
      const chatState = new ChatState({ onUsageChanged });
      const usage = { inputTokens: 100, outputTokens: 50 } as any;
      chatState.usage = usage;
      expect(onUsageChanged).toHaveBeenCalledWith(usage);

      chatState.usage = null;

      expect(onUsageChanged).toHaveBeenCalledWith(null);
    });
  });

  describe('attention', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('marks and acknowledges review attention', () => {
      jest.spyOn(Date, 'now').mockReturnValue(123);
      const onAttentionChanged = jest.fn();
      const chatState = new ChatState({ onAttentionChanged });

      expect(chatState.attention).toBeNull();
      expect(chatState.requiresAction).toBe(false);

      chatState.markReviewRequired();

      expect(chatState.attention).toEqual({ kind: 'review', outcome: 'completed', since: 123 });
      expect(chatState.requiresAction).toBe(false);
      expect(onAttentionChanged).toHaveBeenCalledWith({
        kind: 'review',
        outcome: 'completed',
        since: 123,
      });

      chatState.acknowledgeReview();

      expect(chatState.attention).toBeNull();
      expect(onAttentionChanged).toHaveBeenLastCalledWith(null);
    });

    it('tracks multiple action-required interactions until the last one ends', () => {
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const onAttentionChanged = jest.fn();
      const chatState = new ChatState({ onAttentionChanged });

      chatState.beginActionRequired('approval-1');
      chatState.beginActionRequired('question-1');

      expect(chatState.attention).toEqual({ kind: 'action-required', since: 100 });
      expect(chatState.requiresAction).toBe(true);
      expect(onAttentionChanged).toHaveBeenCalledTimes(1);

      chatState.endActionRequired('approval-1');
      expect(chatState.requiresAction).toBe(true);
      expect(onAttentionChanged).toHaveBeenCalledTimes(1);

      chatState.endActionRequired('question-1');
      expect(chatState.attention).toBeNull();
      expect(onAttentionChanged).toHaveBeenLastCalledWith(null);
    });

    it('keeps action-required attention when review is acknowledged', () => {
      const chatState = new ChatState();

      chatState.beginActionRequired('approval-1');
      chatState.acknowledgeReview();

      expect(chatState.requiresAction).toBe(true);
    });

    it('reveals review attention after the last action-required interaction settles', () => {
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const chatState = new ChatState();

      chatState.beginActionRequired('approval-1');
      chatState.markReviewRequired();
      chatState.endActionRequired('approval-1');

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'completed',
        since: 200,
      });
    });

    it('restores existing review after action-required attention settles', () => {
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const chatState = new ChatState();

      chatState.markReviewRequired();
      chatState.beginActionRequired('approval-1');
      chatState.endActionRequired('approval-1');

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'completed',
        since: 100,
      });
    });

    it('acknowledges review hidden beneath action-required attention', () => {
      const chatState = new ChatState();

      chatState.beginActionRequired('approval-1');
      chatState.markReviewRequired();
      chatState.acknowledgeReview();
      chatState.endActionRequired('approval-1');

      expect(chatState.attention).toBeNull();
    });

    it('treats duplicate begin and end calls as idempotent', () => {
      const onAttentionChanged = jest.fn();
      const chatState = new ChatState({ onAttentionChanged });

      chatState.beginActionRequired('approval-1');
      chatState.beginActionRequired('approval-1');
      chatState.endActionRequired('missing');
      chatState.endActionRequired('approval-1');
      chatState.endActionRequired('approval-1');

      expect(chatState.attention).toBeNull();
      expect(onAttentionChanged).toHaveBeenCalledTimes(2);
    });

    it('does not reset review time or emit redundant callbacks', () => {
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const onAttentionChanged = jest.fn();
      const chatState = new ChatState({ onAttentionChanged });

      chatState.markReviewRequired();
      chatState.markReviewRequired();

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'completed',
        since: 100,
      });
      expect(onAttentionChanged).toHaveBeenCalledTimes(1);
    });

    it('upgrades unread completion attention when a later result fails', () => {
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const chatState = new ChatState();

      chatState.markReviewRequired('completed');
      chatState.markReviewRequired('error');

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'error',
        since: 100,
      });
    });

    it('restores the strongest unread outcome after action-required settles', () => {
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200)
        .mockReturnValueOnce(300);
      const chatState = new ChatState();

      chatState.markReviewRequired('completed');
      chatState.beginActionRequired('approval-1');
      chatState.markReviewRequired('error');
      chatState.endActionRequired('approval-1');

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'error',
        since: 100,
      });
    });
  });

  describe('autoScrollEnabled', () => {
    it('notifies only when auto-scroll changes', () => {
      const onAutoScrollChanged = jest.fn();
      const chatState = new ChatState({ onAutoScrollChanged });
      chatState.autoScrollEnabled = true;
      expect(onAutoScrollChanged).not.toHaveBeenCalled();

      chatState.autoScrollEnabled = false;

      expect(onAutoScrollChanged).toHaveBeenCalledWith(false);
    });
  });

  describe('response timer', () => {
    it('stores responseStartTime', () => {
      const chatState = new ChatState();
      chatState.responseStartTime = 12345;
      expect(chatState.responseStartTime).toBe(12345);
    });
  });

  describe('clearFlavorTimerInterval', () => {
    it('clears active interval', () => {
      const chatState = new ChatState();
      const clearSpy = jest.spyOn(window, 'clearInterval');
      const interval = window.setInterval(() => {}, 1000);
      chatState.setFlavorTimerInterval(interval, window);

      chatState.clearFlavorTimerInterval();

      expect(clearSpy).toHaveBeenCalledWith(interval);
      expect(chatState.flavorTimerInterval).toBeNull();
      clearSpy.mockRestore();
    });

    it('is a no-op when no interval is active', () => {
      const chatState = new ChatState();
      const clearSpy = jest.spyOn(window, 'clearInterval');

      chatState.clearFlavorTimerInterval();

      expect(clearSpy).not.toHaveBeenCalled();
      clearSpy.mockRestore();
    });
  });

  describe('truncateAt', () => {
    it('removes target message and all after', () => {
      const chatState = new ChatState();
      chatState.addMessage({ id: 'a', role: 'user', content: 'first', timestamp: 1 });
      chatState.addMessage({ id: 'b', role: 'assistant', content: 'reply1', timestamp: 2 });
      chatState.addMessage({ id: 'c', role: 'user', content: 'second', timestamp: 3 });
      chatState.addMessage({ id: 'd', role: 'assistant', content: 'reply2', timestamp: 4 });

      const removed = chatState.truncateAt('c');

      expect(removed).toBe(2);
      expect(chatState.messages.map(m => m.id)).toEqual(['a', 'b']);
    });

    it('returns 0 without changing messages for unknown id', () => {
      const chatState = new ChatState();
      chatState.addMessage({ id: 'a', role: 'user', content: 'first', timestamp: 1 });

      const removed = chatState.truncateAt('nonexistent');

      expect(removed).toBe(0);
      expect(chatState.messages.map(m => m.id)).toEqual(['a']);
    });

    it('clears all messages when truncating at first message', () => {
      const chatState = new ChatState();
      chatState.addMessage({ id: 'a', role: 'user', content: 'first', timestamp: 1 });
      chatState.addMessage({ id: 'b', role: 'assistant', content: 'reply', timestamp: 2 });

      const removed = chatState.truncateAt('a');

      expect(removed).toBe(2);
      expect(chatState.messages).toEqual([]);
    });

    it('removes only last message when truncating at last', () => {
      const chatState = new ChatState();
      chatState.addMessage({ id: 'a', role: 'user', content: 'first', timestamp: 1 });
      chatState.addMessage({ id: 'b', role: 'assistant', content: 'reply', timestamp: 2 });

      const removed = chatState.truncateAt('b');

      expect(removed).toBe(1);
      expect(chatState.messages.map(m => m.id)).toEqual(['a']);
    });
  });
});
