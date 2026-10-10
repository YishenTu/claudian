import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { testDate } from '@test/helpers/testClock';

import { DeepSeekConversationHistoryService } from '@/providers/deepseek/history/DeepSeekConversationHistoryService';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

let peer: NativePeer;
let deepseek: DeepSeekHost;
let history: DeepSeekConversationHistoryService;
const time = testDate().getTime();
const state = { schemaVersion: 1, home: getDeepSeekHome(process.env), profile: 'web', preset: 'claudian-code' };
const input = { sessionId: 'root', providerState: state, messages: [] };
const wire = (seq: number, type: string, data: unknown, surfaceOp: unknown = 'append') => ({ type: 'event', event: { seq, type, time: time + seq, data, surfaceOp } });
let records: ReturnType<typeof wire>[];

beforeEach(async () => {
  records = [
    wire(1, 'turn/start', { turn: 1 }),
    wire(2, 'user/message', { id: 'u', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: 'read image' }, { type: 'image', attachment: { attachmentId: 'image' } }] }),
    wire(3, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'checking' }] } }),
    wire(4, 'tool/call', { callId: 'read', name: 'read', arguments: '{"path":"note.md"}' }),
    wire(5, 'tool/result', { message: { toolCallId: 'read', content: [{ type: 'text', text: 'note contents' }, { type: 'image', attachment: { attachmentId: 'tool-image' } }], isError: false } }),
    wire(6, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] }, usage: { outputTokens: 7 } }),
    wire(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    wire(8, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'summary replacement is model context' }] }, { op: 'replace', startSeq: 2, endSeq: 6 }),
  ];
  peer = new NativePeer();
  peer.onCall = (method, args) => {
    if (method === 'session/projections') return { asOfSeq: 8, values: { agentPreset: 'claudian-code', modelSelection: { lastUsed: { provider: 'native', model: 'old-model' }, next: { provider: 'native', model: 'new-model' } } } };
    if (method === 'session/page') {
      const visible = records.filter(row => row.event.seq <= args.request.throughSeq && (args.request.beforeSeq === undefined || row.event.seq < args.request.beforeSeq));
      return { records: visible.slice(-4), hasMore: visible.length > 4 };
    }
    if (method === 'session/attachment') return { attachment: { attachmentId: args.request.attachmentId, mediaType: 'image/png', name: 'pixel.png' }, data: 'aW1hZ2U=' };
    // The shared Host baselines its roster at startup; history itself stays on cold endpoints.
    if (method === 'session/list') return { items: [] };
    throw new Error(`Forbidden history endpoint ${method}`);
  };
  await peer.open();
  ({ deepseek } = peer.host());
  history = new DeepSeekConversationHistoryService(async () => deepseek);
});
afterEach(async () => { await deepseek.dispose(); await peer.close(); });

it('hydrates fixed-cut native messages, images, tools and exact completed-turn checkpoints', async () => {
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages).toHaveLength(2);
  expect(result.messages?.[0]).toMatchObject({ role: 'user', content: 'read image', userMessageId: 'u', images: [{ id: 'image', data: 'aW1hZ2U=', mediaType: 'image/png' }] });
  expect(result.messages?.[1]).toMatchObject({ role: 'assistant', content: 'checkingdone', assistantMessageId: 'deepseek:seq:7', contentBlocks: [{ type: 'thinking', content: 'thinking' }, { type: 'text', content: 'checking' }, { type: 'tool_use', toolId: 'read' }, { type: 'text', content: 'done' }], toolCalls: [{ name: 'Read', input: { file_path: 'note.md' }, result: 'note contents', resultImages: [{ kind: 'data', data: 'aW1hZ2U=', mediaType: 'image/png' }] }], turnStats: { outputTokens: 7 } });
  expect(peer.calls.filter(c => c.method === 'session/page').every(c => c.args.request.throughSeq === 8)).toBe(true);
  expect(peer.calls.find(c => c.method === 'session/attachment')?.args).toEqual({ request: { sessionId: 'root', attachmentId: 'image' } });
  expect(peer.calls.some(c => c.method === 'session/create' || c.method === 'session/follow')).toBe(false);
  expect(history.buildPersistedProviderState({ ...input, messages: result.messages! })).toEqual(state);
});

