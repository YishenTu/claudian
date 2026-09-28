import { TOOL_SPAWN_AGENT, TOOL_WAIT, TOOL_WAIT_AGENT } from '@/core/tools/toolNames';
import type { ToolCallInfo } from '@/core/types';
import {
  buildCodexSubagentInfo,
  codexSubagentLifecycleAdapter,
  extractCodexSpawnResult,
  extractCodexWaitResult,
} from '@/providers/codex/normalization/codexSubagentNormalization';

describe('codexSubagentNormalization', () => {
  it.each([
    ['completed', 'Reviewed successfully.', 'completed', 'Reviewed successfully.'],
    ['completed', '', 'completed', 'DONE'],
    ['errored', 'Could not start.', 'error', 'Could not start.'],
    ['shutdown', null, 'error', 'Agent shut down'],
    ['notFound', null, 'error', 'Agent not found'],
    ['pendingInit', null, 'running', undefined],
  ])('normalizes native %s agent states', (status, message, expectedStatus, result) => {
    const spawn: ToolCallInfo = {
      id: 'spawn', name: TOOL_SPAWN_AGENT, input: { message: 'Review', agent_type: 'explorer' },
      status: 'completed', result: '{"agent_id":"agent"}',
    };
    const wait: ToolCallInfo = {
      id: 'wait', name: TOOL_WAIT, input: { ids: ['agent'] }, status: 'completed',
      result: JSON.stringify({ status: { agent: { status, message } } }),
    };
    expect(buildCodexSubagentInfo(spawn, [spawn, wait])).toMatchObject({
      description: 'explorer', status: expectedStatus, result,
    });
  });

  it.each(['list_agents', 'followup_task', 'send_input', 'send_message', 'resume_agent'])(
    'preserves completed output through cleanup until %s reports a new running cycle', name => {
    const spawn: ToolCallInfo = {
      id: 'spawn', name: TOOL_SPAWN_AGENT, input: {}, status: 'completed', result: '{"agent_id":"agent"}',
    };
    const wait: ToolCallInfo = {
      id: 'wait', name: TOOL_WAIT, input: { ids: ['agent'] }, status: 'completed',
      result: '{"status":{"agent":{"completed":"Review complete."}}}',
    };
    const close: ToolCallInfo = {
      id: 'close', name: 'close_agent', input: { id: 'agent' }, status: 'completed',
      result: '{"previous_status":{"completed":"Review complete."}}',
    };
    const failed: ToolCallInfo = {
      id: 'failed', name: 'interrupt_agent', input: { target: 'agent' }, status: 'error', result: 'Not authorized',
    };
    expect(buildCodexSubagentInfo(spawn, [spawn, wait, close, failed])).toMatchObject({
      status: 'completed', result: 'Review complete.',
    });
    expect(codexSubagentLifecycleAdapter.resolveSpawnToolIds(close, new Map([['agent', 'spawn']]))).toEqual(['spawn']);
    for (const status of ['shutdown', 'notFound']) {
      const list: ToolCallInfo = {
        id: 'list', name: 'list_agents', input: {}, status: 'completed',
        result: JSON.stringify({ status: { agent: { status, message: null } } }),
      };
      expect(buildCodexSubagentInfo(spawn, [spawn, wait, close, list])).toMatchObject({
        status: 'completed', result: 'Review complete.',
      });
      const running = { ...list, id: 'running', name, result: '{"status":{"agent":{"status":"running","message":"Checking follow-up."}}}' };
      expect(buildCodexSubagentInfo(spawn, [spawn, wait, close, running, list])).toMatchObject({ status: 'error' });
    }
  });

  it('extracts agent id and nickname from spawn result', () => {
    expect(
      extractCodexSpawnResult('{"agent_id":"agent-1","nickname":"Zeno"}')
    ).toEqual({
      agentId: 'agent-1',
      nickname: 'Zeno',
    });
  });

  it('uses the targeted raw resume status to begin another cycle', () => {
    const spawn: ToolCallInfo = {
      id: 'spawn', name: TOOL_SPAWN_AGENT, input: {}, status: 'completed', result: '{"agent_id":"agent"}',
    };
    const wait: ToolCallInfo = {
      id: 'wait', name: TOOL_WAIT, input: { ids: ['agent'] }, status: 'completed',
      result: '{"status":{"agent":{"completed":"First answer"}}}',
    };
    const resume: ToolCallInfo = {
      id: 'resume', name: 'resume_agent', input: { agent_id: 'agent' }, status: 'completed', result: '{"status":"resumed"}',
    };
    expect(buildCodexSubagentInfo(spawn, [spawn, wait, resume])).toMatchObject({ status: 'running', result: undefined });
    expect(buildCodexSubagentInfo(spawn, [spawn, wait, { ...resume, input: { agent_id: 'other' } }]))
      .toMatchObject({ status: 'completed', result: 'First answer' });
  });

  it('extracts wait statuses and timeout flag', () => {
    expect(
      extractCodexWaitResult(
        '{"status":{"agent-1":{"completed":"done"}},"timed_out":false}'
      )
    ).toEqual({
      statuses: {
        'agent-1': { completed: 'done' },
      },
      timedOut: false,
    });
  });

  it('builds completed subagent info from spawn and wait tools', () => {
    const spawnTool: ToolCallInfo = {
      id: 'spawn-1',
      name: TOOL_SPAWN_AGENT,
      input: {
        message: 'Inspect the code and patch the bug.',
        model: 'gpt-5.4-mini',
      },
      status: 'completed',
      result: '{"agent_id":"agent-1","nickname":"Zeno"}',
    };
    const waitTool: ToolCallInfo = {
      id: 'wait-1',
      name: TOOL_WAIT_AGENT,
      input: { targets: ['agent-1'], timeout_ms: 30_000 },
      status: 'completed',
      result: '{"status":{"agent-1":{"completed":"Patched the bug and ran the tests."}},"timed_out":false}',
    };

    expect(buildCodexSubagentInfo(spawnTool, [spawnTool, waitTool])).toEqual(
      expect.objectContaining({
        id: 'spawn-1',
        description: 'Zeno (gpt-5.4-mini)',
        prompt: 'Inspect the code and patch the bug.',
        status: 'completed',
        result: 'Patched the bug and ran the tests.',
        agentId: 'agent-1',
      })
    );
  });

  it('keeps the subagent running after spawn completes but before wait resolves', () => {
    const spawnTool: ToolCallInfo = {
      id: 'spawn-1',
      name: TOOL_SPAWN_AGENT,
      input: { message: 'Do work', model: 'gpt-5.4-mini' },
      status: 'completed',
      result: '{"agent_id":"agent-1","nickname":"Zeno"}',
    };

    expect(buildCodexSubagentInfo(spawnTool, [spawnTool])).toEqual(
      expect.objectContaining({
        description: 'Zeno (gpt-5.4-mini)',
        prompt: 'Do work',
        status: 'running',
        result: undefined,
      })
    );
  });

  it('uses current task-name and list-agents results to resolve completion', () => {
    const spawnTool: ToolCallInfo = {
      id: 'spawn-current',
      name: TOOL_SPAWN_AGENT,
      input: {
        message: 'Review the provider integration.',
        task_name: 'provider_review',
      },
      status: 'completed',
      result: '{"task_name":"provider_review"}',
    };
    const timedOutWait: ToolCallInfo = {
      id: 'wait-current',
      name: TOOL_WAIT_AGENT,
      input: { timeout_ms: 10_000 },
      status: 'completed',
      result: '{"message":"No agent completed before the timeout.","timed_out":true}',
    };
    const listAgents: ToolCallInfo = {
      id: 'list-current',
      name: 'list_agents',
      input: {},
      status: 'completed',
      result: JSON.stringify({
        agents: [{
          agent_name: 'provider_review',
          agent_status: { completed: 'Provider integration is sound.' },
        }],
      }),
    };

    expect(extractCodexSpawnResult(spawnTool.result, spawnTool)).toEqual({
      agentId: 'provider_review',
    });
    expect(buildCodexSubagentInfo(
      spawnTool,
      [spawnTool, timedOutWait, listAgents],
    )).toEqual(expect.objectContaining({
      agentId: 'provider_review',
      result: 'Provider integration is sound.',
      status: 'completed',
    }));
  });

  it('treats a current global wait timeout as polling, not agent failure', () => {
    const spawnTool: ToolCallInfo = {
      id: 'spawn-current',
      name: TOOL_SPAWN_AGENT,
      input: { message: 'Keep working.', task_name: 'background_work' },
      status: 'completed',
      result: '{"task_name":"background_work"}',
    };
    const waitTool: ToolCallInfo = {
      id: 'wait-current',
      name: TOOL_WAIT_AGENT,
      input: { timeout_ms: 10_000 },
      status: 'completed',
      result: '{"message":"Agents are still running.","timed_out":true}',
    };

    expect(buildCodexSubagentInfo(spawnTool, [spawnTool, waitTool])).toEqual(
      expect.objectContaining({ status: 'running', result: undefined }),
    );

    const agentIdToSpawnId = new Map([['background_work', 'spawn-current']]);
    expect(codexSubagentLifecycleAdapter.isWaitTool('list_agents')).toBe(true);
    expect(codexSubagentLifecycleAdapter.isHiddenTool('list_agents')).toBe(false);
    expect(codexSubagentLifecycleAdapter.resolveSpawnToolIds(
      waitTool,
      agentIdToSpawnId,
    )).toEqual(['spawn-current']);
    expect(codexSubagentLifecycleAdapter.isToolCallFullyOwned(
      waitTool,
      agentIdToSpawnId,
    )).toBe(true);

    const executionCellWait: ToolCallInfo = {
      id: 'wait-execution-cell',
      name: TOOL_WAIT,
      input: { cell_id: 'cell-1', yield_time_ms: 10_000 },
      status: 'completed',
      result: 'Cell completed.',
    };
    expect(codexSubagentLifecycleAdapter.resolveSpawnToolIds(
      executionCellWait,
      agentIdToSpawnId,
    )).toEqual([]);
    expect(codexSubagentLifecycleAdapter.isToolCallFullyOwned(
      executionCellWait,
      agentIdToSpawnId,
    )).toBe(false);
  });
});
