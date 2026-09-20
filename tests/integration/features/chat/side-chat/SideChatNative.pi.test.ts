import * as fs from 'node:fs/promises';
import * as path from 'node:path';

jest.mock('cross-spawn', () => jest.fn());
import spawn from 'cross-spawn';

import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';

import { createForkTestEnvironment, type ForkTestEnvironment } from '../tabs/ProviderForkTestHarness';
import { traceSideChild } from './SideChatNativeTracer';

async function readRecords(file: string) {
  return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function createNativePi(env: ForkTestEnvironment) {
  const sourceFile = path.join(env.root, 'source.jsonl');
  await fs.writeFile(sourceFile, JSON.stringify({ cwd: env.root, id: 'pi-source', type: 'session', version: 3 }) + '\n');
  const realSpawn = jest.requireActual<typeof spawn>('cross-spawn');
  jest.mocked(spawn).mockImplementation((_command, args = [], options = {}) => realSpawn(
    process.execPath,
    [path.resolve('tests/fixtures/providers/pi/PiSessionProcess.mjs'), ...args],
    { ...options, env: { ...options.env, CLAUDIAN_TEST_PI_MISMATCH: '0', CLAUDIAN_TEST_PI_ROOT: env.root } },
  ));
  return {
    backend: new PiExecutionBackend(env.host, { commandCatalog: new PiCommandCatalog() }),
    contexts: () => readRecords(path.join(env.root, 'contexts.jsonl')),
    sourceFile,
  };
}

describe('Pi side-chat native child', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); jest.mocked(spawn).mockReset(); });

  it('continues an isolated native child file from the captured checkpoint without touching the source', async () => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    await env.send(source, 'Remember A2');
    const sourceBytes = await fs.readFile(native.sourceFile, 'utf8');
    const sourceLedger = await env.repository.getConversationInputLedger(source.conversation.id);
    const conversationsBefore = env.repository.list().map(conversation => conversation.id);

    const child = await traceSideChild(env, source, checkpoint, native.backend);
    await child!.send('Also remember B');
    const afterFirst = (await native.contexts()).at(-1);
    expect(afterFirst?.ids).toEqual(['pi-user-1', 'pi-assistant-1']);
    expect(afterFirst?.file).not.toBe(native.sourceFile);

    await child!.send('Use A and B');
    const afterSecond = (await native.contexts()).at(-1);
    expect(afterSecond?.file).toBe(afterFirst?.file);
    expect(afterSecond?.ids).toEqual(['pi-user-1', 'pi-assistant-1', 'pi-user-3', 'pi-assistant-3']);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBytes);
    expect(await env.repository.getConversationInputLedger(source.conversation.id)).toEqual(sourceLedger);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual(conversationsBefore);

    await env.send(source, 'Continue main');
    expect((await native.contexts()).at(-1)).toEqual({
      file: native.sourceFile,
      ids: ['pi-user-1', 'pi-assistant-1', 'pi-user-2', 'pi-assistant-2'],
    });
    await child!.dispose();
  });

  it('reports an unavailable captured checkpoint without sending the child prompt', async () => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    const [header] = await readRecords(native.sourceFile);
    const child = await traceSideChild(env, source, checkpoint, native.backend, {
      beforeStart: async () => { await fs.writeFile(native.sourceFile, JSON.stringify(header) + '\n'); },
    });
    const turn = await child!.send('Cannot start');
    expect(turn.terminal).toBe('execution_error');
    expect(turn.errorMessage).toMatch(/checkpoint/i);
    expect(await native.contexts()).toHaveLength(1);
    await child!.dispose();
  });
});
