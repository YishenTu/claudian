import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';
import type { PiExecutionKernelFactory } from '@/providers/pi/execution/PiExecutionKernel';

import { createForkTestEnvironment, type ForkTestEnvironment } from './ProviderForkTestHarness';

async function readRecords(file: string) {
  return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function createNativePi(env: ForkTestEnvironment) {
  const sourceFile = path.join(env.root, 'source.jsonl');
  await fs.writeFile(sourceFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-source', cwd: env.root }) + '\n');
  let nextTurn = 0;
  const contexts: Array<{ file: string; ids: string[] }> = [];
  const createKernel: PiExecutionKernelFactory = (launchSpec, callbacks) => {
    const file = launchSpec.sessionTarget ?? sourceFile;
    return {
      launchSpec, start() {}, send() {}, async shutdown() {}, getStderrSnapshot: () => '',
      async request<T>(type: string, payload: Record<string, unknown> = {}) {
        if (type === 'get_state') {
          const [header] = await readRecords(file);
          // Native get_state does not return the current leaf ID.
          return { sessionId: header.id, sessionFile: file } as T;
        }
        if (type === 'prompt') {
          const records = await readRecords(file);
          contexts.push({ file, ids: records.filter(record => record.type === 'message').map(record => record.id) });
          const ordinal = ++nextTurn;
          const entries = [
            { type: 'message', id: `pi-user-${ordinal}`, parentId: records.at(-1)?.type === 'message' ? records.at(-1).id : null,
              message: { role: 'user', content: payload.message } },
            { type: 'message', id: `pi-assistant-${ordinal}`, parentId: `pi-user-${ordinal}`,
              message: { role: 'assistant', content: [{ type: 'text', text: `Reply ${ordinal}` }] } },
          ];
          await fs.appendFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
          callbacks.onEvent({ type: 'agent_start' });
          callbacks.onEvent({ type: 'message_update', assistantMessageEvent: { text_delta: `Reply ${ordinal}` } });
          callbacks.onEvent({ type: 'agent_end' });
        }
        return {} as T;
      },
    };
  };
  const backend = new PiExecutionBackend(env.host, { commandCatalog: new PiCommandCatalog() }, { createKernel });
  return { backend, contexts, sourceFile };
}

describe('Pi fork integration', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); });

  it.each([1, 2])('continues a fork of live reply %i using an isolated native file and accepted input prefix', async checkpoint => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const first = await env.send(source, 'Remember apples');
    const second = await env.send(source, 'Remember pears');
    expect(first.assistantMessageId).toBe('pi-assistant-1');
    expect(second.assistantMessageId).toBe('pi-assistant-2');
    const sourceBefore = await fs.readFile(native.sourceFile, 'utf8');
    const sourceLedger = await env.repository.getConversationInputLedger(source.conversation.id);
    const child = await env.fork(source, checkpoint === 1 ? first : second);
    expect(child).toBeDefined();
    expect(child!.messages.map(message => message.id)).toEqual(source.conversation.messages.slice(0, checkpoint * 2).map(message => message.id));
    expect((await env.repository.getConversationInputLedger(child!.id))?.records.map(record => record.canonicalText))
      .toEqual(['Remember apples', 'Remember pears'].slice(0, checkpoint));
    const fork = await env.open(native.backend, child!);
    await env.send(fork, 'Continue here');
    expect(native.contexts.at(-1)?.ids).toEqual(
      ['pi-user-1', 'pi-assistant-1', 'pi-user-2', 'pi-assistant-2'].slice(0, checkpoint * 2),
    );
    expect(native.contexts.at(-1)?.file).not.toBe(native.sourceFile);
    expect(child!.sessionId).not.toBe(source.conversation.sessionId);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBefore);
    expect(await env.repository.getConversationInputLedger(source.conversation.id)).toEqual(sourceLedger);
    await env.send(source, 'Keep original going');
    expect(native.contexts.at(-1)).toEqual({ file: native.sourceFile, ids: ['pi-user-1', 'pi-assistant-1', 'pi-user-2', 'pi-assistant-2'] });
  });

  it('reports an unavailable native checkpoint without sending the child prompt or changing source history', async () => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const message = await env.send(source, 'Remember apples');
    const child = await env.fork(source, message);
    const [header] = await readRecords(native.sourceFile);
    const unavailableHistory = JSON.stringify(header) + '\n';
    await fs.writeFile(native.sourceFile, unavailableHistory);
    const fork = await env.open(native.backend, child!);
    await expect(env.send(fork, 'Cannot continue')).rejects.toThrow(/checkpoint/i);
    expect(native.contexts).toHaveLength(1);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(unavailableHistory);
  });
});
