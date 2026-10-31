import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { nativeRequest } from '@test/helpers/deepseek/NativeRequest';
import { testDate } from '@test/helpers/testClock';

import { extractUserDisplayContent } from '@/core/prompt/promptContext';
import { encodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import { DeepSeekConversationHistoryService } from '@/providers/deepseek/history/DeepSeekConversationHistoryService';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHome';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';

let peer: NativePeer;
let deepseek: DeepSeekHost;
let history: DeepSeekConversationHistoryService;
const time = testDate().getTime();
const state = { schemaVersion: 1, home: getDeepSeekHome(process.env, process.cwd()), profile: 'web', preset: 'claudian-code' };
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
      const { throughSeq, beforeSeq } = nativeRequest(args);
      const visible = records.filter(row => row.event.seq <= throughSeq! && (beforeSeq === undefined || row.event.seq < beforeSeq));
      return { records: visible.slice(-4), hasMore: visible.length > 4 };
    }
    if (method === 'session/attachment') return { attachment: { attachmentId: nativeRequest(args).attachmentId, mediaType: 'image/png', name: 'pixel.png' }, data: 'aW1hZ2U=' };
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
  expect(peer.calls.filter(c => c.method === 'session/page').every(c => nativeRequest(c.args).throughSeq === 8)).toBe(true);
  expect(peer.calls.find(c => c.method === 'session/attachment')?.args).toEqual({ request: { sessionId: 'root', attachmentId: 'image' } });
  expect(peer.calls.some(c => c.method === 'session/create' || c.method === 'session/follow')).toBe(false);
  expect(history.buildPersistedProviderState({ ...input, messages: result.messages! })).toEqual(state);
});

it('hydrates a prototype-named custom tool with its original input, payload and result', async () => {
  records = [
    wire(1, 'turn/start', { turn: 1 }),
    wire(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'run custom tool' }] }),
    wire(3, 'tool/call', { callId: 'custom', name: 'constructor', arguments: '{"path":"note.md"}' }),
    wire(4, 'tool/result', { message: { toolCallId: 'custom', content: [{ type: 'text', text: 'custom result' }], isError: false } }),
    wire(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.[1]).toMatchObject({ role: 'assistant', toolCalls: [
    { id: 'custom', name: 'constructor', input: { path: 'note.md' }, providerPayload: { rawName: 'constructor' }, result: 'custom result', status: 'completed' },
  ] });
});

it('defers native forks to first execution and reads only the selected source prefix', async () => {
  const fork = history.buildForkProviderState('root', 'deepseek:seq:7', state);
  expect(fork).toMatchObject({ preset: 'claudian-code', pendingFork: { sessionId: 'root', atSeq: 7 } });
  const result = await history.hydrateConversationHistory({ ...input, sessionId: null, providerState: fork }, '/vault');
  expect(result.messages?.at(-1)?.assistantMessageId).toBe('deepseek:seq:7');
  expect(peer.calls.filter(c => c.method === 'session/page').every(c => nativeRequest(c.args).throughSeq === 7)).toBe(true);
  expect(peer.calls.some(c => c.method === 'session/fork')).toBe(false);
  const pendingFork = { ...input, sessionId: null, providerState: fork };
  expect(history.isPendingForkConversation(pendingFork)).toBe(true);
  expect(history.isPendingForkConversation(input)).toBe(false);
  expect(history.hasConversationModelRecoverySource(pendingFork)).toBe(true);
  expect(history.hasConversationModelRecoverySource({ ...input, sessionId: null })).toBe(false);
  const beyondSource = history.buildForkProviderState('root', 'deepseek:seq:9', state);
  await expect(history.hydrateConversationHistory({ ...input, sessionId: null, providerState: beyondSource }, '/vault'))
    .rejects.toThrow(/checkpoint is not present/i);
});

