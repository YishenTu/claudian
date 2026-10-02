import type { SubagentInfo } from '@/core/types';
import { CodexSubagentTracker } from '@/providers/codex/execution/CodexSubagentTracker';
import type { SubAgentActivityItem, Thread } from '@/providers/codex/runtime/codexAppServerTypes';

const started: SubAgentActivityItem = { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/helper' };
const child = (text: string): Thread => ({
  id: 'child', agentNickname: 'Bohr', model: 'model', reasoningEffort: 'high',
  turns: [{ id: 'child-turn', status: 'completed', error: null, items: [
    { type: 'agentMessage', id: 'answer', phase: 'final_answer', text, memoryCitation: null },
  ] }],
} as Thread);

it('fences completion reads across a follow-up and deduplicates native completion', async () => {
  const updates: SubagentInfo[] = [];
  let resolveRead!: (thread: Thread) => void;
  const read = jest.fn(() => new Promise<Thread>(resolve => { resolveRead = resolve; }));
  const tracker = new CodexSubagentTracker(info => updates.push(info), read);
  tracker.activity(started, 'parent-1');
  tracker.activity({ ...started, id: 'complete', kind: 'completed' }, 'parent-1');
  const oldRead = resolveRead;
  tracker.activity({ ...started, id: 'followup', kind: 'interacted' }, 'parent-2');
  tracker.turnStarted('child', 'child-turn-2');
  oldRead(child('Old answer.'));
  await Promise.resolve();
  expect(updates.at(-1)).toMatchObject({ id: 'followup', status: 'running', result: undefined });
  const count = updates.length;
  tracker.activity({ ...started, id: 'complete', kind: 'completed' }, 'parent-1');
  tracker.turnCompleted('child', child('Old answer.').turns[0]);
  expect(updates).toHaveLength(count);
  expect(tracker.hasBackgroundWork()).toBe(true);
  tracker.turnCompleted('child', { ...child('New answer.').turns[0], id: 'child-turn-2' });
  expect(updates.at(-1)).toMatchObject({ status: 'completed', result: 'New answer.' });
  expect(tracker.hasBackgroundWork()).toBe(false);
});

it('fences a pending child read after the native process is released', async () => {
  const publish = jest.fn();
  let resolveRead!: (thread: Thread) => void;
  const tracker = new CodexSubagentTracker(publish, () => new Promise(resolve => { resolveRead = resolve; }));
  tracker.activity(started, 'parent');
  tracker.clear();
  resolveRead(child('Late answer.'));
  await Promise.resolve();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(tracker.hasBackgroundWork()).toBe(false);
});

it('restores agent identity on resume and assigns a separate card to new child turns', async () => {
  const publish = jest.fn();
  const tracker = new CodexSubagentTracker(publish, async () => child('Ready.'));
  tracker.seed({ ...child(''), id: 'parent', turns: [{ id: 'parent-turn', status: 'completed', error: null,
    items: [started, { ...started, id: 'complete', kind: 'completed' }],
  }] });
  tracker.activity({ ...started, id: 'followup', kind: 'interacted' }, 'parent-turn-2');
  await Promise.resolve();
  tracker.turnStarted('child', 'new-turn');
  await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'followup', agentId: 'child', status: 'running', description: 'Bohr (model, high)' }));
});

it('does not restart an idle child when native send_message reports interacted', async () => {
  const publish = jest.fn();
  const tracker = new CodexSubagentTracker(publish, async () => child('Ready.'));
  tracker.activity(started, 'first');
  tracker.turnStarted('child', 'child-turn');
  tracker.turnCompleted('child', child('Ready.').turns[0]);
  tracker.activity({ ...started, id: 'idle-message', kind: 'interacted' }, 'later');
  await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed', result: 'Ready.' }));
  expect(tracker.hasBackgroundWork()).toBe(false);
});

it('hydrates identity when native child turn start overtakes the initial read', async () => {
  const publish = jest.fn();
  const responses: Array<(thread: Thread) => void> = [];
  const tracker = new CodexSubagentTracker(publish, () => new Promise(resolve => responses.push(resolve)));
  tracker.activity(started, 'parent-turn');
  tracker.turnStarted('child', 'child-turn');
  tracker.handleNotification('child', 'child-turn', 'rawResponseItem/completed', { threadId: 'child', turnId: 'child-turn', item: {
    type: 'custom_tool_call', call_id: 'clock', name: 'exec', input: 'text(await tools.clock__curr_time({}));',
  } });
  for (const resolve of responses) resolve({ ...child(''), turns: [{ ...child('').turns[0], status: 'inProgress' }] });
  await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ description: 'Bohr (model, high)', status: 'running', toolCalls: [expect.objectContaining({ id: 'clock', status: 'running' })] }));
});

it('preserves a failed child outcome when the parent subsequently reports completed activity', async () => {
  const publish = jest.fn();
  const tracker = new CodexSubagentTracker(publish, async () => { throw new Error('Read unavailable'); });
  tracker.activity(started, 'parent-turn');
  tracker.turnStarted('child', 'child-turn');
  tracker.turnCompleted('child', { ...child('').turns[0], status: 'failed',
    error: { message: 'Child failed.', codexErrorInfo: 'other', additionalDetails: null },
  });
  tracker.activity({ ...started, id: 'completed', kind: 'completed' }, 'parent-turn');
  await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', result: 'Child failed.' }));
});

it('keeps native web sources on the single child search card', () => {
  const publish = jest.fn();
  const tracker = new CodexSubagentTracker(publish, () => new Promise(() => undefined));
  tracker.activity(started, 'parent-turn');
  tracker.turnStarted('child', 'child-turn');
  const notify = (method: string, item: Record<string, unknown>) => (
    tracker.handleNotification('child', 'child-turn', method, { threadId: 'child', turnId: 'child-turn', item })
  );
  notify('rawResponseItem/completed', { type: 'custom_tool_call', call_id: 'search', name: 'exec', input: 'text(await tools.web__run({search_query:[{q:"HBM supply"}]}));' });
  notify('item/started', { type: 'webSearch', id: 'native-search', query: '' });
  notify('item/completed', { type: 'webSearch', id: 'native-search', query: 'HBM supply', action: { type: 'search', query: 'HBM supply' },
    results: [{ type: 'text_result', title: 'Source', url: 'https://example.com/source', snippet: 'Snippet' }] });
  expect(publish.mock.lastCall[0].toolCalls).toEqual([expect.objectContaining({
    id: 'search', name: 'WebSearch', status: 'completed', input: expect.objectContaining({ query: 'HBM supply' }),
    webSearchResults: [{ title: 'Source', url: 'https://example.com/source', snippet: 'Snippet' }],
  })]);
});
