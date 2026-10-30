/** @vitest-environment jsdom */
import { holdResponse } from '@test/helpers/ConversationPorts';

import type { ToolCallInfo, UsageInfo } from '@/core/types';
import type { ThinkingBlockState } from '@/features/chat/rendering/ThinkingBlockRenderer';
import type { WriteEditState } from '@/features/chat/rendering/tools/WriteEditRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';

describe('ChatState', () => {
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
    it('derives streaming from its turn owner and reports each change once', async () => {
      const onStreamingStateChanged = vi.fn();
      const turns = new TurnCoordinator();
      const chatState = new ChatState({ onStreamingStateChanged }, undefined, turns);

      const release = holdResponse(turns);
      expect(chatState.isStreaming).toBe(true);
      await release();

      expect(chatState.isStreaming).toBe(false);
      expect(onStreamingStateChanged.mock.calls).toEqual([[true], [false]]);
    });
  });

  describe('conversation', () => {
    it('fires onConversationChanged for a value and when cleared', () => {
      const onConversationChanged = vi.fn();
      const chatState = new ChatState({ onConversationChanged });
      chatState.currentConversationId = 'conv-1';
      expect(onConversationChanged).toHaveBeenCalledWith('conv-1');

      chatState.currentConversationId = null;

      expect(onConversationChanged).toHaveBeenCalledWith(null);
    });
  });

  describe('queued message', () => {
    it('stores the queued message written by its single claimed owner', () => {
      const chatState = new ChatState();
      const queued = { content: 'queued', turnRequest: { text: 'queued' } };

      const write = chatState.claimQueuedMessageWriter();
      write(queued);

      expect(chatState.queuedMessage).toBe(queued);
      expect(() => chatState.claimQueuedMessageWriter()).toThrow('The queued message already has an owner.');
    });
  });

  describe('streaming DOM state', () => {
    it('stores currentContentEl', () => {
      const chatState = new ChatState();
      const el = document.createElement('div');
      chatState.currentContentEl = el;
      expect(chatState.currentContentEl).toBe(el);
    });

    it('stores currentTextEl', () => {
      const chatState = new ChatState();
      const el = document.createElement('div');
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
      const state: ThinkingBlockState = {
        wrapperEl: document.createElement('div'), contentEl: document.createElement('div'),
        labelEl: document.createElement('span'), timerInterval: null, isExpanded: false,
      };
      chatState.currentThinkingState = state;
      expect(chatState.currentThinkingState).toBe(state);
    });

    it('stores thinkingEl', () => {
      const chatState = new ChatState();
      const el = document.createElement('div');
      chatState.thinkingEl = el;
      expect(chatState.thinkingEl).toBe(el);
    });

    it('stores queueIndicatorEl', () => {
      const chatState = new ChatState();
      const el = document.createElement('div');
      chatState.queueIndicatorEl = el;
      expect(chatState.queueIndicatorEl).toBe(el);
    });
  });

  describe('tool tracking maps', () => {
    it('returns mutable toolCallElements map', () => {
      const chatState = new ChatState();
      const el = document.createElement('div');
      chatState.toolCallElements.set('tool-1', el);
      expect(chatState.toolCallElements.get('tool-1')).toBe(el);
    });

    it('returns mutable writeEditStates map', () => {
      const chatState = new ChatState();
      const state: WriteEditState = {
        wrapperEl: document.createElement('div'), contentEl: document.createElement('div'),
        headerEl: document.createElement('div'), nameEl: document.createElement('span'),
        summaryEl: document.createElement('span'), statsEl: document.createElement('span'),
        statusEl: document.createElement('span'),
        toolCall: { id: 'write', name: 'Write', input: {}, status: 'running' },
        isExpanded: false, refreshHeader: () => undefined,
      };
      chatState.writeEditStates.set('we-1', state);
      expect(chatState.writeEditStates.get('we-1')).toBe(state);
    });

    it('returns mutable pendingTools map', () => {
      const chatState = new ChatState();
      const toolCall: ToolCallInfo = { id: 'tool', name: 'Read', input: {}, status: 'running' };
      const pt = { toolCall, parentEl: null };
      chatState.pendingTools.set('pt-1', pt);
      expect(chatState.pendingTools.get('pt-1')).toBe(pt);
    });
  });

  describe('usage', () => {
    it('fires onUsageChanged for a value and when cleared', () => {
      const onUsageChanged = vi.fn();
      const chatState = new ChatState({ onUsageChanged });
      const usage: UsageInfo = { inputTokens: 100, contextWindow: 1000, contextTokens: 100, percentage: 10 };
      chatState.usage = usage;
      expect(onUsageChanged).toHaveBeenCalledWith(usage);

      chatState.usage = null;

      expect(onUsageChanged).toHaveBeenCalledWith(null);
    });
  });

  describe('attention', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('marks and acknowledges review attention', () => {
      vi.spyOn(Date, 'now').mockReturnValue(123);
      const onAttentionChanged = vi.fn();
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

    it('advances the review epoch on every acknowledgement, even without pending review', () => {
      const chatState = new ChatState();
      const captured = chatState.reviewEpoch;

      chatState.acknowledgeReview();
      const afterFirst = chatState.reviewEpoch;
      chatState.acknowledgeReview();

      expect(afterFirst).not.toBe(captured);
      expect(chatState.reviewEpoch).not.toBe(afterFirst);
    });

    it('preserves action attention while the session still reports pending requests', () => {
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const onAttentionChanged = vi.fn();
      const chatState = new ChatState({ onAttentionChanged });

      chatState.setActionRequired(true);
      chatState.setActionRequired(true);

      expect(chatState.attention).toEqual({ kind: 'action-required', since: 100 });
      expect(chatState.requiresAction).toBe(true);
      expect(onAttentionChanged).toHaveBeenCalledTimes(1);

      chatState.setActionRequired(true);
      expect(chatState.requiresAction).toBe(true);
      expect(onAttentionChanged).toHaveBeenCalledTimes(1);

      chatState.setActionRequired(false);
      expect(chatState.attention).toBeNull();
      expect(onAttentionChanged).toHaveBeenLastCalledWith(null);
    });

    it('keeps action-required attention when review is acknowledged', () => {
      const chatState = new ChatState();

      chatState.setActionRequired(true);
      chatState.acknowledgeReview();

      expect(chatState.requiresAction).toBe(true);
    });

    it('reveals review attention after the last action-required interaction settles', () => {
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const chatState = new ChatState();

      chatState.setActionRequired(true);
      chatState.markReviewRequired();
      chatState.setActionRequired(false);

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'completed',
        since: 200,
      });
    });

    it('restores existing review after action-required attention settles', () => {
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const chatState = new ChatState();

      chatState.markReviewRequired();
      chatState.setActionRequired(true);
      chatState.setActionRequired(false);

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'completed',
        since: 100,
      });
    });

    it('acknowledges review hidden beneath action-required attention', () => {
      const chatState = new ChatState();

      chatState.setActionRequired(true);
      chatState.markReviewRequired();
      chatState.acknowledgeReview();
      chatState.setActionRequired(false);

      expect(chatState.attention).toBeNull();
    });

    it('treats unchanged interaction projections as idempotent', () => {
      const onAttentionChanged = vi.fn();
      const chatState = new ChatState({ onAttentionChanged });

      chatState.setActionRequired(true);
      chatState.setActionRequired(true);
      chatState.setActionRequired(false);
      chatState.setActionRequired(false);
      chatState.setActionRequired(false);

      expect(chatState.attention).toBeNull();
      expect(onAttentionChanged).toHaveBeenCalledTimes(2);
    });

    it('does not reset review time or emit redundant callbacks', () => {
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200);
      const onAttentionChanged = vi.fn();
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
      vi.spyOn(Date, 'now')
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
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200)
        .mockReturnValueOnce(300);
      const chatState = new ChatState();

      chatState.markReviewRequired('completed');
      chatState.setActionRequired(true);
      chatState.markReviewRequired('error');
      chatState.setActionRequired(false);

      expect(chatState.attention).toEqual({
        kind: 'review',
        outcome: 'error',
        since: 100,
      });
    });
  });

  describe('autoScrollEnabled', () => {
    it('notifies only when auto-scroll changes', () => {
      const onAutoScrollChanged = vi.fn();
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
      const clearSpy = vi.spyOn(window, 'clearInterval');
      const interval = window.setInterval(() => {}, 1000);
      chatState.setFlavorTimerInterval(interval, window);

      chatState.clearFlavorTimerInterval();

      expect(clearSpy).toHaveBeenCalledWith(interval);
      expect(chatState.flavorTimerInterval).toBeNull();
      clearSpy.mockRestore();
    });

    it('is a no-op when no interval is active', () => {
      const chatState = new ChatState();
      const clearSpy = vi.spyOn(window, 'clearInterval');

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