it('recovers the native next model and distinguishes relocated stores from missing history', async () => {
  await expect(history.recoverConversationModelSelection(input, '/vault')).resolves.toBe('deepseek:native/new-model');
  await expect(history.getConversationSessionAvailability(input, '/vault')).resolves.toBe('available');
  await expect(history.getConversationSessionAvailability({ ...input, providerState: { ...state, home: '/another-machine/.dsh' } }, '/vault')).resolves.toBe('unknown');
  peer.onCall = () => null;
  await expect(history.getConversationSessionAvailability(input, '/vault')).resolves.toBe('missing');
  peer.onCall = () => { throw new Error('Native read failed'); };
  await expect(history.getConversationSessionAvailability(input, '/vault')).resolves.toBe('unknown');
  await expect(history.recoverConversationModelSelection(input, '/vault')).resolves.toBeNull();
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
    if (method === 'session/projections' && nativeRequest(args).sessionId === 'child') return { asOfSeq: 7, values: {} };
    if (method === 'session/page' && nativeRequest(args).address!.childSessionId === 'child') return { hasMore: false, records: [
      wire(0, 'turn/start', { turn: 0 }), wire(1, 'tool/call', { callId: 'read', name: 'read', arguments: '{"path":"note.md"}' }),
      wire(2, 'tool/result', { message: { toolCallId: 'read', content: [{ type: 'text', text: 'note' }, { type: 'image', attachment: { attachmentId: 'child-image' } }] } }),
      wire(3, 'tool/call', { callId: 'edit', name: 'edit', arguments: '{"file_path":"note.md","old_string":"b","new_string":"B"}' }),
      wire(4, 'tool/result', { message: { toolCallId: 'edit', content: [{ type: 'text', text: 'updated' }] }, meta: { diffs: [{ path: 'note.md', oldText: 'a\nb', newText: 'a\nB' }] } }),
      wire(5, 'tool/call', { callId: 'failed', name: 'edit', arguments: '{"file_path":"note.md","old_string":"x","new_string":"X"}' }),
      wire(6, 'tool/result', { message: { toolCallId: 'failed', content: [{ type: 'text', text: 'old_string not found' }], isError: true } }),
      wire(7, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ] };
    return ordinary(method, args);
  };
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.[0].toolCalls?.[0].subagent).toMatchObject({ id: 'spawn', agentId: 'child', status: 'completed', toolCalls: [{ id: 'read', result: 'note', resultImages: [{ kind: 'data', data: 'aW1hZ2U=', mediaType: 'image/png' }] },
    { id: 'edit', diffData: { filePath: 'note.md', stats: { added: 1, removed: 1 }, diffLines: [{ type: 'equal', text: 'a' }, { type: 'delete', text: 'b' }, { type: 'insert', text: 'B' }] } },
    { id: 'failed', status: 'error', result: 'old_string not found' }] });
  // A failed edit changed nothing, so it shows no diff built from its requested input.
  expect(result.messages?.[0].toolCalls?.[0].subagent?.toolCalls[2].diffData).toBeUndefined();
  expect(peer.calls.find(c => c.method === 'session/attachment')?.args).toEqual({ request: { sessionId: 'child', attachmentId: 'child-image' } });
  expect(peer.calls.some(c => c.method === 'session/follow' || c.method === 'session/create')).toBe(false);
});

