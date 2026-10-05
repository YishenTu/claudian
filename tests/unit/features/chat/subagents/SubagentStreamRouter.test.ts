import '@/providers';

import { createMockEl } from '@test/helpers/MockElement';

import { TOOL_SUBAGENT } from '@/core/tools/toolNames';
import { ChatState } from '@/features/chat/state/ChatState';
import {
  AsyncSubagentHistoryRecovery,
  type AsyncSubagentHistoryRecoveryDeps,
} from '@/features/chat/subagents/AsyncSubagentHistoryRecovery';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { SubagentStreamRouter } from '@/features/chat/subagents/SubagentStreamRouter';

function createHarness() {
  const state = new ChatState({});
  const messagesEl = createMockEl();
  const subagentManager = Object.assign(new SubagentManager(() => undefined), {
    handleAsyncSubagentCompletion: jest.fn().mockReturnValue(undefined),
    getByTaskId: jest.fn().mockReturnValue(undefined),
    refreshAsyncSubagent: jest.fn(),
  }) as any;
  const harness = {
    providerSessionId: 'session-1' as string | null,
    historyRecovery: undefined as unknown as AsyncSubagentHistoryRecoveryDeps,
    indicator: { show: jest.fn() },
    scrollToBottom: jest.fn(),
    state,
    subagentManager,
    router: undefined as unknown as SubagentStreamRouter,
  };
  harness.historyRecovery = {
    subagentManager,
    getMessagesEl: () => messagesEl,
    getProviderId: () => 'claude',
    getProviderSessionId: () => harness.providerSessionId,
    loadSubagentFinalResult: jest.fn().mockResolvedValue(null),
    loadSubagentToolCalls: jest.fn().mockResolvedValue([]),
    enqueueBackgroundWork: work => work(),
    persistConversation: jest.fn().mockResolvedValue(undefined),
  };
  harness.router = new SubagentStreamRouter({
    state,
    subagentManager,
    getMessagesEl: () => messagesEl,
    getProviderId: () => 'claude',
    asyncSubagentHistoryRecovery: new AsyncSubagentHistoryRecovery(harness.historyRecovery),
    tools: { flush: jest.fn(), flushBefore: jest.fn(), detach: jest.fn(), remove: jest.fn() },
    indicator: harness.indicator,
    scrollToBottom: harness.scrollToBottom,
  });
  return harness;
}

