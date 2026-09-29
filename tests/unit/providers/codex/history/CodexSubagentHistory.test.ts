import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate } from '@test/helpers/testClock';

import type { ChatMessage } from '@/core/types';
import { hydrateCodexSubagentHistory } from '@/providers/codex/history/CodexSubagentHistory';

jest.mock('node:fs/promises', () => ({ __esModule: true, ...jest.requireActual('node:fs/promises') }));

it('shares directory and transcript reads within one child-history hydration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-children-'));
  await fs.mkdir(path.join(root, 'nested'));
  const completedAt = testDate().getTime();
  for (const id of ['child-a', 'child-b']) {
    await fs.writeFile(path.join(root, 'nested', `rollout-${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', timestamp: new Date(completedAt - 1000).toISOString(), payload: { id } }),
      JSON.stringify({ type: 'event_msg', timestamp: new Date(completedAt).toISOString(), payload: { type: 'task_complete', last_agent_message: id } }),
    ].join('\n'));
  }
  const messages = [{ id: 'parent', role: 'assistant', content: '', timestamp: completedAt, toolCalls:
    ['child-a', 'child-b', 'child-a'].map((agentId, index) => ({ id: String(index), name: 'Task', input: {}, status: 'completed',
      subagent: { isExpanded: false, id: String(index), agentId, description: agentId, status: 'completed', lifecycleSource: 'session', completedAt, toolCalls: [] } })) }] as ChatMessage[];
  const directories = jest.spyOn(fs, 'readdir');
  const reads = jest.spyOn(fs, 'readFile');
  try {
    await hydrateCodexSubagentHistory(messages, [root], Date.now() + 10_000);
    expect(messages[0].toolCalls!.map(tool => tool.subagent?.result)).toEqual(['child-a', 'child-b', 'child-a']);
    expect(directories).toHaveBeenCalledTimes(2);
    expect(reads).toHaveBeenCalledTimes(2);
  } finally {
    directories.mockRestore(); reads.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
