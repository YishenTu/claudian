import { TOOL_SPAWN_AGENT, TOOL_WAIT_AGENT } from '@/core/tools/toolNames';
import type { ToolCallInfo } from '@/core/types';
import {
  buildCodexSubagentInfo,
  extractCodexSpawnResult,
  extractCodexWaitResult,
} from '@/providers/codex/normalization/codexSubagentNormalization';

describe('codexSubagentNormalization', () => {
  it('extracts agent id and nickname from spawn result', () => {
    expect(
      extractCodexSpawnResult('{"agent_id":"agent-1","nickname":"Zeno"}')
    ).toEqual({
      agentId: 'agent-1',
      nickname: 'Zeno',
    });
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
});