it('defers native forks to first execution and reads only the selected source prefix', async () => {
  const fork = history.buildForkProviderState('root', 'deepseek:seq:7', state);
  expect(fork).toMatchObject({ preset: 'claudian-code', pendingFork: { sessionId: 'root', atSeq: 7 } });
  const result = await history.hydrateConversationHistory({ ...input, sessionId: null, providerState: fork }, '/vault');
  expect(result.messages?.at(-1)?.assistantMessageId).toBe('deepseek:seq:7');
  expect(peer.calls.filter(c => c.method === 'session/page').every(c => c.args.request.throughSeq === 7)).toBe(true);
  expect(peer.calls.some(c => c.method === 'session/fork')).toBe(false);
});

it('recovers the native next model and distinguishes relocated stores from missing history', async () => {
  await expect(history.recoverConversationModelSelection(input, '/vault')).resolves.toBe('deepseek:native/new-model');
  await expect(history.getConversationSessionAvailability({ ...input, providerState: { ...state, home: '/another-machine/.dsh' } }, '/vault')).resolves.toBe('unknown');
  peer.onCall = () => null;
  await expect(history.getConversationSessionAvailability(input, '/vault')).resolves.toBe('missing');
  peer.onCall = () => { throw new Error('Native read failed'); };
  await expect(history.getConversationSessionAvailability(input, '/vault')).resolves.toBe('unknown');
});

it('hydrates a committed retry without replaying failed attempt prefixes', async () => {
  records.splice(2, 0, wire(2.5, 'assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'text-chunks', index: 0, texts: ['abandoned partial'] }] }));
  // Use valid journal sequence numbers while retaining the same model step.
  records.forEach((record, index) => { record.event.seq = index; });
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.[1].content).toBe('checkingdone');
});

it.each(['direct', 'subagent', 'subagent_fork'])('hydrates %s child tools through a native subagent address without activating the child', async mode => {
  records = [wire(0, 'turn/start', { turn: 0 }),
    wire(1, 'tool/call', { callId: 'spawn', name: 'subagent', arguments: '{"description":"Review"}' }),
    wire(2, 'subagent/catalog', { childId: 'child', mode: 'continuable', label: 'Review' }),
    wire(3, 'tool/result', { message: { toolCallId: 'spawn', content: [{ type: 'text', text: 'started subagent child' }] } }),
    wire(4, 'turn/end', { turn: 0, reason: { kind: 'completed' } })];
  if (mode !== 'direct') {
    records[1] = wire(1, 'tool/ptc-dispatch-start', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'spawn', name: mode, arguments: { description: 'Review' } });
    records[3] = wire(3, 'tool/ptc-dispatch', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'spawn', name: mode, arguments: { description: 'Review' }, content: [{ type: 'text', text: 'started subagent child' }] });
  }
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => {
    if (method === 'session/projections' && args.request.sessionId === 'child') return { asOfSeq: 5, values: {} };
    if (method === 'session/page' && args.request.address.childSessionId === 'child') return { hasMore: false, records: [
      wire(0, 'turn/start', { turn: 0 }), wire(1, 'tool/call', { callId: 'read', name: 'read', arguments: '{"path":"note.md"}' }),
      wire(2, 'tool/result', { message: { toolCallId: 'read', content: [{ type: 'text', text: 'note' }, { type: 'image', attachment: { attachmentId: 'child-image' } }] } }),
      wire(3, 'tool/call', { callId: 'edit', name: 'edit', arguments: '{"file_path":"note.md","old_string":"b","new_string":"B"}' }),
      wire(4, 'tool/result', { message: { toolCallId: 'edit', content: [{ type: 'text', text: 'updated' }] }, meta: { diffs: [{ path: 'note.md', oldText: 'a\nb', newText: 'a\nB' }] } }),
      wire(5, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ] };
    return ordinary(method, args);
  };
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.[0].toolCalls?.[0].subagent).toMatchObject({ id: 'spawn', agentId: 'child', status: 'completed', toolCalls: [{ id: 'read', result: 'note', resultImages: [{ kind: 'data', data: 'aW1hZ2U=', mediaType: 'image/png' }] },
    { id: 'edit', diffData: { filePath: 'note.md', stats: { added: 1, removed: 1 }, diffLines: [{ type: 'equal', text: 'a' }, { type: 'delete', text: 'b' }, { type: 'insert', text: 'B' }] } }] });
  expect(peer.calls.find(c => c.method === 'session/attachment')?.args).toEqual({ request: { sessionId: 'child', attachmentId: 'child-image' } });
  expect(peer.calls.some(c => c.method === 'session/follow' || c.method === 'session/create')).toBe(false);
});

