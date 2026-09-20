import * as fs from 'node:fs/promises';
import * as path from 'node:path';

jest.mock('cross-spawn', () => jest.fn());
import spawn from 'cross-spawn';

import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';

import { createNativeRpcProcess } from '../tabs/NativeRpcTestProcess';
import { createForkTestEnvironment, type ForkTestEnvironment } from '../tabs/ProviderForkTestHarness';
import { traceSideChild } from './SideChatNativeTracer';

function createNativeCodex(env: ForkTestEnvironment) {
  const threads = new Map<string, string[]>([['codex-source', []]]);
  const prompts: Array<{ threadId: string; context: string[] }> = [];
  const operations: Array<{ method: string; params: Record<string, any> }> = [];
  const sourceFile = path.join(env.root, 'codex-source.jsonl');
  let ordinal = 0;
  const result = (id: string) => ({
    thread: { id, path: sourceFile, turns: (threads.get(id) ?? []).map(turnId => ({ id: turnId, items: [], status: 'completed' })) },
  });
  jest.mocked(spawn).mockImplementation(() => createNativeRpcProcess(async (method, params, notify) => {
    operations.push({ method, params });
    if (method === 'initialize') return { codexHome: env.root, platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform === 'darwin' ? 'macos' : process.platform, userAgent: 'test' };
    if (method === 'thread/start') return result('codex-source');
    if (method === 'thread/fork') {
      threads.set('codex-child', [...threads.get(params.threadId)!]);
      return result('codex-child');
    }
    if (method === 'thread/resume') return result(params.threadId);
    if (method === 'thread/rollback') {
      const turns = threads.get(params.threadId)!;
      turns.splice(turns.length - params.numTurns);
      return result(params.threadId);
    }
    if (method === 'turn/start') {
      const id = `codex-turn-${++ordinal}`;
      const itemId = `msg_codex-${ordinal}`;
      const threadId = params.threadId as string;
      const turns = threads.get(threadId)!;
      prompts.push({ context: [...turns], threadId });
      turns.push(id);
      if (threadId === 'codex-source') {
        const records = [
          { payload: { turn_id: id, type: 'task_started' }, type: 'event_msg' },
          { payload: { model: 'gpt-5', turn_id: id }, type: 'turn_context' },
          { payload: { content: [{ text: params.input[0].text, type: 'input_text' }], role: 'user', type: 'message' }, type: 'response_item' },
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
  return { backend: new CodexExecutionBackend(env.host), operations, prompts, sourceFile, threads };
}

describe('Codex side-chat native child', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); jest.mocked(spawn).mockReset(); });

  it('rolls back only the child thread and keeps main history and the Claudian record untouched', async () => {
    const native = createNativeCodex(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    await env.send(source, 'Remember A2');
    const sourceBytes = await fs.readFile(native.sourceFile, 'utf8');
    const sourceLedger = await env.repository.getConversationInputLedger(source.conversation.id);
    const conversationsBefore = env.repository.list().map(conversation => conversation.id);

    const child = await traceSideChild(env, source, checkpoint, native.backend);
    await child!.send('Also remember B');
    expect(native.operations).toContainEqual({ method: 'thread/fork', params: { threadId: 'codex-source' } });
    expect(native.operations).toContainEqual({ method: 'thread/rollback', params: { numTurns: 1, threadId: 'codex-child' } });
    expect(native.prompts.at(-1)).toEqual({ context: ['codex-turn-1'], threadId: 'codex-child' });

    await child!.send('Use A and B');
    expect(native.prompts.at(-1)).toEqual({ context: ['codex-turn-1', 'codex-turn-3'], threadId: 'codex-child' });
    expect(native.operations.filter(operation => operation.method === 'thread/fork')).toHaveLength(1);
    expect(native.threads.get('codex-source')).toEqual(['codex-turn-1', 'codex-turn-2']);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBytes);
    expect(await env.repository.getConversationInputLedger(source.conversation.id)).toEqual(sourceLedger);
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
