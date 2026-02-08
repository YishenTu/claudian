import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { SubagentInfo, ToolCallInfo } from '@/core/types';
import { SubagentManager } from '@/features/chat/services/SubagentManager';

jest.mock('@/features/chat/rendering', () => ({
  createSubagentBlock: jest.fn().mockImplementation((_parentEl: any, toolId: string, input: any) => ({
    wrapperEl: { querySelector: jest.fn().mockReturnValue(null) },
    contentEl: {},
    info: {
      id: toolId,
      description: input?.description || 'Task',
      prompt: input?.prompt || '',
      mode: 'sync',
      isExpanded: false,
      status: 'running',
      toolCalls: [],
    },
    toolCallStates: new Map(),
  })),
  createAsyncSubagentBlock: jest.fn().mockImplementation((_parentEl: any, toolId: string, input: any) => ({
    wrapperEl: { querySelector: jest.fn().mockReturnValue(null) },
    info: {
      id: toolId,
      description: input?.description || 'Background task',
      prompt: input?.prompt || '',
      mode: 'async',
      isExpanded: false,
      status: 'running',
      toolCalls: [],
      asyncStatus: 'pending',
    },
    statusEl: {},
  })),
  addSubagentToolCall: jest.fn(),
  updateSubagentToolResult: jest.fn(),
  finalizeSubagentBlock: jest.fn(),
  updateAsyncSubagentRunning: jest.fn(),
  finalizeAsyncSubagent: jest.fn(),
  markAsyncSubagentOrphaned: jest.fn(),
}));

const createManager = () => {
  const updates: SubagentInfo[] = [];
  const manager = new SubagentManager((subagent) => {
    updates.push({ ...subagent });
  });
  return { manager, updates };
};

const createMockEl = () => ({ createDiv: jest.fn(), appendChild: jest.fn() } as any);

