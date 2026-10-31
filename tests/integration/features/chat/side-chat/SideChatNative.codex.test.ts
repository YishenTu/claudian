import * as fs from 'node:fs/promises';
import * as path from 'node:path';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { codexForkRequest, codexTextTurnRequest,codexThreadId } from '@test/helpers/providers/codex/CodexRequests';
import { createNativeRPCProcess } from '@test/helpers/providers/NativeRPCTestProcess';
import spawn from 'cross-spawn';

import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';

import { traceSideChild } from './SideChatNativeTracer';

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
  const operations: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sourceFile = path.join(env.root, 'codex-source.jsonl');
  let ordinal = 0;
  const result = (id: string) => ({
    thread: { id, path: id === 'codex-child' ? null : sourceFile, ephemeral: id === 'codex-child', turns: (threads.get(id) ?? []).map(turnId => ({ id: turnId, items: [], status: 'completed' })) },
    sandbox: { type: 'workspaceWrite' },
  });
  vi.mocked(spawn).mockImplementation(() => createNativeRPCProcess(async (method, params, notify) => {
    operations.push({ method, params });
    if (method === 'initialize') return { codexHome: env.root, platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', userAgent: 'test' };
    if (method === 'plugin/reconcile' || method === 'thread/unsubscribe') return {};
    if (method === 'thread/start') return result('codex-source');
    if (method === 'thread/fork') {
      const request = codexForkRequest(params);
      if (request.ephemeral && !request.excludeTurns) throw new Error('ephemeral paginated thread/fork requires excludeTurns: true');
      const source = threads.get(request.threadId)!;
      const end = request.lastTurnId ? source.indexOf(request.lastTurnId) + 1 : source.length;
      threads.set('codex-child', source.slice(0, end));
      return result('codex-child');
    }
    if (method === 'thread/resume') return result(codexThreadId(params));
    if (method === 'turn/start') {
      const id = `codex-turn-${++ordinal}`;
      const itemId = `msg_codex-${ordinal}`;
      const { threadId, input } = codexTextTurnRequest(params);
      const turns = threads.get(threadId)!;
      prompts.push({ context: [...turns], threadId });
      turns.push(id);
      if (threadId === 'codex-source') {
        const records = [
          { payload: { turn_id: id, type: 'task_started' }, type: 'event_msg' },
          { payload: { model: 'gpt-5', turn_id: id }, type: 'turn_context' },
          { payload: { content: [{ text: input[0].text, type: 'input_text' }], role: 'user', type: 'message' }, type: 'response_item' },
          { payload: { content: [{ text: `Reply ${ordinal}`, type: 'output_text' }], id: itemId, role: 'assistant', type: 'message' }, type: 'response_item' },
          { payload: { turn_id: id, type: 'task_complete' }, type: 'event_msg' },
        ];
        await fs.appendFile(sourceFile, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      }
      notify('turn/started', { threadId, turn: { id, items: [], status: 'inProgress' } });
      notify('item/started', { item: { id: itemId, text: '', type: 'agentMessage' }, threadId, turnId: id });
      notify('item/agentMessage/delta', { delta: `Reply ${ordinal}`, itemId, threadId, turnId: id });
      notify('item/completed', { item: { id: itemId, text: `Reply ${ordinal}`, type: 'agentMessage' }, threadId, turnId: id });
      notify('turn/completed', { threadId, turn: { id, items: [], status: 'completed' } });
      return { turn: { id, items: [], status: 'inProgress' } };
    }
    throw new Error(`Unexpected Codex method: ${method}`);
  }));
  return { backend: new CodexExecutionBackend(
    env.host.getRuntimeHost('codex'),
    fixedRuntime(createRuntime(env.host)),
  ), operations, prompts, sourceFile, threads };
}

describe('Codex side-chat native child', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); vi.mocked(spawn).mockReset(); });

  it('forks an ephemeral child at the captured checkpoint and keeps main history untouched', async () => {
    const native = createNativeCodex(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    await env.send(source, 'Remember A2');
    const sourceBytes = await fs.readFile(native.sourceFile, 'utf8');
    const conversationsBefore = env.repository.list().map(conversation => conversation.id);

    const child = await traceSideChild(env, source, checkpoint, native.backend);
    await child!.send('Also remember B');
    expect(native.operations).toContainEqual({ method: 'thread/fork', params: expect.objectContaining({ threadId: 'codex-source', ephemeral: true, excludeTurns: true, lastTurnId: 'codex-turn-1' }) });
    expect(native.prompts.at(-1)).toEqual({ context: ['codex-turn-1'], threadId: 'codex-child' });

    await child!.send('Use A and B');
    expect(native.prompts.at(-1)).toEqual({ context: ['codex-turn-1', 'codex-turn-3'], threadId: 'codex-child' });
    expect(native.operations.filter(operation => operation.method === 'thread/fork')).toHaveLength(1);
    expect(native.threads.get('codex-source')).toEqual(['codex-turn-1', 'codex-turn-2']);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBytes);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual(conversationsBefore);

    await env.send(source, 'Continue main');
    expect(native.prompts.at(-1)).toEqual({ context: ['codex-turn-1', 'codex-turn-2'], threadId: 'codex-source' });
    await child!.dispose();
  });

  it('fails without creating the child when the captured checkpoint left native history', async () => {
    const native = createNativeCodex(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    await expect(traceSideChild(env, source, checkpoint, native.backend, {
      beforeStart: async () => { await fs.writeFile(native.sourceFile, ''); },
    })).rejects.toThrow(/checkpoint not found/i);
    expect(native.threads.has('codex-child')).toBe(false);
    expect(native.prompts).toHaveLength(1);
  });
});
