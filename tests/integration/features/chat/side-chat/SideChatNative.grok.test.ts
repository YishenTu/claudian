import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import initializeFixture from '@test/fixtures/providers/grok/extensions/plan-mode-hook.json';

jest.mock('cross-spawn', () => jest.fn());
import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { createNativeRPCProcess } from '@test/helpers/providers/NativeRPCTestProcess';
import spawn from 'cross-spawn';

import { GrokExecutionBackend } from '@/providers/grok/execution/GrokExecutionBackend';

import { traceSideChild } from './SideChatNativeTracer';

function createNativeGrok(env: ForkTestEnvironment) {
  const sessions = new Map<string, string[]>([['grok-source', []]]);
  const operations: Array<{ method: string; params: Record<string, any> }> = [];
  const prompts: Array<{ sessionId: string; context: string[] }> = [];
  const directory = (id: string) => path.join(env.root, 'grok', 'sessions', encodeURIComponent(env.root), id);
  const sourceFile = path.join(directory('grok-source'), 'updates.jsonl');
  let ordinal = 0;
  jest.mocked(spawn).mockImplementation(() => createNativeRPCProcess(async (method, params, notify) => {
    operations.push({ method, params });
    if (method === 'initialize') return initializeFixture.initializeResult;
    if (method === 'session/new') {
      await fs.mkdir(directory('grok-source'), { recursive: true });
      return { sessionId: 'grok-source' };
    }
    if (method === 'session/set_mode' || method === 'session/set_model') return {};
    if (method === '_x.ai/session/fork') {
      sessions.set('grok-child', sessions.get(params.sourceSessionId)!.slice(0, params.targetPromptIndex));
      await fs.mkdir(directory('grok-child'), { recursive: true });
      return { newCwd: params.newCwd, newSessionId: 'grok-child', parentSessionId: params.sourceSessionId };
    }
    if (method === 'session/load') return {};
    if (method === 'session/prompt') {
      const sessionId = params.sessionId as string;
      const context = sessions.get(sessionId)!;
      prompts.push({ context: [...context], sessionId });
      const turn = ++ordinal;
      const assistantId = `grok-assistant-${turn}`;
      const updates = [
        { _meta: { promptIndex: context.length }, content: { text: params.prompt[0].text, type: 'text' }, messageId: `grok-user-${turn}`, sessionUpdate: 'user_message_chunk' },
        { _meta: { eventId: assistantId }, content: { text: `Reply ${turn}`, type: 'text' }, sessionUpdate: 'agent_message_chunk' },
        { sessionUpdate: 'turn_completed' },
      ];
      const records = updates.map(update => ({ method: 'session/update', params: { sessionId, update }, timestamp: 1_700_000_000 + turn }));
      await fs.appendFile(path.join(directory(sessionId), 'updates.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
      for (const record of records) notify(record.method, record.params);
      context.push(assistantId);
      return { stopReason: 'end_turn' };
    }
    throw new Error(`Unexpected Grok method: ${method}`);
  }));
  return { backend: new GrokExecutionBackend(env.host), operations, prompts, sessions, sourceFile };
}

describe('Grok side-chat native child', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); jest.mocked(spawn).mockReset(); });

  it('forks at the captured prompt boundary and loads only the child for its own turns', async () => {
    const native = createNativeGrok(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    await env.send(source, 'Remember A2');
    const sourceBytes = await fs.readFile(native.sourceFile, 'utf8');
    const conversationsBefore = env.repository.list().map(conversation => conversation.id);

    const child = await traceSideChild(env, source, checkpoint, native.backend, {
      model: 'grok/grok-code-fast-1',
    });
    await child!.send('Also remember B');
    expect(native.operations.find(operation => operation.method === '_x.ai/session/fork')?.params).toEqual({
      newCwd: env.root, newModelId: 'grok-code-fast-1', sourceCwd: env.root,
      sourceSessionId: 'grok-source', targetPromptIndex: 1,
    });
    expect(native.operations.find(operation => operation.method === 'session/load')?.params)
      .toMatchObject({ _meta: expect.any(Object), sessionId: 'grok-child' });
    expect(native.prompts.at(-1)).toEqual({ context: ['grok-assistant-1'], sessionId: 'grok-child' });

    await child!.send('Use A and B');
    expect(native.prompts.at(-1)).toEqual({ context: ['grok-assistant-1', 'grok-assistant-3'], sessionId: 'grok-child' });
    expect(native.operations.filter(operation => operation.method === '_x.ai/session/fork')).toHaveLength(1);
    expect(native.sessions.get('grok-source')).toEqual(['grok-assistant-1', 'grok-assistant-2']);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBytes);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual(conversationsBefore);
    await child!.dispose();
  });

  it('refuses a missing captured checkpoint before native fork or prompt dispatch', async () => {
    const native = createNativeGrok(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    const child = await traceSideChild(env, source, checkpoint, native.backend, {
      beforeStart: async () => { await fs.writeFile(native.sourceFile, ''); },
    });
    const turn = await child!.send('Cannot start');
    expect(turn.terminal).toBe('execution_error');
    expect(turn.errorMessage).toMatch(/checkpoint/i);
    expect(native.sessions.has('grok-child')).toBe(false);
    expect(native.prompts).toHaveLength(1);
    await child!.dispose();
  });
});
