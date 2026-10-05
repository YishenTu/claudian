import type { SubagentInfo, ToolCallInfo } from '@/core/types';
import { resolveStoredTaskSubagent } from '@/features/chat/subagents/storedTaskSubagent';

function taskCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'task-1',
    name: 'Agent',
    input: { description: 'Run tests', prompt: 'Run the suite' },
    status: 'completed',
    result: 'All passed',
    ...overrides,
  };
}

describe('resolveStoredTaskSubagent', () => {
  describe('synchronous spawn', () => {
    it('keeps the tool call description, prompt and result for a completed call', () => {
      expect(resolveStoredTaskSubagent(taskCall())).toEqual({
        id: 'task-1',
        description: 'Run tests',
        prompt: 'Run the suite',
        status: 'completed',
        toolCalls: [],
        isExpanded: false,
        result: 'All passed',
      });
    });

    it.each([
      ['error', 'error'],
      ['blocked', 'error'],
      ['running', 'running'],
    ] as const)('maps tool status %s to subagent status %s', (toolStatus, expected) => {
      expect(resolveStoredTaskSubagent(taskCall({ status: toolStatus })).status).toBe(expected);
    });

    it('treats a legacy pending status as running', () => {
      const status = 'pending' as unknown as ToolCallInfo['status'];

      expect(resolveStoredTaskSubagent(taskCall({ status })).status).toBe('running');
    });

    it('uses the fallback description when the input has none', () => {
      expect(resolveStoredTaskSubagent(taskCall({ input: {} }))).toMatchObject({
        description: 'Subagent task',
        prompt: '',
      });
    });
  });

  describe('asynchronous spawn', () => {
    const asyncCall = (overrides: Partial<ToolCallInfo>) => taskCall({
      input: { description: 'Background task', run_in_background: true },
      ...overrides,
    });

    it.each([
      ['not_ready', '{"retrieval_status":"not_ready"}'],
      ['not ready', 'The task is not ready yet'],
      ['running', '{"status":"running"}'],
      ['pending', '{"status":"pending"}'],
      ['retrieval running', '{"retrieval_status":"running"}'],
    ])('infers running from a completed call whose result reports %s', (_name, result) => {
      const info = resolveStoredTaskSubagent(asyncCall({ result }));

      expect(info).toMatchObject({ mode: 'async', status: 'running', asyncStatus: 'running', result });
    });

    it('infers running from structured text-block results', () => {
      const result = [{ type: 'text', text: '{"status":"running"}' }] as unknown as string;

      expect(resolveStoredTaskSubagent(asyncCall({ result }))).toMatchObject({
        mode: 'async',
        status: 'running',
        asyncStatus: 'running',
      });
    });

    it('treats a completed call with a final result as completed', () => {
      expect(resolveStoredTaskSubagent(asyncCall({ result: 'Finished the work' }))).toMatchObject({
        mode: 'async',
        status: 'completed',
        asyncStatus: 'completed',
      });
    });

    it.each(['error', 'blocked'] as const)('maps tool status %s to error even when the result says running', (status) => {
      expect(resolveStoredTaskSubagent(asyncCall({ status, result: '{"status":"running"}' }))).toMatchObject({
        status: 'error',
        asyncStatus: 'error',
      });
    });

    it('keeps a running call running regardless of its result', () => {
      expect(resolveStoredTaskSubagent(asyncCall({ status: 'running', result: 'done' }))).toMatchObject({
        status: 'running',
        asyncStatus: 'running',
      });
    });
  });

  describe('mode hint', () => {
    it('forces an async rendering for a call without run_in_background', () => {
      const info = resolveStoredTaskSubagent(taskCall({ result: '{"status":"pending"}' }), 'async');

      expect(info).toMatchObject({ mode: 'async', status: 'running', asyncStatus: 'running' });
    });

    it('forces a synchronous rendering for a call that requested background execution', () => {
      const info = resolveStoredTaskSubagent(
        taskCall({ input: { description: 'Task', run_in_background: true }, result: '{"status":"running"}' }),
        'sync',
      );

      expect(info.mode).toBeUndefined();
      expect(info.asyncStatus).toBeUndefined();
      expect(info.status).toBe('completed');
    });
  });

  describe('linked subagent', () => {
    const linked: SubagentInfo = {
      id: 'task-1',
      description: 'Linked',
      mode: 'async',
      asyncStatus: 'running',
      status: 'running',
      toolCalls: [],
      isExpanded: false,
    };

    it('returns the linked subagent itself when no hint disagrees with it', () => {
      const call = taskCall({ subagent: linked });

      expect(resolveStoredTaskSubagent(call)).toBe(linked);
      expect(resolveStoredTaskSubagent(call, 'async')).toBe(linked);
    });

    it('overrides only the mode, without mutating the linked subagent, when the hint differs', () => {
      const info = resolveStoredTaskSubagent(taskCall({ subagent: linked }), 'sync');

      expect(info).toEqual({ ...linked, mode: 'sync' });
      expect(info).not.toBe(linked);
      expect(linked.mode).toBe('async');
    });
  });
});