it('restores file-change diffs from native applied hunks, or from the written content for a created file, and none for a failed edit', async () => {
  records = [wire(0, 'turn/start', { turn: 0 }),
    wire(1, 'tool/call', { callId: 'edit', name: 'edit', arguments: '{"file_path":"note.md","old_string":"b","new_string":"B"}' }),
    wire(2, 'tool/result', { message: { toolCallId: 'edit', content: [{ type: 'text', text: 'updated' }] }, meta: { diffs: [{ path: 'note.md', oldText: 'a\nb\nc', newText: 'a\nB\nc' }] } }),
    wire(3, 'tool/call', { callId: 'write', name: 'write', arguments: '{"file_path":"new.md","content":"x\\ny"}' }),
    wire(4, 'tool/result', { message: { toolCallId: 'write', content: [{ type: 'text', text: 'Created file' }] }, meta: { operation: 'create', diffs: [] } }),
    wire(5, 'tool/call', { callId: 'failed', name: 'edit', arguments: '{"file_path":"note.md","old_string":"x","new_string":"X"}' }),
    wire(6, 'tool/result', { message: { toolCallId: 'failed', content: [{ type: 'text', text: 'old_string not found' }], isError: true } }),
    wire(7, 'turn/end', { turn: 0, reason: { kind: 'completed' } })];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.[0].toolCalls).toMatchObject([
    { name: 'Edit', diffData: { filePath: 'note.md', stats: { added: 1, removed: 1 }, diffLines: [{ type: 'equal', text: 'a' }, { type: 'delete', text: 'b' }, { type: 'insert', text: 'B' }, { type: 'equal', text: 'c' }] } },
    { name: 'Write', diffData: { filePath: 'new.md', stats: { added: 2, removed: 0 }, diffLines: [{ type: 'insert', text: 'x' }, { type: 'insert', text: 'y' }] } },
    { name: 'Edit', status: 'error', result: 'old_string not found' },
  ]);
  // A failed edit changed nothing, so it shows no diff built from its requested input.
  expect(result.messages?.[0].toolCalls?.[2].diffData).toBeUndefined();
});

it.each([
  { attachment: { id: 'wrong-native-field' } },
  { attachment: {} },
  {},
])('rejects malformed native image references instead of silently omitting them: %j', block => {
  records = [wire(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'image', ...block }] })];
  return expect(history.hydrateConversationHistory(input, '/vault')).rejects.toThrow(/image.*reference/i);
});

it.each([
  ['a different native identity', { attachmentId: 'other-image', mediaType: 'image/png' }, /image attachment/i],
  ['an unsupported media type', { attachmentId: 'image', mediaType: 'image/svg+xml' }, /unsupported.*media type/i],
  ['an inherited constructor entry', { attachmentId: 'image', mediaType: 'constructor' }, /unsupported.*media type/i],
  ['an inherited __proto__ entry', { attachmentId: 'image', mediaType: '__proto__' }, /unsupported.*media type/i],
])('rejects an attachment response for %s', async (_case, attachment, error) => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'session/attachment'
    ? { attachment, data: 'aW1hZ2U=' } : ordinary(method, args);
  await expect(history.hydrateConversationHistory(input, '/vault')).rejects.toThrow(error);
});

it.each([
  ['an empty page that claims more history', () => ({ records: [], hasMore: true }), /made no progress/i],
  ['a record beyond the fixed cut', () => ({ records: [wire(9, 'turn/start', { turn: 2 })], hasMore: false }), /invalid.*record/i],
  ['a repeated record on a later page', (request: { beforeSeq?: number }) => request.beforeSeq === undefined
    ? { records: [wire(5, 'turn/start', { turn: 1 })], hasMore: true }
    : { records: [wire(5, 'turn/start', { turn: 1 })], hasMore: false }, /invalid.*record/i],
])('rejects native history pages with %s', async (_case, page, error) => {
  const ordinary = peer.onCall;
  peer.onCall = (method, args) => method === 'session/page' ? page(nativeRequest(args)) : ordinary(method, args);
  await expect(history.hydrateConversationHistory(input, '/vault')).rejects.toThrow(error);
});


it.each(['tool-jobs', 'subagent-settled'])('hydrates native %s completion notices', async kind => {
  records = [wire(0, 'turn/start', { turn: 0 }),
    wire(1, 'user/message', { source: { kind }, content: [{ type: 'text', text: 'work finished' }] }),
    wire(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } })];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages).toMatchObject([{ role: 'assistant', isAutomaticResponse: true,
    contentBlocks: [{ type: 'task_notification', content: 'work finished' }] }]);
});


