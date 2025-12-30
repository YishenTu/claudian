import type { SubagentInfo, ToolCallInfo } from '@/core/types';
import { AsyncSubagentManager } from '@/features/chat/services/AsyncSubagentManager';

const createManager = () => {
  const updates: SubagentInfo[] = [];
  const manager = new AsyncSubagentManager((subagent) => {
    updates.push({ ...subagent });
  });
  return { manager, updates };
};

describe('AsyncSubagentManager', () => {
  it('detects async task flag correctly', () => {
    const { manager } = createManager();
    expect(manager.isAsyncTask({ run_in_background: true })).toBe(true);
    expect(manager.isAsyncTask({ run_in_background: false })).toBe(false);
  });

  it('transitions from pending to running when agent_id is parsed', () => {
    const { manager, updates } = createManager();

    manager.createAsyncSubagent('task-1', { description: 'Background', run_in_background: true });
    expect(manager.getByTaskId('task-1')?.asyncStatus).toBe('pending');

    manager.handleTaskToolResult('task-1', JSON.stringify({ agent_id: 'agent-123' }));

    const running = manager.getByAgentId('agent-123');
    expect(running?.asyncStatus).toBe('running');
    expect(running?.agentId).toBe('agent-123');
    expect(updates[updates.length - 1].agentId).toBe('agent-123');
    expect(manager.isPendingAsyncTask('task-1')).toBe(false);
  });

  it('moves to error when Task tool_result parsing fails', () => {
    const { manager, updates } = createManager();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    manager.createAsyncSubagent('task-parse-fail', { description: 'No id', run_in_background: true });
    manager.handleTaskToolResult('task-parse-fail', 'no agent id present');

    expect(manager.getByTaskId('task-parse-fail')).toBeUndefined();
    const last = updates[updates.length - 1];
    expect(last.asyncStatus).toBe('error');
    expect(last.result).toContain('Failed to parse agent_id');
    warnSpy.mockRestore();
  });

  it('moves to error when Task tool_result itself is an error', () => {
    const { manager, updates } = createManager();

    manager.createAsyncSubagent('task-error', { description: 'Will fail', run_in_background: true });
    manager.handleTaskToolResult('task-error', 'launch failed', true);

    expect(manager.getByTaskId('task-error')).toBeUndefined();
    const last = updates[updates.length - 1];
    expect(last.asyncStatus).toBe('error');
    expect(last.result).toBe('launch failed');
  });

  it('stays running when AgentOutputTool reports not_ready', () => {
    const { manager } = createManager();

    manager.createAsyncSubagent('task-running', { description: 'Background', run_in_background: true });
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

    manager.createAsyncSubagent('task-standalone', { description: 'Background', run_in_background: true });
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

    manager.createAsyncSubagent('task-complete', { description: 'Background', run_in_background: true });
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

  it('marks pending and running async subagents as orphaned', () => {
    const { manager } = createManager();

    manager.createAsyncSubagent('pending-task', { description: 'Pending task', run_in_background: true });
    manager.createAsyncSubagent('running-task', { description: 'Running task', run_in_background: true });
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

    // Should not throw when handling result for unknown task
    manager.handleTaskToolResult('missing-task', 'agent_id: x');

    // Task should not be tracked
    expect(manager.getByTaskId('missing-task')).toBeUndefined();
  });

  it('ignores AgentOutputTool when missing agentId', () => {
    const { manager } = createManager();

    // Should not throw when agentId is missing
    manager.handleAgentOutputToolUse({
      id: 'output-1',
      name: 'AgentOutputTool',
      input: {},
      status: 'running',
      isExpanded: false,
    });

    // Tool should not be linked
    expect(manager.isLinkedAgentOutputTool('output-1')).toBe(false);
  });

  it('ignores AgentOutputTool when referencing unknown agent', () => {
    const { manager } = createManager();

    // Should not throw when agent is unknown
    manager.handleAgentOutputToolUse({
      id: 'output-unknown',
      name: 'AgentOutputTool',
      input: { agent_id: 'agent-x' },
      status: 'running',
      isExpanded: false,
    });

    // Tool should not be linked since agent doesn't exist
    expect(manager.isLinkedAgentOutputTool('output-unknown')).toBe(false);
  });

  it('returns undefined on invalid AgentOutputTool state transition', () => {
    const { manager } = createManager();
    manager.createAsyncSubagent('task-done', { description: 'Background', run_in_background: true });
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
    manager.createAsyncSubagent('task-plain', { description: 'Background', run_in_background: true });
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

  it('extracts first agent result when agentId is missing', () => {
    const { manager } = createManager();
    manager.createAsyncSubagent('task-first', { description: 'Background', run_in_background: true });
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
    manager.createAsyncSubagent('task-infer', { description: 'Background', run_in_background: true });
    manager.handleTaskToolResult('task-infer', JSON.stringify({ agent_id: 'agent-infer' }));

    const result = JSON.stringify({
      retrieval_status: 'success',
      agents: { 'agent-infer': { status: 'completed', result: 'ok' } },
    });

    const completed = manager.handleAgentOutputToolResult('unlinked', result, false);
    expect(completed?.asyncStatus).toBe('completed');
    expect(completed?.result).toBe('ok');
  });

  it('handles JSON envelope forms in still-running detection', () => {
    const { manager } = createManager();

    const arrayEnvelope = JSON.stringify([
      { text: JSON.stringify({ retrieval_status: 'not_ready', agents: {} }) },
    ]);
    expect((manager as any).isStillRunningResult(arrayEnvelope, false)).toBe(true);

    const objectEnvelope = JSON.stringify({
      text: JSON.stringify({ retrieval_status: 'running', agents: {} }),
    });
    expect((manager as any).isStillRunningResult(objectEnvelope, false)).toBe(true);

    expect((manager as any).isStillRunningResult('   ', false)).toBe(false);
    expect((manager as any).isStillRunningResult('whatever', true)).toBe(false);
    expect((manager as any).isStillRunningResult(JSON.stringify({ retrieval_status: 'success' }), false)).toBe(false);
    expect((manager as any).isStillRunningResult(JSON.stringify({ retrieval_status: 'unknown' }), false)).toBe(false);
    expect((manager as any).isStillRunningResult('plain output', false)).toBe(false);
  });

  it('unwraps envelopes in extractAgentResult', () => {
    const { manager } = createManager();

    const payloadArray = JSON.stringify([
      { text: JSON.stringify({ agents: { a: { result: 'R' } } }) },
    ]);
    expect((manager as any).extractAgentResult(payloadArray, 'a')).toBe('R');

    const payloadObject = JSON.stringify({
      text: JSON.stringify({ agents: { a: { status: 'completed' } } }),
    });
    expect((manager as any).extractAgentResult(payloadObject, 'a')).toContain('completed');

    const fallback = JSON.stringify({ agents: { first: { status: 'completed' } } });
    expect((manager as any).extractAgentResult(fallback, 'missing')).toContain('completed');

    const noAgents = JSON.stringify({ foo: 'bar' });
    expect((manager as any).extractAgentResult(noAgents, 'x')).toBe(noAgents);
  });

  it('gets running subagent by task id after transition', () => {
    const { manager } = createManager();
    manager.createAsyncSubagent('task-map', { description: 'Background', run_in_background: true });
    manager.handleTaskToolResult('task-map', JSON.stringify({ agent_id: 'agent-map' }));

    expect(manager.getByTaskId('task-map')?.agentId).toBe('agent-map');
  });

  it('parses agent id from multiple JSON shapes', () => {
    const { manager } = createManager();
    expect((manager as any).parseAgentId(JSON.stringify({ agentId: 'camel' }))).toBe('camel');
    expect((manager as any).parseAgentId(JSON.stringify({ data: { agent_id: 'nested' } }))).toBe('nested');
    expect((manager as any).parseAgentId(JSON.stringify({ id: 'idfield' }))).toBe('idfield');

    // Use escaped keys to bypass regex and exercise JSON parse path
    expect((manager as any).parseAgentId('{"agent\\u005fid":"escaped"}')).toBe('escaped');
    expect((manager as any).parseAgentId('{"data": {"agent\\u005fid": "nested2"}}')).toBe('nested2');

    // Returns null when no agent_id found
    expect((manager as any).parseAgentId('{"foo": "bar"}')).toBeNull();
  });

  it('clears all state', () => {
    const { manager } = createManager();
    manager.createAsyncSubagent('task-clear', { description: 'Background', run_in_background: true });
    manager.clear();
    expect(manager.getAllActive()).toHaveLength(0);
  });
});