describe('SubagentStreamRouter', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    jest.useFakeTimers();
    harness = createHarness();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('onAsyncSubagentStateChange', () => {
    it('should update subagent in messages', () => {
      const subagent = { id: 'task-1', description: 'test', status: 'completed', result: 'done', toolCalls: [] } as any;
      harness.state.messages = [{
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'task-1',
          name: TOOL_SUBAGENT,
          input: { description: 'test' },
          status: 'running',
          subagent: { id: 'task-1', description: 'test', status: 'running', toolCalls: [] },
        }],
      }] as any;

      harness.router.onAsyncSubagentStateChange(subagent);

      const taskTool = harness.state.messages[0].toolCalls![0];
      expect(taskTool.status).toBe('completed');
      expect(taskTool.subagent?.status).toBe('completed');
      expect(taskTool.subagent?.result).toBe('done');
      expect(harness.scrollToBottom).toHaveBeenCalled();
    });

    it('should not crash when subagent not found in messages', () => {
      const subagent = { id: 'unknown', description: 'test', status: 'completed', toolCalls: [] } as any;
      harness.state.messages = [{
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'task-1',
          name: TOOL_SUBAGENT,
          input: { description: 'test' },
          status: 'running',
        }],
      }] as any;

      expect(() => harness.router.onAsyncSubagentStateChange(subagent)).not.toThrow();
      expect(harness.state.messages[0].toolCalls![0].status).toBe('running');
    });
  });

  describe('handleAsyncSubagentCompletion', () => {
    it('recovers transcript-backed async subagent tools and final result', async () => {
      const completedSubagent = {
        agentId: 'agent-1',
        asyncStatus: 'completed',
        id: 'task-1',
        description: 'Background task',
        mode: 'async',
        status: 'completed',
        toolCalls: [],
      };
      const completion = {
        type: 'async_subagent_completion' as const,
        providerSessionId: 'session-1',
        taskId: 'agent-1',
        toolUseId: 'task-1',
        status: 'completed' as const,
        result: 'Final result',
      };
      harness.subagentManager.handleAsyncSubagentCompletion.mockReturnValueOnce(completedSubagent);
      harness.subagentManager.getByTaskId.mockReturnValue(completedSubagent);
      (harness.historyRecovery.loadSubagentToolCalls as jest.Mock).mockResolvedValueOnce([{
        id: 'nested-tool',
        input: { path: 'README.md' },
        isExpanded: false,
        name: 'Read',
        status: 'completed',
      }]);
      (harness.historyRecovery.loadSubagentFinalResult as jest.Mock)
        .mockResolvedValueOnce('Recovered final result');

      await expect(harness.router.handleAsyncSubagentCompletion(completion)).resolves.toBe(true);

      expect(harness.subagentManager.handleAsyncSubagentCompletion).toHaveBeenCalledWith(completion);
      expect(harness.historyRecovery.loadSubagentToolCalls).toHaveBeenCalledWith({
        providerId: 'claude',
        providerSessionId: 'session-1',
        subagentId: 'agent-1',
      });
      expect(harness.historyRecovery.loadSubagentFinalResult).toHaveBeenCalledWith({
        providerId: 'claude',
        providerSessionId: 'session-1',
        subagentId: 'agent-1',
      });
      expect(completedSubagent.toolCalls).toEqual([
        expect.objectContaining({
          id: 'nested-tool',
          input: { path: 'README.md' },
        }),
      ]);
      expect(completedSubagent).toMatchObject({
        result: 'Recovered final result',
      });
      expect(harness.subagentManager.refreshAsyncSubagent).toHaveBeenCalledWith(completedSubagent);
      expect(harness.indicator.show).toHaveBeenCalled();
    });

    it('bounds final-result retries and fences a replaced provider session', async () => {
      const completedSubagent = {
        agentId: 'agent-1',
        asyncStatus: 'completed',
        description: 'Background task',
        id: 'task-1',
        mode: 'async',
        result: 'Notification fallback',
        status: 'completed',
        toolCalls: [],
      };
      harness.subagentManager.handleAsyncSubagentCompletion.mockReturnValueOnce(completedSubagent);
      harness.subagentManager.getByTaskId.mockReturnValue(completedSubagent);
      (harness.historyRecovery.loadSubagentFinalResult as jest.Mock).mockResolvedValue(null);

      await harness.router.handleAsyncSubagentCompletion({
        providerSessionId: 'session-1',
        status: 'completed',
        taskId: 'agent-1',
        toolUseId: 'task-1',
        type: 'async_subagent_completion',
      });
      harness.providerSessionId = 'session-2';
      await jest.advanceTimersByTimeAsync(10_000);

      expect(harness.historyRecovery.loadSubagentFinalResult).toHaveBeenCalledTimes(1);
      expect(completedSubagent.result).toBe('Notification fallback');
      expect(harness.subagentManager.refreshAsyncSubagent).not.toHaveBeenCalled();
    });

    it('does not schedule transcript retries when the provider has no recovery service', async () => {
      const completedSubagent = {
        agentId: 'agent-1',
        asyncStatus: 'completed',
        description: 'Background task',
        id: 'task-1',
        mode: 'async',
        result: 'Notification result',
        status: 'completed',
        toolCalls: [],
      };
      harness.subagentManager.handleAsyncSubagentCompletion.mockReturnValueOnce(completedSubagent);
      harness.subagentManager.getByTaskId.mockReturnValue(completedSubagent);
      (harness.historyRecovery.loadSubagentToolCalls as jest.Mock).mockResolvedValue(undefined);
      (harness.historyRecovery.loadSubagentFinalResult as jest.Mock).mockResolvedValue(undefined);

      await harness.router.handleAsyncSubagentCompletion({
        providerSessionId: 'session-1',
        status: 'completed',
        taskId: 'agent-1',
        toolUseId: 'task-1',
        type: 'async_subagent_completion',
      });
      await jest.advanceTimersByTimeAsync(10_000);

      expect(harness.historyRecovery.loadSubagentToolCalls).toHaveBeenCalledTimes(1);
      expect(harness.historyRecovery.loadSubagentFinalResult).not.toHaveBeenCalled();
      expect(completedSubagent.result).toBe('Notification result');
      expect(harness.subagentManager.refreshAsyncSubagent).not.toHaveBeenCalled();
    });

    it('reports an unmatched normalized async completion without provider-native recovery', async () => {
      await expect(harness.router.handleAsyncSubagentCompletion({
        type: 'async_subagent_completion',
        providerSessionId: 'session-1',
        taskId: 'agent-missing',
        toolUseId: 'task-missing',
        status: 'completed',
      })).resolves.toBe(false);

      expect(harness.subagentManager.handleAsyncSubagentCompletion).toHaveBeenCalledTimes(1);
      expect(harness.historyRecovery.loadSubagentToolCalls).not.toHaveBeenCalled();
      expect(harness.indicator.show).not.toHaveBeenCalled();
    });
  });
});