it.each([false, true])('splits steered history at its user boundary with automatic=%s and one final checkpoint', async automatic => {
  records = [
    wire(1, 'turn/start', { turn: 1 }),
    ...(!automatic ? [wire(2, 'user/message', { id: 'u1', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: 'write the report' }] })] : []),
    wire(3, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'drafting' }] } }),
    wire(4, 'step/start', { turn: 1, step: 1 }),
    wire(5, 'user/message', { id: 'u2', source: { kind: 'user', rpcId: 'steer-1' }, content: [{ type: 'text', text: 'make it shorter' }] }),
    wire(6, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'short report' }] } }),
    wire(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    wire(8, 'session/title', { title: 'Report' }),
  ];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.map(message => [message.role, message.content])).toEqual([
    ...(!automatic ? [['user', 'write the report']] : []), ['assistant', 'drafting'], ['user', 'make it shorter'], ['assistant', 'short report'],
  ]);
  const [first, steered, last] = result.messages!.slice(-3);
  expect(new Set(result.messages!.map(message => message.id)).size).toBe(automatic ? 3 : 4);
  expect(first.isAutomaticResponse).toBe(automatic ? true : undefined);
  expect(steered.userMessageId).toBe('u2');
  expect(first.assistantMessageId).toBeUndefined();
  expect(last).toMatchObject({ assistantMessageId: 'deepseek:seq:7', contentBlocks: [{ type: 'text', content: 'short report' }] });
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

it('restores each completed turn\'s work duration so it renders as its own "Worked for" response', async () => {
  const at = (seq: number, ms: number, type: string, data: unknown) => ({ type: 'event', event: { seq, type, time: time + ms, data, surfaceOp: 'append' } });
  records = [
    at(1, 0, 'turn/start', { turn: 1 }),
    at(2, 0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] }),
    at(3, 1_000, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'one' }] } }),
    at(4, 125_900, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    at(5, 200_000, 'turn/start', { turn: 2 }),
    at(6, 200_000, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] }),
    at(7, 203_000, 'assistant/message', { turn: 2, step: 0, message: { content: [{ type: 'text', text: 'two' }] } }),
    at(8, 207_000, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ];

  const result = await history.hydrateConversationHistory(input, '/vault');

  expect(result.messages?.filter(message => message.role === 'assistant').map(message => message.durationSeconds)).toEqual([125, 7]);
});

it('marks user-aborted turns interrupted without work timing and keeps a following automatic turn normal', async () => {
  const at = (seq: number, ms: number, type: string, data: unknown) => ({ type: 'event', event: { seq, type, time: time + ms, data, surfaceOp: 'append' } });
  const aborted = { kind: 'aborted', reason: { kind: 'user' } };
  records = [
    at(1, 0, 'turn/start', { turn: 1 }),
    at(2, 0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'run the job' }] }),
    at(3, 1_000, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'starting' }] }, usage: { outputTokens: 3 } }),
    at(4, 2_000, 'tool/call', { callId: 'job', name: 'read', arguments: '{"path":"note.md"}' }),
    at(5, 9_000, 'turn/end', { turn: 1, reason: aborted }),
    at(6, 20_000, 'turn/start', { turn: 2 }),
    at(7, 20_000, 'user/message', { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'job finished' }] }),
    at(8, 21_000, 'assistant/message', { turn: 2, step: 0, message: { content: [{ type: 'text', text: 'the job finished' }] } }),
    at(9, 23_000, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    at(10, 30_000, 'turn/start', { turn: 3 }),
    at(11, 30_000, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'never mind' }] }),
    at(12, 31_000, 'turn/end', { turn: 3, reason: aborted }),
  ];
  const onCall = peer.onCall;
  peer.onCall = (method, args) => method === 'session/projections'
    ? { ...onCall(method, args) as Record<string, unknown>, asOfSeq: 12 } : onCall(method, args);

  const result = await history.hydrateConversationHistory(input, '/vault');

  expect(result.messages?.map(({ role, content, isInterrupt, isAutomaticResponse, durationSeconds, turnStats, completedAt }) => (
    { role, content, isInterrupt, isAutomaticResponse, durationSeconds, turnStats, completedAt }))).toEqual([
    { role: 'user', content: 'run the job' },
    { role: 'assistant', content: 'starting', isInterrupt: true },
    { role: 'assistant', content: 'the job finished', isAutomaticResponse: true, durationSeconds: 3,
      turnStats: { outputTokens: 0, durationMs: 3_000 }, completedAt: time + 23_000 },
    { role: 'user', content: 'never mind' },
    // A turn stopped before any output keeps a bare marker, as the live Stop renders it.
    { role: 'assistant', content: '', isInterrupt: true },
  ].map(message => Object.fromEntries(Object.entries({ isInterrupt: undefined, isAutomaticResponse: undefined,
    durationSeconds: undefined, turnStats: undefined, completedAt: undefined, ...message }))));
  expect(result.messages?.[1].toolCalls).toEqual([expect.objectContaining({ id: 'job', name: 'Read', status: 'error' })]);
});

