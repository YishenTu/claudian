import type { ToolCallInfo } from '@/core/types';
import {
  buildGrokSubagentInfo,
  extractGrokSpawnResult,
  extractGrokWaitResult,
  grokSubagentLifecycleAdapter,
} from '@/providers/grok/normalization/grokSubagentNormalization';

function toolCall(overrides: Partial<ToolCallInfo>): ToolCallInfo {
  return {
    id: 'tool-1',
    input: {},
    isExpanded: false,
    name: 'tool',
    status: 'running',
    ...overrides,
  };
}

describe('grokSubagentNormalization', () => {
  it.each([
    ['spawn_subagent', 'spawn'],
    ['task', 'spawn'],
    ['get_command_or_subagent_output', 'wait'],
    ['task_output', 'wait'],
    ['wait_for_task', 'wait'],
    ['wait_commands_or_subagents', 'wait'],
    ['kill_command_or_subagent', 'close'],
    ['kill_task', 'close'],
  ])('owns %s as a %s lifecycle tool', (name, family) => {
    expect(grokSubagentLifecycleAdapter.isSpawnTool(name)).toBe(family === 'spawn');
    expect(grokSubagentLifecycleAdapter.isWaitTool(name)).toBe(family === 'wait');
    expect(grokSubagentLifecycleAdapter.isCloseTool(name)).toBe(family === 'close');
    expect(grokSubagentLifecycleAdapter.isHiddenTool(name)).toBe(family !== 'spawn');
  });

  it('builds a completed foreground subagent from the terminal raw payload', () => {
    const spawn = toolCall({
      id: 'spawn-1',
      name: 'spawn_subagent',
      input: {
        description: 'Inspect renderer mappings',
        prompt: 'Check every Grok tool.',
        run_in_background: false,
        subagent_type: 'general-purpose',
        task_id: 'task-1',
      },
      providerPayload: {
        rawName: 'spawn_subagent',
        rawOutput: { text: 'All renderer mappings are covered.', type: 'text' },
      },
      result: '{"text":"All renderer mappings are covered.","type":"text"}',
      status: 'completed',
    });

    expect(extractGrokSpawnResult(spawn.result, spawn)).toEqual({ agentId: 'task-1' });
    expect(buildGrokSubagentInfo(spawn)).toEqual(expect.objectContaining({
      agentId: 'task-1',
      description: 'Inspect renderer mappings',
      mode: 'sync',
      prompt: 'Check every Grok tool.',
      result: 'All renderer mappings are covered.',
      status: 'completed',
    }));
  });

  it('keeps a background spawn running until its output tool completes', () => {
    const spawn = toolCall({
      id: 'spawn-1',
      name: 'spawn_subagent',
      input: {
        background: true,
        description: 'Run focused tests',
        prompt: 'Run the Grok tests.',
        task_id: 'task-7',
      },
      status: 'completed',
      result: 'Spawned background task task-7',
    });

    expect(buildGrokSubagentInfo(spawn)).toEqual(expect.objectContaining({
      agentId: 'task-7',
      asyncStatus: 'running',
      mode: 'async',
      status: 'running',
    }));

    const output = toolCall({
      id: 'output-1',
      name: 'get_command_or_subagent_output',
      input: { task_ids: ['task-7'] },
      providerPayload: {
        rawName: 'get_command_or_subagent_output',
        rawOutput: {
          Result: [{ output: 'Focused tests passed.', status: 'completed', task_id: 'task-7' }],
          type: 'task_output',
        },
      },
      result: 'Focused tests passed.',
      status: 'completed',
    });

    expect(extractGrokWaitResult(output.result, output)).toEqual({
      statuses: { 'task-7': { completed: 'Focused tests passed.' } },
      timedOut: false,
    });
    expect(buildGrokSubagentInfo(spawn, [spawn, output])).toEqual(expect.objectContaining({
      asyncStatus: 'completed',
      result: 'Focused tests passed.',
      status: 'completed',
    }));
  });

  it('links wait and kill calls to spawn calls by task id', () => {
    const taskIds = new Map([
      ['task-1', 'spawn-1'],
      ['task-2', 'spawn-2'],
    ]);

    expect(grokSubagentLifecycleAdapter.resolveSpawnToolIds(
      toolCall({
        name: 'get_command_or_subagent_output',
        input: { task_ids: ['task-1', 'task-2'] },
      }),
      taskIds,
    )).toEqual(['spawn-1', 'spawn-2']);
    expect(grokSubagentLifecycleAdapter.resolveSpawnToolIds(
      toolCall({ name: 'kill_command_or_subagent', input: { task_id: 'task-2' } }),
      taskIds,
    )).toEqual(['spawn-2']);
  });

  it('marks a killed background subagent as an error with the provider result', () => {
    const spawn = toolCall({
      id: 'spawn-1',
      name: 'task',
      input: { description: 'Long task', run_in_background: true, task_id: 'task-9' },
      result: 'Started task-9',
      status: 'completed',
    });
    const kill = toolCall({
      id: 'kill-1',
      name: 'kill_task',
      input: { task_id: 'task-9' },
      providerPayload: {
        rawName: 'kill_task',
        rawOutput: { Result: 'Task task-9 cancelled', type: 'kill_result' },
      },
      result: 'Task task-9 cancelled',
      status: 'completed',
    });

    expect(buildGrokSubagentInfo(spawn, [spawn, kill])).toEqual(expect.objectContaining({
      asyncStatus: 'error',
      result: 'Task task-9 cancelled',
      status: 'error',
    }));
  });

  it('does not complete a background task when output polling times out', () => {
    const spawn = toolCall({
      id: 'spawn-1',
      name: 'spawn_subagent',
      input: { run_in_background: true, task_id: 'task-3' },
      result: 'Started task-3',
      status: 'completed',
    });
    const wait = toolCall({
      id: 'wait-1',
      name: 'wait_for_task',
      input: { task_ids: ['task-3'] },
      providerPayload: {
        rawName: 'wait_for_task',
        rawOutput: { Result: { status: 'running', task_id: 'task-3' }, type: 'task_output' },
      },
      result: 'Task is still running',
      status: 'completed',
    });

    expect(buildGrokSubagentInfo(spawn, [spawn, wait])).toEqual(expect.objectContaining({
      asyncStatus: 'running',
      status: 'running',
    }));
  });
});
