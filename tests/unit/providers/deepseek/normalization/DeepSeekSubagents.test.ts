import { testDate } from '@test/helpers/testClock';

import type { SubagentInfo } from '@/core/types';
import { DeepSeekSubagents } from '@/providers/deepseek/normalization/DeepSeekSubagents';

const time = testDate().getTime();

it.each(['direct', 'subagent', 'subagent_fork'])('joins %s child output to its parent call after child events arrive before the launch result', mode => {
  const updates: SubagentInfo[] = [];
  const tracker = new DeepSeekSubagents(info => updates.push(info));
  tracker.parent({ type: mode === 'direct' ? 'tool/call' : 'tool/ptc-dispatch-start', seq: 1, time, data: { callId: 'spawn', subCallId: 'spawn', rootCallId: 'outer', name: mode === 'direct' ? 'subagent' : mode, arguments: { description: 'Review', prompt: 'check changes' } } });
  tracker.child('child', { type: 'snapshot', cursor: 3, records: [
    { event: { type: 'turn/start', seq: 0, time, data: { turn: 1 } } },
    { event: { type: 'tool/call', seq: 1, time, data: { callId: 'read', name: 'read', arguments: '{"path":"note.md"}' } } },
    { event: { type: 'tool/result', seq: 2, time, data: { message: { toolCallId: 'read', content: [{ type: 'text', text: 'note' }] } } } },
    { event: { type: 'assistant/message', seq: 3, time, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Found one issue' }] } } } },
  ] });
  const content = [{ type: 'text', text: 'started subagent child' }];
  tracker.parent({ type: mode === 'direct' ? 'tool/result' : 'tool/ptc-dispatch', seq: 2, time, data: mode === 'direct' ? { message: { toolCallId: 'spawn', content } } : { subCallId: 'spawn', rootCallId: 'outer', name: mode, content } });
  tracker.child('child', { type: 'event', event: { type: 'turn/end', seq: 4, time, data: { turn: 1, reason: { kind: 'completed' } } } });
  expect(updates.at(-1)).toMatchObject({ id: 'spawn', agentId: 'child', lifecycleSource: 'session', status: 'completed', result: 'Found one issue', toolCalls: [{ id: 'read', name: 'Read', status: 'completed', result: 'note' }] });
  tracker.child('child', { type: 'event', event: { type: 'assistant/message', seq: 3, time, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Found one issue' }] } } } });
  expect(updates.at(-1)?.result).toBe('Found one issue');
});
