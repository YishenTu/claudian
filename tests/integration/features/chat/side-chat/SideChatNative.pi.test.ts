import * as fs from 'node:fs/promises';
import * as path from 'node:path';

jest.mock('cross-spawn', () => jest.fn());
import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import spawn from 'cross-spawn';

import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';

import { capturedImage, traceSideChild } from './SideChatNativeTracer';

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

  it('continues in a no-session process from captured context without writing a child file', async () => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    checkpoint.content = 'Reply 1';
    source.conversation.messages[0].images = [capturedImage];
    source.conversation.messages[0].executionInput = {
      schemaVersion: 1, canonicalText: 'Remember A with expanded instructions',
      context: { browserSelection: { source: 'browser', selectedText: 'Captured passage 48271' } },
    };
    checkpoint.toolCalls = [{
      id: 'read-capture', name: 'Read', input: { path: 'transient.txt' },
      status: 'completed', result: 'Unique captured value: project-48271',
    }];
    await env.send(source, 'Remember A2');
    const filesBefore = await fs.readdir(env.root);
    const sourceBytes = await fs.readFile(native.sourceFile, 'utf8');
    const conversationsBefore = env.repository.list().map(conversation => conversation.id);

    const child = await traceSideChild(env, source, checkpoint, native.backend);
    await child!.send('Also remember B');
    const afterFirst = (await native.contexts()).at(-1);
    expect(afterFirst).toMatchObject({ ids: [], file: null });
    expect(afterFirst?.text).toContain('Remember A');
    expect(afterFirst?.text).toContain('Reply 1');
    expect(afterFirst?.text).toContain('project-48271');
    expect(afterFirst?.text).toContain('expanded instructions');
    expect(afterFirst?.text).toContain('Captured passage 48271');
    expect(afterFirst?.images).toEqual([{ type: 'image', mimeType: 'image/png', data: capturedImage.data }]);
    expect(afterFirst?.text).not.toContain('Remember A2');
    expect(child!.session.canCool()).toBe(false);

    await child!.send('Use A and B');
    const afterSecond = (await native.contexts()).at(-1);
    expect(afterSecond?.file).toBe(afterFirst?.file);
    expect(afterSecond?.ids).toEqual(['pi-user-3', 'pi-assistant-3']);
    expect(afterSecond?.text).toBe('Use A and B');
    expect(afterSecond?.images).toEqual([]);
    expect(await fs.readdir(env.root)).toEqual(filesBefore);
    expect(await fs.readFile(native.sourceFile, 'utf8')).toBe(sourceBytes);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual(conversationsBefore);

    await env.send(source, 'Continue main');
    expect((await native.contexts()).at(-1)).toEqual({
      file: native.sourceFile,
      ids: ['pi-user-1', 'pi-assistant-1', 'pi-user-2', 'pi-assistant-2'],
    });
    await child!.dispose();
  });

  it('uses captured messages after the native source checkpoint disappears', async () => {
    const native = await createNativePi(env);
    const source = await env.open(native.backend);
    const checkpoint = await env.send(source, 'Remember A');
    checkpoint.content = 'Reply 1';
    const [header] = await readRecords(native.sourceFile);
    const child = await traceSideChild(env, source, checkpoint, native.backend, {
      beforeStart: async () => { await fs.writeFile(native.sourceFile, JSON.stringify(header) + '\n'); },
    });
    const turn = await child!.send('Continue from the capture');
    expect(turn.terminal).toBe('turn_completed');
    expect((await native.contexts()).at(-1)?.text).toContain('Remember A');
    expect((await native.contexts()).at(-1)?.text).toContain('Reply 1');
    expect(await readRecords(native.sourceFile)).toEqual([header]);
    await child!.dispose();
  });
});