describe('SubagentManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================
  // Async Lifecycle Tests (migrated from AsyncSubagentManager)
  // ============================================

  describe('async lifecycle', () => {
    it('detects async task flag correctly', () => {
      const { manager } = createManager();
      expect(manager.isAsyncTask({ run_in_background: true })).toBe(true);
      expect(manager.isAsyncTask({ run_in_background: false })).toBe(false);
    });

    it('transitions from pending to running when agent_id is parsed', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { description: 'Background', run_in_background: true }, parentEl);
      expect(manager.getByTaskId('task-1')?.asyncStatus).toBe('pending');

      manager.handleTaskToolResult('task-1', JSON.stringify({ agent_id: 'agent-123' }));

      const running = manager.getByAgentId('agent-123');
      expect(running?.asyncStatus).toBe('running');
      expect(running?.agentId).toBe('agent-123');
      expect(updates[updates.length - 1].agentId).toBe('agent-123');
      expect(manager.isPendingAsyncTask('task-1')).toBe(false);
    });

    it('transitions from pending to running when agent_id exists only in toolUseResult', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-structured', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult(
        'task-structured',
        'Task launched',
        false,
        { data: { agent_id: 'agent-structured-1' } }
      );

      const running = manager.getByAgentId('agent-structured-1');
      expect(running?.asyncStatus).toBe('running');
      expect(running?.agentId).toBe('agent-structured-1');
      expect(updates[updates.length - 1].agentId).toBe('agent-structured-1');
      expect(manager.isPendingAsyncTask('task-structured')).toBe(false);
    });

    it('moves to error when Task tool_result parsing fails', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-parse-fail', { description: 'No id', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-parse-fail', 'no agent id present');

      expect(manager.getByTaskId('task-parse-fail')).toBeUndefined();
      const last = updates[updates.length - 1];
      expect(last.asyncStatus).toBe('error');
      expect(last.result).toContain('Failed to parse agent_id');
    });

    it('moves to error when Task tool_result itself is an error', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-error', { description: 'Will fail', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-error', 'launch failed', true);

      expect(manager.getByTaskId('task-error')).toBeUndefined();
      const last = updates[updates.length - 1];
      expect(last.asyncStatus).toBe('error');
      expect(last.result).toBe('launch failed');
    });

    it('stays running when AgentOutputTool reports not_ready', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-running', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-running', JSON.stringify({ agent_id: 'agent-abc' }));

      const toolCall: ToolCallInfo = {
        id: 'output-not-ready',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-abc' },
        status: 'running',
        isExpanded: false,
      };
      manager.handleAgentOutputToolUse(toolCall);

      const stillRunning = manager.handleAgentOutputToolResult(
        'output-not-ready',
        JSON.stringify({ retrieval_status: 'not_ready', agents: {} }),
        false
      );

      expect(stillRunning?.asyncStatus).toBe('running');
      expect(manager.getByAgentId('agent-abc')?.asyncStatus).toBe('running');
      expect(manager.hasActiveAsync()).toBe(true);
    });

    it('ignores unrelated tool_result when async subagent is active', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-standalone', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-standalone', JSON.stringify({ agent_id: 'agent-standalone' }));

      const unrelated = manager.handleAgentOutputToolResult(
        'non-agent-output',
        'regular tool output',
        false
      );

      expect(unrelated).toBeUndefined();
      expect(manager.getByAgentId('agent-standalone')?.asyncStatus).toBe('running');
      expect(manager.hasActiveAsync()).toBe(true);
    });

    it('finalizes to completed when AgentOutputTool succeeds and extracts result', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-complete', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-complete', JSON.stringify({ agent_id: 'agent-complete' }));

      const toolCall: ToolCallInfo = {
        id: 'output-success',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-complete' },
        status: 'running',
        isExpanded: false,
      };
      manager.handleAgentOutputToolUse(toolCall);

      const completed = manager.handleAgentOutputToolResult(
        'output-success',
        JSON.stringify({
          retrieval_status: 'success',
          agents: { 'agent-complete': { status: 'completed', result: 'done!' } },
        }),
        false
      );

      expect(completed?.asyncStatus).toBe('completed');
      expect(completed?.result).toBe('done!');
      expect(updates[updates.length - 1].asyncStatus).toBe('completed');
      expect(manager.getByAgentId('agent-complete')).toBeUndefined();
      expect(manager.hasActiveAsync()).toBe(false);
    });

    it('finalizes to error when AgentOutputTool result has isError=true', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-err', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-err', JSON.stringify({ agent_id: 'agent-err' }));

      const toolCall: ToolCallInfo = {
        id: 'output-err',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-err' },
        status: 'running',
        isExpanded: false,
      };
      manager.handleAgentOutputToolUse(toolCall);

      const errored = manager.handleAgentOutputToolResult(
        'output-err',
        'agent crashed',
        true
      );

      expect(errored?.asyncStatus).toBe('error');
      expect(errored?.status).toBe('error');
      expect(errored?.result).toBe('agent crashed');
      expect(updates[updates.length - 1].asyncStatus).toBe('error');
      expect(manager.getByAgentId('agent-err')).toBeUndefined();
      expect(manager.hasActiveAsync()).toBe(false);
    });

    it('marks pending and running async subagents as orphaned', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('pending-task', { description: 'Pending task', run_in_background: true }, parentEl);
      manager.handleTaskToolUse('running-task', { description: 'Running task', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('running-task', JSON.stringify({ agent_id: 'agent-running' }));

      const orphaned = manager.orphanAllActive();

      expect(orphaned).toHaveLength(2);
      orphaned.forEach((subagent) => {
        expect(subagent.asyncStatus).toBe('orphaned');
        expect(subagent.result).toContain('Conversation ended');
      });
      expect(manager.hasActiveAsync()).toBe(false);
    });

    it('ignores Task results for unknown tasks', () => {
      const { manager } = createManager();

      manager.handleTaskToolResult('missing-task', 'agent_id: x');

      expect(manager.getByTaskId('missing-task')).toBeUndefined();
    });

    it('ignores AgentOutputTool when missing agentId', () => {
      const { manager } = createManager();

      manager.handleAgentOutputToolUse({
        id: 'output-1',
        name: 'AgentOutputTool',
        input: {},
        status: 'running',
        isExpanded: false,
      });

      expect(manager.isLinkedAgentOutputTool('output-1')).toBe(false);
    });

    it('ignores AgentOutputTool when referencing unknown agent', () => {
      const { manager } = createManager();

      manager.handleAgentOutputToolUse({
        id: 'output-unknown',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-x' },
        status: 'running',
        isExpanded: false,
      });

      expect(manager.isLinkedAgentOutputTool('output-unknown')).toBe(false);
    });

    it('handles TaskOutput with task_id parameter (SDK format)', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-sdk', { description: 'SDK test', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-sdk', JSON.stringify({ agent_id: 'agent-sdk-123' }));

      const toolCall: ToolCallInfo = {
        id: 'taskoutput-1',
        name: 'TaskOutput',
        input: { task_id: 'agent-sdk-123' },
        status: 'running',
        isExpanded: false,
      };
      manager.handleAgentOutputToolUse(toolCall);

      expect(manager.isLinkedAgentOutputTool('taskoutput-1')).toBe(true);

      const completed = manager.handleAgentOutputToolResult(
        'taskoutput-1',
        JSON.stringify({
          retrieval_status: 'success',
          agents: { 'agent-sdk-123': { status: 'completed', result: 'task_id works!' } },
        }),
        false
      );

      expect(completed?.asyncStatus).toBe('completed');
      expect(completed?.result).toBe('task_id works!');
      expect(updates[updates.length - 1].asyncStatus).toBe('completed');
    });

    it('returns undefined on invalid AgentOutputTool state transition', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-done', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-done', JSON.stringify({ agent_id: 'agent-done' }));

      manager.handleAgentOutputToolUse({
        id: 'output-any',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-done' },
        status: 'running',
        isExpanded: false,
      });

      // Manually mark completed to force invalid transition
      const sub = manager.getByAgentId('agent-done')!;
      sub.asyncStatus = 'completed';

      const res = manager.handleAgentOutputToolResult('output-any', '{"retrieval_status":"success"}', false);
      expect(res).toBeUndefined();
    });

    it('treats plain text not_ready as still running', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-plain', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-plain', JSON.stringify({ agent_id: 'agent-plain' }));

      const toolCall: ToolCallInfo = {
        id: 'output-plain',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-plain' },
        status: 'running',
        isExpanded: false,
      };
      manager.handleAgentOutputToolUse(toolCall);

      const running = manager.handleAgentOutputToolResult('output-plain', 'not ready', false);
      expect(running?.asyncStatus).toBe('running');
    });

    it('treats XML-style status running as still running', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-xml', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-xml', JSON.stringify({ agent_id: 'agent-xml' }));

      const toolCall: ToolCallInfo = {
        id: 'output-xml',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-xml' },
        status: 'running',
        isExpanded: false,
      };
      manager.handleAgentOutputToolUse(toolCall);

      const xmlResult = `<retrieval_status>not_ready</retrieval_status>
<task_id>agent-xml</task_id>
<task_type>local_agent</task_type>
<status>running</status>`;

      const running = manager.handleAgentOutputToolResult('output-xml', xmlResult, false);
      expect(running?.asyncStatus).toBe('running');
    });

    it('extracts first agent result when agentId is missing', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-first', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-first', JSON.stringify({ agent_id: 'agent-first' }));

      const toolCall: ToolCallInfo = {
        id: 'output-first',
        name: 'AgentOutputTool',
        input: { agent_id: 'agent-first' },
        status: 'running',
        isExpanded: false,
      };
      manager.handleAgentOutputToolUse(toolCall);

      const completed = manager.handleAgentOutputToolResult(
        'output-first',
        JSON.stringify({ retrieval_status: 'success', agents: { other: { status: 'completed', result: 'ok' } } }),
        false
      );

      expect(completed?.result).toBe('ok');
    });

    it('infers agentId from AgentOutputTool result when not linked', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-infer', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-infer', JSON.stringify({ agent_id: 'agent-infer' }));

      const result = JSON.stringify({
        retrieval_status: 'success',
        agents: { 'agent-infer': { status: 'completed', result: 'ok' } },
      });

      const completed = manager.handleAgentOutputToolResult('unlinked', result, false);
      expect(completed?.asyncStatus).toBe('completed');
      expect(completed?.result).toBe('ok');
    });

    it('gets running subagent by task id after transition', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-map', { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult('task-map', JSON.stringify({ agent_id: 'agent-map' }));

      expect(manager.getByTaskId('task-map')?.agentId).toBe('agent-map');
    });
  });

  // ============================================
  // Async Parsing Edge Cases (via public API)
  // ============================================

  describe('async parsing edge cases', () => {
    const setupLinkedAgentOutput = (
      manager: ReturnType<typeof createManager>['manager'],
      taskId: string,
      agentId: string,
      outputToolId: string
    ) => {
      const parentEl = createMockEl();
      manager.handleTaskToolUse(taskId, { description: 'Background', run_in_background: true }, parentEl);
      manager.handleTaskToolResult(taskId, JSON.stringify({ agent_id: agentId }));
      manager.handleAgentOutputToolUse({
        id: outputToolId,
        name: 'AgentOutputTool',
        input: { agent_id: agentId },
        status: 'running',
        isExpanded: false,
      });
    };

    // ---- still-running detection with envelope forms ----

    it('stays running with array envelope containing not_ready', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-1', 'out-1');

      const arrayEnvelope = JSON.stringify([
        { text: JSON.stringify({ retrieval_status: 'not_ready', agents: {} }) },
      ]);
      const result = manager.handleAgentOutputToolResult('out-1', arrayEnvelope, false);
      expect(result?.asyncStatus).toBe('running');
    });

    it('stays running with object envelope containing running status', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-1', 'out-1');

      const objectEnvelope = JSON.stringify({
        text: JSON.stringify({ retrieval_status: 'running', agents: {} }),
      });
      const result = manager.handleAgentOutputToolResult('out-1', objectEnvelope, false);
      expect(result?.asyncStatus).toBe('running');
    });

    it('finalizes when result is whitespace-only', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-1', 'out-1');

      const result = manager.handleAgentOutputToolResult('out-1', '   ', false);
      expect(result?.asyncStatus).toBe('completed');
    });

    it('finalizes to error when isError is true regardless of content', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-1', 'out-1');

      const result = manager.handleAgentOutputToolResult('out-1', 'whatever', true);
      expect(result?.asyncStatus).toBe('error');
    });

    it('finalizes when retrieval_status is success without agents', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-1', 'out-1');

      const result = manager.handleAgentOutputToolResult(
        'out-1',
        JSON.stringify({ retrieval_status: 'success' }),
        false
      );
      expect(result?.asyncStatus).toBe('completed');
    });

    it('finalizes when retrieval_status is unknown', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-1', 'out-1');

      const result = manager.handleAgentOutputToolResult(
        'out-1',
        JSON.stringify({ retrieval_status: 'unknown' }),
        false
      );
      expect(result?.asyncStatus).toBe('completed');
    });

    it('finalizes with plain text as result when no running indicators', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-1', 'out-1');

      const result = manager.handleAgentOutputToolResult('out-1', 'plain output', false);
      expect(result?.asyncStatus).toBe('completed');
      expect(result?.result).toBe('plain output');
    });

    // ---- result extraction with envelope forms ----

    it('extracts result from array envelope', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'a', 'out-1');

      const payloadArray = JSON.stringify([
        { text: JSON.stringify({ retrieval_status: 'success', agents: { a: { result: 'R' } } }) },
      ]);
      const result = manager.handleAgentOutputToolResult('out-1', payloadArray, false);
      expect(result?.result).toBe('R');
    });

    it('extracts result from object envelope', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'a', 'out-1');

      const payloadObject = JSON.stringify({
        text: JSON.stringify({ retrieval_status: 'success', agents: { a: { status: 'completed' } } }),
      });
      const result = manager.handleAgentOutputToolResult('out-1', payloadObject, false);
      expect(result?.result).toContain('completed');
    });

    it('extracts only final assistant result from XML output payload', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'a6ac482', 'out-1');

      const outputLines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I will search first.' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Grep', input: { pattern: 'martini' } }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Final answer: 24 matches across 6 files.' }],
          },
        }),
      ].join('\n');

      const xmlPayload = `<retrieval_status>success</retrieval_status>
<task_id>a6ac482</task_id>
<status>completed</status>
<output>
${outputLines}
</output>`;

      const result = manager.handleAgentOutputToolResult('out-1', xmlPayload, false);
      expect(result?.result).toBe('Final answer: 24 matches across 6 files.');
    });

    it('extracts final assistant result from structured toolUseResult.task.result', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-structured', 'out-1');

      const outputLines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Intermediate step' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Final summary from structured result.' }],
          },
        }),
      ].join('\n');

      const structuredToolUseResult = {
        retrieval_status: 'success',
        task: {
          task_id: 'agent-structured',
          status: 'completed',
          result: outputLines,
          output: outputLines,
        },
      };

      const result = manager.handleAgentOutputToolResult(
        'out-1',
        '{"retrieval_status":"success"}',
        false,
        structuredToolUseResult
      );
      expect(result?.result).toBe('Final summary from structured result.');
    });

    it('extracts full result from SDK toolUseResult.content array', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-sdk-content', 'out-1');

      const fullResult = 'This is the full multi-line result.\n\nLine 2 of the result.\nLine 3 with details.';
      const sdkToolUseResult = {
        status: 'completed',
        content: [
          { type: 'text', text: fullResult },
        ],
        agentId: 'agent-sdk-content',
        prompt: 'Do something',
        totalDurationMs: 5000,
        totalTokens: 1000,
        totalToolUseCount: 5,
      };

      const result = manager.handleAgentOutputToolResult(
        'out-1',
        '{}',
        false,
        sdkToolUseResult
      );
      expect(result?.result).toBe(fullResult);
    });

    it('extracts result from SDK content array with multiple text blocks', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-multi', 'out-1');

      const sdkToolUseResult = {
        status: 'completed',
        content: [
          { type: 'text', text: 'Main result text here.' },
          { type: 'text', text: 'agentId: agent-multi\n<usage>total_tokens: 100</usage>' },
        ],
        agentId: 'agent-multi',
      };

      const result = manager.handleAgentOutputToolResult(
        'out-1',
        '{}',
        false,
        sdkToolUseResult
      );
      // Should return the first text block (actual result), not the metadata block
      expect(result?.result).toBe('Main result text here.');
    });

    it('reads full output file when inline output is truncated', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-full-output', 'out-1');

      const tempDir = mkdtempSync(join(tmpdir(), 'subagent-output-'));
      const fullOutputFile = join(tempDir, 'agent.output');
      const fullOutput = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Recovered final answer from full output file.' }],
          },
        }),
      ].join('\n');
      writeFileSync(fullOutputFile, fullOutput, 'utf-8');

      const inlineOutput = `[Truncated. Full output: ${fullOutputFile}]`;
      const xmlPayload = `<retrieval_status>success</retrieval_status>
<task_id>agent-full-output</task_id>
<status>completed</status>
<output>
${inlineOutput}
</output>`;

      try {
        const result = manager.handleAgentOutputToolResult('out-1', xmlPayload, false);
        expect(result?.result).toBe('Recovered final answer from full output file.');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('ignores truncated full output files outside trusted temp roots', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-untrusted-output', 'out-1');

      const fullOutputFile = join(process.cwd(), 'agent-untrusted.output');
      const fullOutput = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Should not be loaded from untrusted path.' }],
          },
        }),
      ].join('\n');
      writeFileSync(fullOutputFile, fullOutput, 'utf-8');

      const inlineOutput = `[Truncated. Full output: ${fullOutputFile}]`;
      const xmlPayload = `<retrieval_status>success</retrieval_status>
<task_id>agent-untrusted-output</task_id>
<status>completed</status>
<output>
${inlineOutput}
</output>`;

      try {
        const result = manager.handleAgentOutputToolResult('out-1', xmlPayload, false);
        expect(result?.result).toBe(inlineOutput);
      } finally {
        rmSync(fullOutputFile, { force: true });
      }
    });

    it('extracts direct result tag when present', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-x', 'out-1');

      const taggedPayload = `<status>completed</status>
<result>
Only this is the final result.
</result>`;

      const result = manager.handleAgentOutputToolResult('out-1', taggedPayload, false);
      expect(result?.result).toBe('Only this is the final result.');
    });

    it('falls back to first agent when agentId is missing from agents map', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-x', 'out-1');

      const fallback = JSON.stringify({
        retrieval_status: 'success',
        agents: { first: { status: 'completed' } },
      });
      const result = manager.handleAgentOutputToolResult('out-1', fallback, false);
      expect(result?.result).toContain('completed');
    });

    it('returns raw payload when no agents key is present', () => {
      const { manager } = createManager();
      setupLinkedAgentOutput(manager, 'task-1', 'agent-x', 'out-1');

      const noAgents = JSON.stringify({ foo: 'bar' });
      const result = manager.handleAgentOutputToolResult('out-1', noAgents, false);
      expect(result?.result).toBe(noAgents);
    });

    // ---- agent ID parsing from multiple JSON shapes ----

    it('parses camelCase agentId from task result', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();
      manager.handleTaskToolUse('task-1', { description: 'Bg', run_in_background: true }, parentEl);

      manager.handleTaskToolResult('task-1', JSON.stringify({ agentId: 'camel' }));
      expect(manager.getByAgentId('camel')).toBeDefined();
      expect(manager.getByAgentId('camel')?.agentId).toBe('camel');
    });

    it('parses nested data.agent_id from task result', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();
      manager.handleTaskToolUse('task-1', { description: 'Bg', run_in_background: true }, parentEl);

      manager.handleTaskToolResult('task-1', JSON.stringify({ data: { agent_id: 'nested' } }));
      expect(manager.getByAgentId('nested')).toBeDefined();
    });

    it('parses id field from task result', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();
      manager.handleTaskToolUse('task-1', { description: 'Bg', run_in_background: true }, parentEl);

      manager.handleTaskToolResult('task-1', JSON.stringify({ id: 'idfield' }));
      expect(manager.getByAgentId('idfield')).toBeDefined();
    });

    it('parses unicode-escaped agent_id from task result', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();
      manager.handleTaskToolUse('task-1', { description: 'Bg', run_in_background: true }, parentEl);

      manager.handleTaskToolResult('task-1', '{"agent\\u005fid":"escaped"}');
      expect(manager.getByAgentId('escaped')).toBeDefined();
    });

    it('parses nested unicode-escaped agent_id from task result', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();
      manager.handleTaskToolUse('task-1', { description: 'Bg', run_in_background: true }, parentEl);

      manager.handleTaskToolResult('task-1', '{"data": {"agent\\u005fid": "nested2"}}');
      expect(manager.getByAgentId('nested2')).toBeDefined();
    });

    it('transitions to error when no recognizable agent ID in task result', () => {
      const { manager, updates } = createManager();
      const parentEl = createMockEl();
      manager.handleTaskToolUse('task-1', { description: 'Bg', run_in_background: true }, parentEl);

      manager.handleTaskToolResult('task-1', '{"foo": "bar"}');
      const last = updates[updates.length - 1];
      expect(last.asyncStatus).toBe('error');
      expect(last.result).toContain('Failed to parse agent_id');
    });
  });

  // ============================================
  // Unified Task Entry Point
  // ============================================

  describe('handleTaskToolUse', () => {
    it('buffers task in pendingTasks when currentContentEl is null', () => {
      const { manager } = createManager();

      const result = manager.handleTaskToolUse('task-1', { prompt: 'test' }, null);
      expect(result.action).toBe('buffered');
      expect(manager.hasPendingTask('task-1')).toBe(true);
    });

    it('renders task buffered with null parentEl once contentEl becomes available', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      // First chunk: no content element
      manager.handleTaskToolUse('task-1', { prompt: 'test' }, null);
      expect(manager.hasPendingTask('task-1')).toBe(true);

      // Second chunk: content element available, run_in_background known
      const result = manager.handleTaskToolUse('task-1', { run_in_background: false }, parentEl);
      expect(result.action).toBe('created_sync');
      expect(manager.hasPendingTask('task-1')).toBe(false);
    });

    it('returns created_sync for run_in_background=false', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      const result = manager.handleTaskToolUse(
        'task-sync',
        { prompt: 'test', run_in_background: false },
        parentEl
      );

      expect(result.action).toBe('created_sync');
      expect((result as any).subagentState.info.id).toBe('task-sync');
    });

    it('returns created_async for run_in_background=true', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      const result = manager.handleTaskToolUse(
        'task-async',
        { description: 'Background', run_in_background: true },
        parentEl
      );

      expect(result.action).toBe('created_async');
      expect((result as any).info.id).toBe('task-async');
      expect((result as any).info.asyncStatus).toBe('pending');
    });

    it('buffers task when run_in_background is missing', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      const result = manager.handleTaskToolUse(
        'task-unknown',
        { prompt: 'test' },
        parentEl
      );

      expect(result.action).toBe('buffered');
      expect(manager.hasPendingTask('task-unknown')).toBe(true);
    });

    it('upgrades buffered task to async when run_in_background=true arrives later', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      const first = manager.handleTaskToolUse(
        'task-upgrade',
        { prompt: 'test' },
        parentEl
      );
      expect(first.action).toBe('buffered');
      expect(manager.hasPendingTask('task-upgrade')).toBe(true);

      const second = manager.handleTaskToolUse(
        'task-upgrade',
        { run_in_background: true, description: 'Background' },
        parentEl
      );

      expect(second.action).toBe('created_async');
      expect((second as any).info.id).toBe('task-upgrade');
      expect(manager.hasPendingTask('task-upgrade')).toBe(false);
    });

    it('returns label_updated for already rendered sync subagent', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      // Create sync
      manager.handleTaskToolUse('task-1', { run_in_background: false, description: 'Initial' }, parentEl);

      // Update input
      const result = manager.handleTaskToolUse('task-1', { description: 'Updated' }, parentEl);
      expect(result.action).toBe('label_updated');
    });

    it('returns label_updated for already rendered async subagent', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      // Create async
      manager.handleTaskToolUse('task-1', { run_in_background: true, description: 'Initial' }, parentEl);

      // Update input
      const result = manager.handleTaskToolUse('task-1', { description: 'Updated' }, parentEl);
      expect(result.action).toBe('label_updated');
    });

    it('syncs async label update to canonical SubagentInfo', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { run_in_background: true, description: 'Initial' }, parentEl);

      // Canonical info should have initial description
      expect(manager.getByTaskId('task-1')?.description).toBe('Initial');

      // Update label via streaming input
      manager.handleTaskToolUse('task-1', { description: 'Updated description' }, parentEl);

      // Canonical info should now reflect the update
      expect(manager.getByTaskId('task-1')?.description).toBe('Updated description');
    });

    it('propagates prompt updates in label update', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { run_in_background: true, description: 'Bg', prompt: 'initial' }, parentEl);

      // Update prompt via streaming input
      manager.handleTaskToolUse('task-1', { prompt: 'full prompt text' }, parentEl);

      // Both DOM state info and canonical info should have updated prompt
      const domState = manager.getAsyncDomState('task-1');
      expect(domState?.info.prompt).toBe('full prompt text');
      expect(manager.getByTaskId('task-1')?.prompt).toBe('full prompt text');
    });

    it('merges buffered input and renders once content element becomes available', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      // First chunk without content target must be buffered.
      manager.handleTaskToolUse('task-1', { description: 'Initial description' }, null);
      expect(manager.hasPendingTask('task-1')).toBe(true);

      // Second chunk arrives with a content target, additional input, and confirmed mode.
      const result = manager.handleTaskToolUse(
        'task-1',
        { prompt: 'latest prompt', run_in_background: false },
        parentEl
      );

      expect(result.action).toBe('created_sync');
      expect((result as any).subagentState.info.description).toBe('Initial description');
      expect((result as any).subagentState.info.prompt).toBe('latest prompt');
      expect(manager.hasPendingTask('task-1')).toBe(false);
    });

    it('increments spawned count when creating sync task', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      expect(manager.subagentsSpawnedThisStream).toBe(0);
      manager.handleTaskToolUse('task-1', { run_in_background: false }, parentEl);
      expect(manager.subagentsSpawnedThisStream).toBe(1);
    });

    it('increments spawned count when creating async task', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      expect(manager.subagentsSpawnedThisStream).toBe(0);
      manager.handleTaskToolUse('task-1', { run_in_background: true }, parentEl);
      expect(manager.subagentsSpawnedThisStream).toBe(1);
    });
  });

  // ============================================
  // Pending Task Resolution
  // ============================================

  describe('renderPendingTask', () => {
    it('returns null for unknown tool id', () => {
      const { manager } = createManager();

      const result = manager.renderPendingTask('unknown');
      expect(result).toBeNull();
    });

    it('renders buffered sync task and increments counter', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { prompt: 'test' }, null);

      const result = manager.renderPendingTask('task-1', parentEl);
      expect(result).not.toBeNull();
      expect(result?.mode).toBe('sync');
      expect(manager.hasPendingTask('task-1')).toBe(false);
      expect(manager.subagentsSpawnedThisStream).toBe(1);
    });

    it('returns null and keeps task pending when targetEl is null', () => {
      const { manager } = createManager();

      // Buffer with null parentEl (no content element)
      manager.handleTaskToolUse('task-1', { prompt: 'test' }, null);
      expect(manager.hasPendingTask('task-1')).toBe(true);

      // Try to render without override — both parentEl and override are null
      const result = manager.renderPendingTask('task-1');
      expect(result).toBeNull();
      expect(manager.hasPendingTask('task-1')).toBe(true);
      expect(manager.subagentsSpawnedThisStream).toBe(0);
    });

    it('renders buffered async task with parentEl override', () => {
      const { manager } = createManager();
      const overrideEl = createMockEl();

      // Buffer with null parentEl so the task stays pending despite run_in_background being known
      manager.handleTaskToolUse('task-1', { prompt: 'test', run_in_background: true }, null);
      expect(manager.hasPendingTask('task-1')).toBe(true);

      const result = manager.renderPendingTask('task-1', overrideEl);
      expect(result).not.toBeNull();
      expect(result?.mode).toBe('async');
    });

    it('does not increment spawned counter when rendering throws', () => {
      const { createSubagentBlock } = jest.requireMock('@/features/chat/rendering');
      createSubagentBlock.mockImplementationOnce(() => { throw new Error('DOM error'); });

      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { prompt: 'test' }, null);
      expect(manager.subagentsSpawnedThisStream).toBe(0);

      const result = manager.renderPendingTask('task-1', parentEl);
      expect(result).toBeNull();
      expect(manager.subagentsSpawnedThisStream).toBe(0);
    });
  });

  describe('renderPendingTaskFromTaskResult', () => {
    it('returns null for unknown tool id', () => {
      const { manager } = createManager();
      const result = manager.renderPendingTaskFromTaskResult('unknown', 'ok', false);
      expect(result).toBeNull();
    });

    it('infers async from agent_id markers when mode is still unknown', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { prompt: 'test' }, parentEl);
      const result = manager.renderPendingTaskFromTaskResult(
        'task-1',
        '{"agent_id":"agent-123"}',
        false
      );

      expect(result).not.toBeNull();
      expect(result?.mode).toBe('async');
      expect(manager.hasPendingTask('task-1')).toBe(false);
    });

    it('falls back to sync when no async evidence is present', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { prompt: 'test' }, parentEl);
      const result = manager.renderPendingTaskFromTaskResult(
        'task-1',
        '{"foo":"bar"}',
        false
      );

      expect(result).not.toBeNull();
      expect(result?.mode).toBe('sync');
      expect(manager.getSyncSubagent('task-1')).toBeDefined();
    });

    it('honors explicit async mode from input even without task-result markers', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse(
        'task-1',
        { prompt: 'test', run_in_background: true },
        null
      );
      const result = manager.renderPendingTaskFromTaskResult(
        'task-1',
        '{"foo":"bar"}',
        false,
        parentEl
      );

      expect(result).not.toBeNull();
      expect(result?.mode).toBe('async');
    });

    it('infers async from toolUseResult markers when task-result text has no agent id', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { prompt: 'test' }, parentEl);
      const result = manager.renderPendingTaskFromTaskResult(
        'task-1',
        'Launching task...',
        false,
        parentEl,
        {
          isAsync: true,
          status: 'async_launched',
          agentId: 'agent-xyz',
        }
      );

      expect(result).not.toBeNull();
      expect(result?.mode).toBe('async');
    });

    it('resolves to sync on errored task result when mode is unknown', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { prompt: 'test' }, parentEl);
      const result = manager.renderPendingTaskFromTaskResult(
        'task-1',
        '{"agent_id":"agent-123"}',
        true
      );

      expect(result).not.toBeNull();
      expect(result?.mode).toBe('sync');
    });
  });

  // ============================================
  // Sync Subagent Operations
  // ============================================

  describe('sync subagent operations', () => {
    it('creates and retrieves sync subagent', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { run_in_background: false }, parentEl);

      const state = manager.getSyncSubagent('task-1');
      expect(state).toBeDefined();
      expect(state?.info.id).toBe('task-1');
    });

    it('adds tool call to sync subagent', () => {
      const { addSubagentToolCall } = jest.requireMock('@/features/chat/rendering');
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { run_in_background: false }, parentEl);

      const toolCall: ToolCallInfo = {
        id: 'read-1',
        name: 'Read',
        input: { file_path: 'test.md' },
        status: 'running',
        isExpanded: false,
      };
      manager.addSyncToolCall('task-1', toolCall);

      expect(addSubagentToolCall).toHaveBeenCalled();
    });

    it('updates tool result in sync subagent', () => {
      const { updateSubagentToolResult } = jest.requireMock('@/features/chat/rendering');
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { run_in_background: false }, parentEl);

      const toolCall: ToolCallInfo = {
        id: 'read-1',
        name: 'Read',
        input: {},
        status: 'completed',
        isExpanded: false,
        result: 'file content',
      };
      manager.updateSyncToolResult('task-1', 'read-1', toolCall);

      expect(updateSubagentToolResult).toHaveBeenCalled();
    });

    it('finalizes sync subagent and removes from map', () => {
      const { finalizeSubagentBlock } = jest.requireMock('@/features/chat/rendering');
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { run_in_background: false }, parentEl);

      const info = manager.finalizeSyncSubagent('task-1', 'done', false);

      expect(info).not.toBeNull();
      expect(info?.id).toBe('task-1');
      expect(finalizeSubagentBlock).toHaveBeenCalled();
      expect(manager.getSyncSubagent('task-1')).toBeUndefined();
    });

    it('extracts result from SDK toolUseResult.content for sync subagent', () => {
      const { finalizeSubagentBlock } = jest.requireMock('@/features/chat/rendering');
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-sdk', { run_in_background: false }, parentEl);

      const sdkToolUseResult = {
        status: 'completed',
        content: [
          { type: 'text', text: 'Full sync subagent result with multiple lines.\n\nSecond paragraph.' },
          { type: 'text', text: 'agentId: agent-sync\n<usage>total_tokens: 500</usage>' },
        ],
        agentId: 'agent-sync',
      };

      const info = manager.finalizeSyncSubagent('task-sdk', '{}', false, sdkToolUseResult);

      expect(info).not.toBeNull();
      // Verify the extracted result (first content block) was passed to the renderer
      expect(finalizeSubagentBlock).toHaveBeenCalledWith(
        expect.anything(),
        'Full sync subagent result with multiple lines.\n\nSecond paragraph.',
        false
      );
    });

    it('returns null when finalizing nonexistent subagent', () => {
      const { manager } = createManager();

      const info = manager.finalizeSyncSubagent('nonexistent', 'done', false);
      expect(info).toBeNull();
    });

    it('ignores tool call for nonexistent subagent', () => {
      const { addSubagentToolCall } = jest.requireMock('@/features/chat/rendering');
      const { manager } = createManager();

      manager.addSyncToolCall('nonexistent', {
        id: 'tc-1',
        name: 'Read',
        input: {},
        status: 'running',
        isExpanded: false,
      });

      expect(addSubagentToolCall).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Lifecycle
  // ============================================

  describe('lifecycle', () => {
    it('resets spawned count', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-1', { run_in_background: false }, parentEl);
      expect(manager.subagentsSpawnedThisStream).toBe(1);

      manager.resetSpawnedCount();
      expect(manager.subagentsSpawnedThisStream).toBe(0);
    });

    it('resets streaming state clears sync maps and pending tasks', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-sync', { run_in_background: false }, parentEl);
      manager.handleTaskToolUse('task-pending', { prompt: 'test' }, null);

      expect(manager.getSyncSubagent('task-sync')).toBeDefined();
      expect(manager.hasPendingTask('task-pending')).toBe(true);

      manager.resetStreamingState();

      expect(manager.getSyncSubagent('task-sync')).toBeUndefined();
      expect(manager.hasPendingTask('task-pending')).toBe(false);
    });

    it('clears all state', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();

      manager.handleTaskToolUse('task-async', { description: 'Background', run_in_background: true }, parentEl);

      manager.clear();
      expect(manager.getAllActive()).toHaveLength(0);
      expect(manager.hasActiveAsync()).toBe(false);
    });

    it('updates callback via setCallback', () => {
      const { manager } = createManager();
      const parentEl = createMockEl();
      const newUpdates: SubagentInfo[] = [];

      manager.handleTaskToolUse('task-1', { description: 'Background', run_in_background: true }, parentEl);
      manager.setCallback((subagent) => { newUpdates.push({ ...subagent }); });

      manager.handleTaskToolResult('task-1', JSON.stringify({ agent_id: 'agent-new' }));

      expect(newUpdates.length).toBeGreaterThan(0);
      expect(newUpdates[newUpdates.length - 1].agentId).toBe('agent-new');
    });
  });
});
