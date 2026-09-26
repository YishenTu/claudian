import * as fs from 'node:fs/promises';
import * as path from 'node:path';

jest.mock('cross-spawn', () => jest.fn());
import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import spawn from 'cross-spawn';

import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';

async function readRecords(file: string) {
  return (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function createNativePi(env: ForkTestEnvironment) {
  const sourceFile = path.join(env.root, 'source.jsonl');
  await fs.writeFile(sourceFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-source', cwd: env.root }) + '\n');
  const realSpawn = jest.requireActual<typeof spawn>('cross-spawn');
  let mismatch = false;
  jest.mocked(spawn).mockImplementation((_command, args = [], options = {}) => realSpawn(
    process.execPath,
    [path.resolve('tests/fixtures/providers/pi/PiSessionProcess.mjs'), ...args],
    { ...options, env: { ...options.env, CLAUDIAN_TEST_PI_ROOT: env.root, CLAUDIAN_TEST_PI_MISMATCH: mismatch ? '1' : '0' } },
  ));
  const backend = new PiExecutionBackend(env.host, { commandCatalog: new PiCommandCatalog() });
  return {
    backend, sourceFile,
    contexts: () => readRecords(path.join(env.root, 'contexts.jsonl')),
    reportMismatchedState: () => { mismatch = true; },
  };
}

describe('Pi fork integration', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); jest.mocked(spawn).mockReset(); });

  it.each([1, 2])('continues a fork of live reply %i using an isolated native file and accepted input prefix', async checkpoint => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const first = await env.send(source, 'Remember apples');
    const second = await env.send(source, 'Remember pears');
    expect(first.assistantMessageId).toBe('pi-assistant-1');
    expect(second.assistantMessageId).toBe('pi-assistant-2');
    const sourceBefore = await fs.readFile(native.sourceFile, 'utf8');
    const child = await env.fork(source, checkpoint === 1 ? first : second);
    expect(child).toBeDefined();
    expect(child!.messages.map(message => message.id)).toEqual(source.conversation.messages.slice(0, checkpoint * 2).map(message => message.id));
    const fork = await env.open(native.backend, child!);
    await env.send(fork, 'Continue here');
    expect((await native.contexts()).at(-1)?.ids).toEqual(
      ['pi-user-1', 'pi-assistant-1', 'pi-user-2', 'pi-assistant-2'].slice(0, checkpoint * 2),
    );
    expect((await native.contexts()).at(-1)?.file).not.toBe(native.sourceFile);
    expect(env.repository.getSync(child!.id)!.sessionId).not.toBe(source.conversation.sessionId);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBefore);
    await env.send(source, 'Keep original going');
    expect((await native.contexts()).at(-1)).toEqual({ file: native.sourceFile, ids: ['pi-user-1', 'pi-assistant-1', 'pi-user-2', 'pi-assistant-2'] });
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
    expect(await native.contexts()).toHaveLength(1);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(unavailableHistory);
  });
  it('rejects a mismatched native session before sending a fork prompt', async () => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const message = await env.send(source, 'Remember apples');
    const child = await env.fork(source, message);
    const sourceBefore = await fs.readFile(native.sourceFile, 'utf8');
    native.reportMismatchedState();
    const fork = await env.open(native.backend, child!);

    await expect(env.send(fork, 'Must not reach the wrong session')).rejects.toThrow(/unexpected native session/i);
    expect(await native.contexts()).toHaveLength(1);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBefore);
  });

});
