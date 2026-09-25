import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { PiRPCSessionKernel } from '@/providers/pi/execution/PiExecutionKernel';
import type { PiRPCRecord } from '@/providers/pi/runtime/PiRPCTransport';

jest.setTimeout(10_000);

describe('Pi execution kernel with an external protocol process', () => {
  let root: string;
  let kernel: PiRPCSessionKernel;
  let events: PiRPCRecord[];
  let closed: Promise<Error | undefined>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-pi-kernel-'));
    await fs.writeFile(path.join(root, 'source.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'pi-source', cwd: root }) + '\n');
    events = [];
    let resolveClose!: (error?: Error) => void;
    closed = new Promise(resolve => { resolveClose = resolve; });
    kernel = new PiRPCSessionKernel({
      command: process.execPath,
      args: [path.resolve('tests/fixtures/providers/pi/PiSessionProcess.mjs')],
      cwd: root,
      env: { ...process.env, CLAUDIAN_TEST_PI_ROOT: root },
      processKey: 'fixture', sessionTarget: null,
    }, {
      onClose: error => resolveClose(error),
      onEvent: event => events.push(event),
      onExtensionChunk: () => undefined,
      onExtensionRequest: () => true,
    }, null);
    kernel.start();
  });

  afterEach(async () => {
    await kernel.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('routes response payloads and streamed events through the real transport', async () => {
    await expect(kernel.request('get_state', {}, 3_000)).resolves.toMatchObject({
      sessionId: 'pi-source', sessionFile: path.join(root, 'source.jsonl'),
    });
    await kernel.request('prompt', { message: 'Remember apples' }, 3_000);
    // An echo after the prompt is an ordered protocol barrier for its preceding events.
    await expect(kernel.request('fixture_echo', { value: 'complete' }, 3_000)).resolves.toEqual({ value: 'complete' });
    expect(events).toEqual([
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { text_delta: 'Reply 1' } },
      { type: 'agent_end' },
    ]);
  });

  it('routes an extension request back to the process as cancellation when no renderer is available', async () => {
    await expect(kernel.request('fixture_extension', {}, 3_000)).resolves.toMatchObject({
      type: 'extension_ui_response', id: 'dialog-1', cancelled: true,
    });
    expect(events).toEqual([]);
  });

  it('rejects pending work and releases the child process on shutdown', async () => {
    const { pid } = await kernel.request<{ pid: number }>('get_state', {}, 3_000);
    const pending = kernel.request('fixture_hang', {}, 3_000).catch((error: Error) => error);
    await kernel.request('fixture_echo', { value: 'waiting' }, 3_000);
    expect(events).toContainEqual({ type: 'fixture_waiting' });

    await kernel.shutdown();
    expect(await pending).toMatchObject({ message: expect.stringMatching(/disposed|closed/i) });
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => kernel.request('get_state')).toThrow('Pi execution kernel is not started');
  });

  it('surfaces unexpected process exit to both pending work and the lifecycle observer', async () => {
    await expect(kernel.request('fixture_exit', {}, 3_000)).rejects.toThrow(/17|closed/i);
    await expect(closed).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/17|closed/i) }));
    expect(kernel.getStderrSnapshot()).toContain('fixture requested exit');
  });
});
