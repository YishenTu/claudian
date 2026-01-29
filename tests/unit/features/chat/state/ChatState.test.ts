import { ChatState, createInitialState } from '@/features/chat/state/ChatState';
import type { ChatStateCallbacks } from '@/features/chat/state/types';

describe('ChatState', () => {
  describe('createInitialState', () => {
    it('returns correct default values', () => {
      const state = createInitialState();

      expect(state.messages).toEqual([]);
      expect(state.isStreaming).toBe(false);
      expect(state.cancelRequested).toBe(false);
      expect(state.streamGeneration).toBe(0);
      expect(state.isCreatingConversation).toBe(false);
      expect(state.isSwitchingConversation).toBe(false);
      expect(state.currentConversationId).toBeNull();
      expect(state.queuedMessage).toBeNull();
      expect(state.currentContentEl).toBeNull();
      expect(state.currentTextEl).toBeNull();
      expect(state.currentTextContent).toBe('');
      expect(state.currentThinkingState).toBeNull();
      expect(state.thinkingEl).toBeNull();
      expect(state.queueIndicatorEl).toBeNull();
      expect(state.thinkingIndicatorTimeout).toBeNull();
      expect(state.toolCallElements).toBeInstanceOf(Map);
      expect(state.writeEditStates).toBeInstanceOf(Map);
      expect(state.pendingTools).toBeInstanceOf(Map);
      expect(state.usage).toBeNull();
      expect(state.ignoreUsageUpdates).toBe(false);
      expect(state.currentTodos).toBeNull();
      expect(state.needsAttention).toBe(false);
      expect(state.autoScrollEnabled).toBe(true);
      expect(state.responseStartTime).toBeNull();
      expect(state.flavorTimerInterval).toBeNull();
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

    it('fires onMessagesChanged when setting messages', () => {
      const onMessagesChanged = jest.fn();
      const chatState = new ChatState({ onMessagesChanged });

      chatState.messages = [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }];

      expect(onMessagesChanged).toHaveBeenCalledTimes(1);
    });

    it('fires onMessagesChanged when adding a message', () => {
      const onMessagesChanged = jest.fn();
      const chatState = new ChatState({ onMessagesChanged });

      chatState.addMessage({ id: '1', role: 'user', content: 'hi', timestamp: 1 });

      expect(onMessagesChanged).toHaveBeenCalledTimes(1);
    });

    it('fires onMessagesChanged when clearing messages', () => {
      const onMessagesChanged = jest.fn();
      const chatState = new ChatState({ onMessagesChanged });
      chatState.addMessage({ id: '1', role: 'user', content: 'hi', timestamp: 1 });

      chatState.clearMessages();

      expect(chatState.messages).toHaveLength(0);
      expect(onMessagesChanged).toHaveBeenCalledTimes(2); // once for add, once for clear
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

    it('stores cancelRequested', () => {
      const chatState = new ChatState();
      chatState.cancelRequested = true;
      expect(chatState.cancelRequested).toBe(true);
    });

    it('stores isCreatingConversation', () => {
      const chatState = new ChatState();
      chatState.isCreatingConversation = true;
      expect(chatState.isCreatingConversation).toBe(true);
    });

    it('stores isSwitchingConversation', () => {
      const chatState = new ChatState();
      chatState.isSwitchingConversation = true;
      expect(chatState.isSwitchingConversation).toBe(true);
    });
  });

  describe('conversation', () => {
    it('fires onConversationChanged when currentConversationId changes', () => {
      const onConversationChanged = jest.fn();
      const chatState = new ChatState({ onConversationChanged });

      chatState.currentConversationId = 'conv-1';

      expect(onConversationChanged).toHaveBeenCalledWith('conv-1');
    });

    it('fires onConversationChanged with null', () => {
      const onConversationChanged = jest.fn();
      const chatState = new ChatState({ onConversationChanged });
      chatState.currentConversationId = 'conv-1';

      chatState.currentConversationId = null;

      expect(onConversationChanged).toHaveBeenCalledWith(null);
    });
  });

  describe('queued message', () => {
    it('stores and retrieves queued message', () => {
      const chatState = new ChatState();
      const queued = { content: 'queued', editorContext: null };

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

    it('stores thinkingIndicatorTimeout', () => {
      const chatState = new ChatState();
      const timeout = setTimeout(() => {}, 100);
      chatState.thinkingIndicatorTimeout = timeout;
      expect(chatState.thinkingIndicatorTimeout).toBe(timeout);
      clearTimeout(timeout);
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
    it('fires onUsageChanged when usage changes', () => {
      const onUsageChanged = jest.fn();
      const chatState = new ChatState({ onUsageChanged });
      const usage = { inputTokens: 100, outputTokens: 50 } as any;

      chatState.usage = usage;

      expect(onUsageChanged).toHaveBeenCalledWith(usage);
    });

    it('fires onUsageChanged with null', () => {
      const onUsageChanged = jest.fn();
      const chatState = new ChatState({ onUsageChanged });
      chatState.usage = { inputTokens: 100, outputTokens: 50 } as any;

      chatState.usage = null;

      expect(onUsageChanged).toHaveBeenCalledWith(null);
    });

    it('stores ignoreUsageUpdates', () => {
      const chatState = new ChatState();
      chatState.ignoreUsageUpdates = true;
      expect(chatState.ignoreUsageUpdates).toBe(true);
    });
  });

  describe('currentTodos', () => {
    it('fires onTodosChanged when todos change', () => {
      const onTodosChanged = jest.fn();
      const chatState = new ChatState({ onTodosChanged });
      const todos = [{ content: 'Test', status: 'pending' as const, activeForm: 'Testing' }];

      chatState.currentTodos = todos;

      expect(onTodosChanged).toHaveBeenCalledWith(todos);
    });

    it('normalizes empty array to null', () => {
      const onTodosChanged = jest.fn();
      const chatState = new ChatState({ onTodosChanged });

      chatState.currentTodos = [];

      expect(onTodosChanged).toHaveBeenCalledWith(null);
    });

    it('returns a copy of todos', () => {
      const chatState = new ChatState();
      const todos = [{ content: 'Test', status: 'pending' as const, activeForm: 'Testing' }];
      chatState.currentTodos = todos;

      const retrieved = chatState.currentTodos!;
      retrieved.push({ content: 'Other', status: 'pending' as const, activeForm: 'Othering' });

      expect(chatState.currentTodos).toHaveLength(1);
    });

    it('returns null when not set', () => {
      const chatState = new ChatState();
      expect(chatState.currentTodos).toBeNull();
    });
  });

  describe('needsAttention', () => {
    it('fires onAttentionChanged when value changes', () => {
      const onAttentionChanged = jest.fn();
      const chatState = new ChatState({ onAttentionChanged });

      chatState.needsAttention = true;

      expect(onAttentionChanged).toHaveBeenCalledWith(true);
    });
  });

  describe('autoScrollEnabled', () => {
    it('fires onAutoScrollChanged when value changes', () => {
      const onAutoScrollChanged = jest.fn();
      const chatState = new ChatState({ onAutoScrollChanged });
      // Default is true, so set to false to trigger change
      chatState.autoScrollEnabled = false;

      expect(onAutoScrollChanged).toHaveBeenCalledWith(false);
    });

    it('does not fire onAutoScrollChanged when value is the same', () => {
      const onAutoScrollChanged = jest.fn();
      const chatState = new ChatState({ onAutoScrollChanged });
      // Default is true, set to true again
      chatState.autoScrollEnabled = true;

      expect(onAutoScrollChanged).not.toHaveBeenCalled();
    });
  });

  describe('response timer', () => {
    it('stores responseStartTime', () => {
      const chatState = new ChatState();
      chatState.responseStartTime = 12345;
      expect(chatState.responseStartTime).toBe(12345);
    });

    it('stores flavorTimerInterval', () => {
      const chatState = new ChatState();
      const interval = setInterval(() => {}, 1000);
      chatState.flavorTimerInterval = interval;
      expect(chatState.flavorTimerInterval).toBe(interval);
      clearInterval(interval);
    });
  });

  describe('clearFlavorTimerInterval', () => {
    it('clears active interval', () => {
      const chatState = new ChatState();
      const clearSpy = jest.spyOn(global, 'clearInterval');
      const interval = setInterval(() => {}, 1000);
      chatState.flavorTimerInterval = interval;

      chatState.clearFlavorTimerInterval();

      expect(clearSpy).toHaveBeenCalledWith(interval);
      expect(chatState.flavorTimerInterval).toBeNull();
      clearSpy.mockRestore();
    });

    it('is a no-op when no interval is active', () => {
      const chatState = new ChatState();
      const clearSpy = jest.spyOn(global, 'clearInterval');

      chatState.clearFlavorTimerInterval();

      expect(clearSpy).not.toHaveBeenCalled();
      clearSpy.mockRestore();
    });
  });

  describe('resetStreamingState', () => {
    it('resets all streaming-related state', () => {
      const chatState = new ChatState();
      chatState.currentContentEl = {} as HTMLElement;
      chatState.currentTextEl = {} as HTMLElement;
      chatState.currentTextContent = 'text';
      chatState.currentThinkingState = {} as any;
      chatState.isStreaming = true;
      chatState.cancelRequested = true;
      const timeout = setTimeout(() => {}, 1000);
      chatState.thinkingIndicatorTimeout = timeout;
      const interval = setInterval(() => {}, 1000);
      chatState.flavorTimerInterval = interval;
      chatState.responseStartTime = 12345;

      chatState.resetStreamingState();

      expect(chatState.currentContentEl).toBeNull();
      expect(chatState.currentTextEl).toBeNull();
      expect(chatState.currentTextContent).toBe('');
      expect(chatState.currentThinkingState).toBeNull();
      expect(chatState.isStreaming).toBe(false);
      expect(chatState.cancelRequested).toBe(false);
      expect(chatState.thinkingIndicatorTimeout).toBeNull();
      expect(chatState.flavorTimerInterval).toBeNull();
      expect(chatState.responseStartTime).toBeNull();
    });
  });

  describe('clearMaps', () => {
    it('clears all tracking maps', () => {
      const chatState = new ChatState();
      chatState.toolCallElements.set('a', {} as HTMLElement);
      chatState.writeEditStates.set('b', {} as any);
      chatState.pendingTools.set('c', { toolCall: {} as any, parentEl: null });

      chatState.clearMaps();

      expect(chatState.toolCallElements.size).toBe(0);
      expect(chatState.writeEditStates.size).toBe(0);
      expect(chatState.pendingTools.size).toBe(0);
    });
  });

  describe('resetForNewConversation', () => {
    it('resets all conversation state', () => {
      const onMessagesChanged = jest.fn();
      const onUsageChanged = jest.fn();
      const onTodosChanged = jest.fn();
      const onAutoScrollChanged = jest.fn();
      const chatState = new ChatState({
        onMessagesChanged,
        onUsageChanged,
        onTodosChanged,
        onAutoScrollChanged,
      });

      // Set up some state
      chatState.addMessage({ id: '1', role: 'user', content: 'hi', timestamp: 1 });
      chatState.isStreaming = true;
      chatState.cancelRequested = true;
      chatState.currentContentEl = {} as HTMLElement;
      chatState.toolCallElements.set('a', {} as HTMLElement);
      chatState.queuedMessage = { content: 'queued', editorContext: null };
      chatState.usage = { inputTokens: 100, outputTokens: 50 } as any;
      chatState.currentTodos = [{ content: 'Test', status: 'pending' as const, activeForm: 'Testing' }];
      // autoScrollEnabled defaults to true, set to false first so reset triggers change
      chatState.autoScrollEnabled = false;

      // Reset all tracking
      jest.clearAllMocks();

      chatState.resetForNewConversation();

      expect(chatState.messages).toHaveLength(0);
      expect(chatState.isStreaming).toBe(false);
      expect(chatState.cancelRequested).toBe(false);
      expect(chatState.currentContentEl).toBeNull();
      expect(chatState.toolCallElements.size).toBe(0);
      expect(chatState.writeEditStates.size).toBe(0);
      expect(chatState.pendingTools.size).toBe(0);
      expect(chatState.queuedMessage).toBeNull();
      expect(chatState.usage).toBeNull();
      expect(chatState.currentTodos).toBeNull();
      expect(chatState.autoScrollEnabled).toBe(true);

      // Verify callbacks were fired
      expect(onMessagesChanged).toHaveBeenCalled();
      expect(onUsageChanged).toHaveBeenCalledWith(null);
      expect(onTodosChanged).toHaveBeenCalledWith(null);
      expect(onAutoScrollChanged).toHaveBeenCalledWith(true);
    });
  });

  describe('getPersistedMessages', () => {
    it('returns messages as-is', () => {
      const chatState = new ChatState();
      const msg = { id: '1', role: 'user' as const, content: 'test', timestamp: 1 };
      chatState.addMessage(msg);

      const persisted = chatState.getPersistedMessages();

      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toEqual(msg);
    });
  });

  describe('callbacks property', () => {
    it('allows getting callbacks', () => {
      const callbacks: ChatStateCallbacks = { onMessagesChanged: jest.fn() };
      const chatState = new ChatState(callbacks);

      expect(chatState.callbacks).toBe(callbacks);
    });

    it('allows setting callbacks', () => {
      const chatState = new ChatState();
      const newCallbacks: ChatStateCallbacks = { onMessagesChanged: jest.fn() };

      chatState.callbacks = newCallbacks;
      chatState.addMessage({ id: '1', role: 'user', content: 'hi', timestamp: 1 });

      expect(newCallbacks.onMessagesChanged).toHaveBeenCalled();
    });
  });
});