it('settles pending tools before and after a steer while retaining completed background launches', async () => {
  records = [
    wire(1, 'turn/start', { turn: 1 }),
    wire(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'start work' }] }),
    wire(3, 'tool/call', { callId: 'background', name: 'bash', arguments: '{"command":"watch"}' }),
    wire(4, 'tool/result', { message: { toolCallId: 'background', content: [{ type: 'text', text: 'Job started in background' }], isError: false } }),
    wire(5, 'tool/call', { callId: 'before-steer', name: 'read', arguments: '{"path":"note.md"}' }),
    wire(6, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'change direction' }] }),
    wire(7, 'tool/call', { callId: 'after-steer', name: 'read', arguments: '{"path":"other.md"}' }),
    wire(8, 'turn/end', { turn: 1, reason: { kind: 'cancelled' } }),
  ];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.map(message => [message.role, message.content])).toEqual([
    ['user', 'start work'], ['assistant', ''], ['user', 'change direction'], ['assistant', ''],
  ]);
  expect(result.messages?.flatMap(message => message.toolCalls ?? []).map(({ id, status, result: content }) => ({ id, status, content }))).toEqual([
    { id: 'background', status: 'completed', content: 'Job started in background' },
    { id: 'before-steer', status: 'error', content: undefined },
    { id: 'after-steer', status: 'error', content: undefined },
  ]);
});

it('hydrates a session-message sender and preserves neutral tool names without colliding with native send_message', async () => {
  records = [
    wire(0, 'turn/start', { turn: 0 }),
    wire(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: encodeSessionMessage({ from: 'Planner', sessionId: 'sender', text: 'Please review' }) }] }),
    wire(2, 'tool/call', { callId: 'list', name: 'claudian_list_destinations', arguments: '{}' }),
    wire(3, 'tool/call', { callId: 'send', name: 'claudian_send_message', arguments: '{"sessionId":"sender","text":"Reviewed"}' }),
    wire(4, 'tool/call', { callId: 'native', name: 'send_message', arguments: '{"agent_id":"child","text":"Continue"}' }),
    wire(5, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ];
  const result = await history.hydrateConversationHistory(input, '/vault');
  expect(result.messages?.[0].sessionMessage).toEqual({ from: 'Planner', sessionId: 'sender' });
  expect(extractUserDisplayContent(result.messages![0].content)).toBe('Please review');
  expect(result.messages?.[1].toolCalls).toMatchObject([
    { name: 'claudian_list_destinations', providerPayload: { rawName: 'claudian_list_destinations' } },
    { name: 'claudian_send_message', input: { sessionId: 'sender', text: 'Reviewed' }, providerPayload: { rawName: 'claudian_send_message' } },
    { name: 'send_message', input: { target: 'child', text: 'Continue' } },
  ]);
});
