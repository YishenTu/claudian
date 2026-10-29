import * as fs from 'node:fs/promises';
import * as path from 'node:path';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { createNativeRPCProcess } from '@test/helpers/providers/NativeRPCTestProcess';
import spawn from 'cross-spawn';

import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';

/** The backend resolves its runtime per session; tests pin one instance. */
const fixedRuntime = (runtime: CodexAppServerRuntime) => (): CodexAppServerRuntime => runtime;

const runtimes: CodexAppServerRuntime[] = [];
function createRuntime(host: ForkTestEnvironment['host']): CodexAppServerRuntime {
  const runtime = new CodexAppServerRuntime(host.getRuntimeHost('codex'), () => undefined);
  runtimes.push(runtime);
  return runtime;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); });

function createNativeCodex(env: ForkTestEnvironment) {
  const threads = new Map<string, string[]>([['codex-source', []]]);
  const prompts: Array<{ threadId: string; context: string[] }> = [];
  const operations: Array<{ method: string; params: Record<string, any> }> = [];
  const sourceFile = path.join(env.root, 'codex-source.jsonl');
  let ordinal = 0;
  const result = (id: string) => ({
    thread: { id, path: sourceFile, turns: (threads.get(id) ?? []).map(turnId => ({ id: turnId, items: [], status: 'completed' })) },
    sandbox: { type: 'workspaceWrite' },
  });
  vi.mocked(spawn).mockImplementation(() => createNativeRPCProcess(async (method, params, notify) => {
    operations.push({ method, params });
    if (method === 'initialize') return { userAgent: 'test', codexHome: env.root, platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux' };
    if (method === 'plugin/reconcile' || method === 'thread/unsubscribe') return {};
    if (method === 'thread/start') return result('codex-source');
    if (method === 'thread/fork') {
      const turns = threads.get(params.threadId)!;
      const last = params.lastTurnId === undefined ? turns.length - 1 : turns.indexOf(params.lastTurnId);
      if (last < 0) throw new Error(`Unknown fork turn: ${params.lastTurnId}`);
      threads.set('codex-child', turns.slice(0, last + 1));
      return result('codex-child');
    }
    if (method === 'thread/resume') return result(params.threadId);
    if (method === 'thread/revert') {
      const turns = threads.get(params.threadId)!;
      turns.splice(turns.indexOf(params.beforeTurnId));
      return result(params.threadId);
    }
    if (method === 'turn/start') {
      const id = `codex-turn-${++ordinal}`;
      const itemId = `msg_codex-${ordinal}`;
      const threadId = params.threadId as string;
      const turns = threads.get(threadId)!;
      prompts.push({ threadId, context: [...turns] });
      turns.push(id);
      if (threadId === 'codex-source') {
        const records = [
          { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
          { type: 'turn_context', payload: { turn_id: id, model: 'gpt-5' } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: params.input[0].text }] } },
          { type: 'response_item', payload: { type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text: `Reply ${ordinal}` }] } },
          { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
        ];
        await fs.appendFile(sourceFile, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      }
      notify('turn/started', { threadId, turn: { id, status: 'inProgress', items: [] } });
      notify('item/started', { threadId, turnId: id, item: { id: itemId, type: 'agentMessage', text: '' } });
      notify('item/agentMessage/delta', { threadId, turnId: id, itemId, delta: `Reply ${ordinal}` });
      notify('item/completed', { threadId, turnId: id, item: { id: itemId, type: 'agentMessage', text: `Reply ${ordinal}` } });
      notify('turn/completed', { threadId, turn: { id, status: 'completed', items: [] } });
      return { turn: { id, status: 'inProgress', items: [] } };
    }
    throw new Error(`Unexpected Codex method: ${method}`);
  }));
  return { backend: new CodexExecutionBackend(
    env.host.getRuntimeHost('codex'),
    fixedRuntime(createRuntime(env.host)),
  ), threads, prompts, operations, sourceFile };
}

describe('Codex fork integration', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); vi.mocked(spawn).mockReset(); });

  it('forks through the live turn checkpoint and continues both conversations independently', async () => {
    const native = createNativeCodex(env);
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    await env.send(source, 'Remember pears');
    expect(selected.assistantMessageId).toBe('codex-turn-1');
    const original = await fs.readFile(native.sourceFile, 'utf8');
    const child = await env.fork(source, selected);
    expect(child?.messages).toHaveLength(2);
    const fork = await env.open(native.backend, child!);
    await env.send(fork, 'Continue here');
    expect(native.prompts.at(-1)).toEqual({ threadId: 'codex-child', context: ['codex-turn-1'] });
    expect(native.operations).toContainEqual({ method: 'thread/fork', params: { threadId: 'codex-source', lastTurnId: 'codex-turn-1' } });
    expect(native.threads.get('codex-source')).toEqual(['codex-turn-1', 'codex-turn-2']);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(original);
    expect(env.repository.getSync(child!.id)!.sessionId).toBe('codex-child');
    await env.send(source, 'Keep original going');
    expect(native.prompts.at(-1)).toEqual({ threadId: 'codex-source', context: ['codex-turn-1', 'codex-turn-2'] });
  });

  it('rejects a checkpoint that disappeared from history before admitting a fork', async () => {
    const native = createNativeCodex(env);
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    await fs.writeFile(native.sourceFile, '');
    await expect(env.fork(source, selected)).rejects.toThrow(/checkpoint not found/i);
    expect(native.prompts).toHaveLength(1);
    expect(native.threads.has('codex-child')).toBe(false);
  });
});
