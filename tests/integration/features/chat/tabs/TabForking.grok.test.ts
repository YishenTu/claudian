import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import initializeFixture from '@test/fixtures/providers/grok/extensions/plan-mode-hook.json';

jest.mock('cross-spawn', () => jest.fn());
import spawn from 'cross-spawn';

import { GrokExecutionBackend } from '@/providers/grok/execution/GrokExecutionBackend';

import { createNativeRpcProcess } from './NativeRpcTestProcess';
import { createForkTestEnvironment, type ForkTestEnvironment } from './ProviderForkTestHarness';

function createNativeGrok(env: ForkTestEnvironment, options: { tokenStream?: boolean } = {}) {
  const sessions = new Map<string, string[]>([['grok-source', []]]);
  const operations: Array<{ method: string; params: Record<string, any> }> = [];
  const prompts: Array<{ sessionId: string; context: string[] }> = [];
  const directory = (id: string) => path.join(env.root, 'grok', 'sessions', encodeURIComponent(env.root), id);
  const sourceFile = path.join(directory('grok-source'), 'updates.jsonl');
  let ordinal = 0;
  jest.mocked(spawn).mockImplementation(() => createNativeRpcProcess(async (method, params, notify) => {
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
      return { newSessionId: 'grok-child', parentSessionId: params.sourceSessionId, newCwd: params.newCwd };
    }
    if (method === 'session/load') return {};
    if (method === 'session/prompt') {
      const sessionId = params.sessionId as string;
      const context = sessions.get(sessionId)!;
      prompts.push({ sessionId, context: [...context] });
      const turn = ++ordinal;
      const assistantId = `grok-assistant-${turn}`;
      const promptId = `grok-prompt-${turn}`;
      // Native Grok streams one chunk per token, each with a fresh eventId and the turn's promptId.
      const assistantChunks = options.tokenStream
        ? ['Reply', ` ${turn}`].map((text, index) => ({
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, _meta: { eventId: `grok-event-${turn}-${index}`, promptId },
        }))
        : [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Reply ${turn}` }, _meta: { eventId: assistantId } }];
      const updates = [
        { sessionUpdate: 'user_message_chunk', messageId: `grok-user-${turn}`, content: { type: 'text', text: params.prompt[0].text }, _meta: { promptIndex: context.length } },
        ...assistantChunks,
        { sessionUpdate: 'turn_completed', ...(options.tokenStream ? { prompt_id: promptId } : {}) },
      ];
      const records = updates.map(update => ({ method: 'session/update', params: { sessionId, update }, timestamp: 1_700_000_000 + turn }));
      await fs.appendFile(path.join(directory(sessionId), 'updates.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
      for (const record of records) notify(record.method, record.params);
      context.push(assistantId);
      return { stopReason: 'end_turn' };
    }
    throw new Error(`Unexpected Grok method: ${method}`);
  }));
  return { backend: new GrokExecutionBackend(env.host), sessions, operations, prompts, sourceFile };
}

describe('Grok fork integration', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); jest.mocked(spawn).mockReset(); });

  it('translates a live metadata-only ID to the native prompt boundary and loads only the child', async () => {
    const native = createNativeGrok(env);
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    await env.send(source, 'Remember pears');
    expect(selected.assistantMessageId).toBe('grok-assistant-1');
    const original = await fs.readFile(native.sourceFile, 'utf8');
    const child = await env.fork(source, selected);
    expect(child?.messages).toHaveLength(2);
    const fork = await env.open(native.backend, child!);
    await env.send(fork, 'Continue here');
    expect(native.operations.find(operation => operation.method === '_x.ai/session/fork')?.params).toEqual({
      newCwd: env.root, newModelId: 'grok-code-fast-1', sourceCwd: env.root,
      sourceSessionId: 'grok-source', targetPromptIndex: 1,
    });
    const load = native.operations.find(operation => operation.method === 'session/load');
    expect(load?.params).toMatchObject({ sessionId: 'grok-child', _meta: expect.any(Object) });
    expect(native.prompts.at(-1)).toEqual({ sessionId: 'grok-child', context: ['grok-assistant-1'] });
    expect(child!.sessionId).toBe('grok-child');
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(original);
    await env.send(source, 'Keep original going');
    expect(native.prompts.at(-1)).toEqual({ sessionId: 'grok-source', context: ['grok-assistant-1', 'grok-assistant-2'] });
  });

  it('keeps a token-streamed reply in one message and forks at its prompt ID checkpoint', async () => {
    const native = createNativeGrok(env, { tokenStream: true });
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    await env.send(source, 'Remember pears');
    expect(selected.assistantMessageId).toBe('grok-prompt-1');
    const child = await env.fork(source, selected);
    const fork = await env.open(native.backend, child!);
    await env.send(fork, 'Continue here');
    expect(native.operations.find(operation => operation.method === '_x.ai/session/fork')?.params)
      .toMatchObject({ sourceSessionId: 'grok-source', targetPromptIndex: 1 });
    expect(native.prompts.at(-1)).toEqual({ sessionId: 'grok-child', context: ['grok-assistant-1'] });
  });

  it('refuses a missing checkpoint before native fork or prompt dispatch', async () => {
    const native = createNativeGrok(env);
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    const child = await env.fork(source, selected);
    await fs.writeFile(native.sourceFile, '');
    const fork = await env.open(native.backend, child!);
    await expect(env.send(fork, 'Cannot continue')).rejects.toThrow(/checkpoint/i);
    expect(native.sessions.has('grok-child')).toBe(false);
    expect(native.prompts).toHaveLength(1);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe('');
  });
});
