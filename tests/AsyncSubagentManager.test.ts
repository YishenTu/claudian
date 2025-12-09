import { AsyncSubagentManager } from '../src/AsyncSubagentManager';
import { SubagentInfo, ToolCallInfo } from '../src/types';

const createManager = () => {
  const updates: SubagentInfo[] = [];
  const manager = new AsyncSubagentManager((subagent) => {
    updates.push({ ...subagent });
  });
  return { manager, updates };
};

describe('AsyncSubagentManager', () => {
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

    manager.createAsyncSubagent('task-parse-fail', { description: 'No id', run_in_background: true });
    manager.handleTaskToolResult('task-parse-fail', 'no agent id present');

    expect(manager.getByTaskId('task-parse-fail')).toBeUndefined();
    const last = updates[updates.length - 1];
    expect(last.asyncStatus).toBe('error');
    expect(last.result).toContain('Failed to parse agent_id');
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

    const stillRunning = manager.handleAgentOutputToolResult(
      'output-1',
      JSON.stringify({ retrieval_status: 'not_ready', agents: {} }),
      false
    );

    expect(stillRunning).toBeUndefined();
    expect(manager.getByAgentId('agent-abc')?.asyncStatus).toBe('running');
    expect(manager.hasActiveAsync()).toBe(true);
  });

  it('transitions to awaiting_result after SubagentStop hook', () => {
    const { manager, updates } = createManager();

    manager.createAsyncSubagent('task-await', { description: 'Background', run_in_background: true });
    manager.handleTaskToolResult('task-await', JSON.stringify({ agent_id: 'agent-await' }));

    manager.handleSubagentStopHook('agent-await');

    const last = updates[updates.length - 1];
    expect(last.asyncStatus).toBe('awaiting_result');
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
});