it('restores file-change diffs from native applied hunks, or from the written content for a created file', async () => {
  records = [wire(0, 'turn/start', { turn: 0 }),
    wire(1, 'tool/call', { callId: 'edit', name: 'edit', arguments: '{"file_path":"note.md","old_string":"b","new_string":"B"}' }),
    wire(2, 'tool/result', { message: { toolCallId: 'edit', content: [{ type: 'text', text: 'updated' }] }, meta: { diffs: [{ path: 'note.md', oldText: 'a\nb\nc', newText: 'a\nB\nc' }] } }),
    wire(3, 'tool/call', { callId: 'write', name: 'write', arguments: '{"file_path":"new.md","content":"x\\ny"}' }),
    wire(4, 'tool/result', { message: { toolCallId: 'write', content: [{ type: 'text', text: 'Created file' }] }, meta: { operation: 'create', diffs: [] } }),
    wire(5, 'turn/end', { turn: 0, reason: { kind: 'completed' } })];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.[0].toolCalls).toMatchObject([
    { name: 'Edit', diffData: { filePath: 'note.md', stats: { added: 1, removed: 1 }, diffLines: [{ type: 'equal', text: 'a' }, { type: 'delete', text: 'b' }, { type: 'insert', text: 'B' }, { type: 'equal', text: 'c' }] } },
    { name: 'Write', diffData: { filePath: 'new.md', stats: { added: 2, removed: 0 }, diffLines: [{ type: 'insert', text: 'x' }, { type: 'insert', text: 'y' }] } },
  ]);
});

it.each([
  { attachment: { id: 'wrong-native-field' } },
  { attachment: {} },
  {},
])('rejects malformed native image references instead of silently omitting them: %j', block => {
  records = [wire(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'image', ...block }] })];
  return expect(history.hydrateConversationHistory(input, '/vault')).rejects.toThrow(/image.*reference/i);
});

it('rejects an attachment response for a different native identity', async () => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'session/attachment'
    ? { attachment: { attachmentId: 'other-image', mediaType: 'image/png' }, data: 'aW1hZ2U=' } : ordinary(method, args);
  await expect(history.hydrateConversationHistory(input, '/vault')).rejects.toThrow(/image attachment/i);
});


it.each(['tool-jobs', 'subagent-settled'])('hydrates native %s completion notices', async kind => {
  records = [wire(0, 'turn/start', { turn: 0 }),
    wire(1, 'user/message', { source: { kind }, content: [{ type: 'text', text: 'work finished' }] }),
    wire(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } })];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages).toMatchObject([{ role: 'assistant', isAutomaticResponse: true,
    contentBlocks: [{ type: 'task_notification', content: 'work finished' }] }]);
});


it('keeps notices with the requested reply when a native notice precedes user input in one turn', async () => {
  records = [wire(0, 'turn/start', { turn: 0 }),
    wire(1, 'user/message', { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'earlier job finished' }] }),
    wire(2, 'user/message', { id: 'user', source: { kind: 'user', rpcId: 'request' }, content: [{ type: 'text', text: 'new question' }] }),
    wire(3, 'assistant/message', { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'reply' }] } }),
    wire(4, 'turn/end', { turn: 0, reason: { kind: 'completed' } })];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.map(m => [m.role, m.content])).toEqual([['user', 'new question'], ['assistant', 'reply']]);
  expect(result.messages?.[1].isAutomaticResponse).toBeUndefined();
  expect(result.messages?.[1].contentBlocks).toEqual([{ type: 'task_notification', content: 'earlier job finished' }, { type: 'text', content: 'reply' }]);
  expect(result.messages?.[1].assistantMessageId).toBe('deepseek:seq:4');
});
