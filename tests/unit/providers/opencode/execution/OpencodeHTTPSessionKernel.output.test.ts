import { OpencodeHTTPSessionKernel } from '@/providers/opencode/execution/OpencodeHTTPSessionKernel';
import type { OpencodeNativeOutput } from '@/providers/opencode/execution/OpencodeSessionContract';
import { OpencodeSessionPersistence } from '@/providers/opencode/execution/OpencodeSessionPersistence';
import type { OpencodeHTTPEvent } from '@/providers/opencode/http/OpencodeHTTPClient';

let kernel: OpencodeHTTPSessionKernel;
let receive: (event: OpencodeHTTPEvent) => void;
let output: Array<{ event: OpencodeNativeOutput; session?: string }>;
let read: jest.Mock;
let requests: string[];
let bodies: unknown[];
let skills: () => Promise<unknown>;
const event = (type: string, data: Record<string, unknown> = {}) => receive({ type, data: {
  sessionID: 'ses_main', assistantMessageID: 'msg_main', id: 'tool_shell', ...data,
} });
function start(sessionID = 'ses_main', id = 'tool_shell') {
  event('session.tool.input.started', { sessionID, id, name: 'shell' });
  event('session.tool.called', { sessionID, id, input: { command: 'echo example' } });
  event('session.tool.progress', { sessionID, id, metadata: { shellID: `sh_${id}` } });
}
const previews = () => output.flatMap(({ event }) => event.type === 'tool_output' ? [event.content] : []);

beforeEach(async () => {
  jest.useFakeTimers();
  output = []; requests = []; bodies = [];
  skills = async () => ({ data: [] });
  read = jest.fn().mockResolvedValue({ data: { output: '', cursor: 0, size: 0, truncated: false } });
  const lease = {
    databasePath: null, isReusable: () => true, onRetired: () => {}, onSuperseded: () => {},
    subscribe: async (callback: typeof receive) => { receive = callback; },
    registerAgents: async () => ({}), waitForActivation: async () => {}, refreshGlobalForms: async () => {},
    dispose: async () => {},
    request: async (route: string, options?: { body?: unknown }) => {
      requests.push(route);
      if (options?.body !== undefined) bodies.push(options.body);
      if (route === '/api/skill') return skills();
      if (route.startsWith('/api/shell/')) return read(route, options);
      if (route === '/api/model') return { data: [{ id: 'model', providerID: 'test', enabled: true }, { id: {}, providerID: 'test', enabled: true }] };
      if (route === '/api/command') return { data: [] };
      return { data: { id: 'ses_main' } };
    },
  };
  const config = { vaultWorkingDirectory: '/workspace', lifecycle: 'persistent', nativePersistence: 'provider-default', interactionPort: { dismissInteraction: jest.fn() } } as any;
  kernel = new OpencodeHTTPSessionKernel({ config, getActiveTurnId: () => 'turn',
    onNativeOutput: (event: OpencodeNativeOutput, session?: string) => output.push({ event, session }), onNativeTurn: jest.fn(), onClosed: jest.fn(),
  } as any, '/opencode', {}, { acquire: async () => lease } as any, new OpencodeSessionPersistence(config));
  await kernel.connect({ profile: 'managed', systemInstructions: { kind: 'explicit', instructions: '' } } as any);
  await kernel.openSession();
});

afterEach(async () => { await kernel.dispose(); jest.useRealTimers(); });

it('reads native shell deltas by byte cursor before completion, once per tool', async () => {
  read.mockResolvedValueOnce({ data: { output: '你', cursor: 3, size: 3, truncated: false } })
    .mockResolvedValueOnce({ data: { output: '好', cursor: 6, size: 6, truncated: false } });
  start();
  event('session.tool.progress', { metadata: { shellID: 'sh_tool_shell' } });
  await jest.advanceTimersByTimeAsync(150);
  expect(previews().join('')).toBe('你好');
  expect(output.some(({ event }) => event.type === 'tool_completed')).toBe(false);
  const routes = requests.filter(route => route.startsWith('/api/shell/'));
  expect(routes[0]).toContain('cursor=0');
  expect(routes[1]).toContain('cursor=3');
  expect(routes.every(route => route.includes('limit=65536'))).toBe(true);
  event('session.tool.success', { content: [{ text: '你好 final' }] });
  const calls = read.mock.calls.length;
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(calls);
});

it.each(['tool completion', 'turn completion', 'cancel', 'dispose'])(
  'discards an in-flight preview after %s', async ending => {
    let resolve!: (data: unknown) => void;
    read.mockImplementation(() => new Promise(done => { resolve = done; }));
    start();
    await Promise.resolve();
    if (ending === 'tool completion') event('session.tool.success', { content: [{ text: 'final' }] });
    if (ending === 'turn completion') event('session.execution.succeeded');
    if (ending === 'cancel') kernel.cancel('ses_main');
    if (ending === 'dispose') await kernel.dispose();
    expect(read).toHaveBeenCalledTimes(1);
    resolve({ data: { output: 'late', cursor: 4, size: 4, truncated: false } });
    await jest.advanceTimersByTimeAsync(1000);
    expect(previews()).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it('isolates other sessions and keeps an owned background child streaming after its parent finishes', async () => {
  start('ses_other');
  expect(read).not.toHaveBeenCalled();
  event('session.tool.input.started', { id: 'spawn', name: 'subagent' });
  event('session.tool.called', { id: 'spawn', input: { background: true } });
  event('session.tool.progress', { id: 'spawn', metadata: { sessionID: 'ses_child' } });
  read.mockResolvedValueOnce({ data: { output: 'child', cursor: 5, size: 5, truncated: false } });
  start('ses_child');
  event('session.execution.succeeded');
  await jest.advanceTimersByTimeAsync(1);
  expect(previews()).toEqual(['child']);
  expect(output.find(({ event }) => event.type === 'tool_output')).toMatchObject({ session: 'ses_child', event: {
    toolCallId: 'ses_child:tool_shell', toolScope: { kind: 'subagent', subagentId: 'spawn' },
  } });
  event('session.execution.succeeded', { sessionID: 'ses_child' });
  const count = read.mock.calls.length;
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(count);
});

it('normalizes cumulative metadata and freezes non-prefix updates until the final result', () => {
  event('session.tool.input.started', { name: 'custom' });
  for (const text of ['a', 'ab', 'ab', 'abc', 'reset', 'reset!']) {
    event('session.tool.progress', { metadata: { output: text } });
  }
  expect(previews().join('')).toBe('abc');
  event('session.tool.success', { content: [{ text: 'reset!' }] });
  expect(output.at(-1)?.event).toMatchObject({ type: 'tool_completed', content: 'reset!' });
});

it('treats preview failure as best effort and bounds retained live output', async () => {
  read.mockRejectedValueOnce(new Error('shell no longer available'));
  start();
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(1);
  event('session.tool.success', { content: [{ text: 'final' }] });
  expect(output.at(-1)?.event).toMatchObject({ type: 'tool_completed', content: 'final' });
  read.mockResolvedValue({ data: { output: 'bounded', cursor: 1024 * 1024, size: 1024 * 1024, truncated: true } });
  start('ses_main', 'second');
  await jest.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(2);
});

it('blocks queued preview admission after cancellation without stopping a peer child or a later run', async () => {
  event('session.tool.input.started', { id: 'spawn', name: 'subagent' });
  event('session.tool.called', { id: 'spawn', input: { background: true } });
  event('session.tool.progress', { id: 'spawn', metadata: { sessionID: 'ses_child' } });
  kernel.cancel('ses_main');
  // A queued start may arrive before the interrupt's terminal event.
  event('session.execution.started');
  start('ses_main', 'queued');
  event('session.tool.progress', { id: 'queued', metadata: { output: 'cancelled snapshot' } });
  await jest.advanceTimersByTimeAsync(1);
  expect(read).not.toHaveBeenCalled();
  expect(previews()).toEqual([]);

  read.mockResolvedValueOnce({ data: { output: 'child', cursor: 5 } });
  start('ses_child', 'child-tool');
  await jest.advanceTimersByTimeAsync(1);
  expect(previews()).toEqual(['child']);
  event('session.tool.success', { sessionID: 'ses_child', id: 'child-tool', content: [{ text: 'child final' }] });

  event('session.execution.interrupted');
  start('ses_main', 'late');
  await jest.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(1);
  event('session.execution.started');
  read.mockResolvedValueOnce({ data: { output: 'new run', cursor: 7 } });
  start('ses_main', 'new');
  await jest.advanceTimersByTimeAsync(1);
  expect(previews()).toEqual(['child', 'new run']);
});

it('publishes usable model IDs and falls back to the ID when the label is missing', async () => {
  const session = await kernel.openSession();
  expect(session.models?.availableModels).toEqual([{ modelId: 'test/model', name: 'test/model' }]);
});

it('ignores malformed native stream identities without losing valid text or tool output', () => {
  event('session.text.delta', { assistantMessageID: {}, ordinal: 0, delta: 'Invalid message' });
  event('session.text.delta', { ordinal: {}, delta: 'Invalid ordinal' });
  event('session.tool.input.started', { id: {}, name: 'custom' });
  event('session.tool.called', { id: {}, input: {} });
  event('session.text.delta', { ordinal: 0, delta: 'Valid ' });
  event('session.text.ended', { ordinal: 0, text: 'Valid text' });
  event('session.tool.input.started', { name: 'custom' });
  event('session.tool.called', { input: {} });
  expect(output.map(({ event }) => event)).toEqual([
    { type: 'text_delta', text: 'Valid ' },
    { type: 'text_delta', text: 'text' },
    expect.objectContaining({ type: 'tool_started', toolCallId: 'tool_shell' }),
  ]);
});

it('admits steers in submission order while a skill lookup is pending', async () => {
  let release!: () => void;
  // Disposal settles the open run and undelivered steers.
  void kernel.prompt({ sessionId: 'ses_main', prompt: [{ type: 'text', text: 'work' }] }, { start: 0, end: 4 }).catch(() => undefined);
  await jest.advanceTimersByTimeAsync(0);
  skills = () => new Promise(resolve => { release = () => resolve({ data: [{ id: 'writing' }] }); });
  const first = 'Use /writing';
  void kernel.steer!({ sessionId: 'ses_main', prompt: [{ type: 'text', text: first }] }, { start: 0, end: first.length }).catch(() => undefined);
  void kernel.steer!({ sessionId: 'ses_main', prompt: [{ type: 'text', text: 'Then this' }] }, { start: 0, end: 9 }).catch(() => undefined);
  await jest.advanceTimersByTimeAsync(0);
  release();
  await jest.advanceTimersByTimeAsync(0);
  const steers = bodies.filter((body): body is { text: string } => (body as { delivery?: string }).delivery === 'steer');
  expect(steers.map(body => body.text)).toEqual([first, 'Then this']);
  expect(steers[0]).toMatchObject({ skills: [{ id: 'writing', mention: { start: 4, end: 12, text: '/writing' } }] });
});

it('keeps later steers behind an earlier pending lookup when a middle lookup fails', async () => {
  const lookups: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  void kernel.prompt({ sessionId: 'ses_main', prompt: [{ type: 'text', text: 'work' }] }, { start: 0, end: 4 }).catch(() => undefined);
  await jest.advanceTimersByTimeAsync(0);
  skills = () => new Promise((resolve, reject) => { lookups.push({ resolve, reject }); });
  const steer = (text: string, range = { start: 0, end: text.length }) =>
    kernel.steer!({ sessionId: 'ses_main', prompt: [{ type: 'text', text }] }, range).catch(() => undefined);
  void steer('First /writing');
  void steer('Second /writing');
  await jest.advanceTimersByTimeAsync(0);
  lookups[1].reject(new Error('lookup failed'));
  await jest.advanceTimersByTimeAsync(0);
  void steer('Third');
  await jest.advanceTimersByTimeAsync(0);
  lookups[0].resolve({ data: [{ id: 'writing' }] });
  await jest.advanceTimersByTimeAsync(0);
  const steers = bodies.filter((body): body is { text: string } => (body as { delivery?: string }).delivery === 'steer');
  expect(steers.map(body => body.text)).toEqual(['First /writing', 'Third']);
});
