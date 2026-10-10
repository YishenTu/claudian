import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';

import { NativePeer } from '@test/helpers/deepseek/NativePeer';

import { DeepSeekHostProcess } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

const FAKE_DSH = resolve(__dirname, '../../../../fixtures/providers/deepseek/runtime/FakeDeepSeekCLI.mjs');

interface Invocation { pid: number; cwd: string; args: string[] }

// DeepSeek refuses to start on Windows; only the refusal is qualified there.
(process.platform === 'win32' ? describe : describe.skip)('on Windows', () => {
  it('refuses to start the native Host', async () => {
    await expect(DeepSeekHostProcess.start({ cliPath: FAKE_DSH, cwd: tmpdir(), environment: process.env }, new AbortController().signal))
      .rejects.toThrow(/not yet qualified on Windows/);
  });
});

(process.platform === 'win32' ? describe.skip : describe)('native Host process', () => {
  let root: string;
  let home: string;
  let log: string;
  let peer: NativePeer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'deepseek host process '));
    home = join(root, 'dsh home');
    log = join(root, 'invocations.log');
    await mkdir(join(home, 'profiles', 'web'), { recursive: true });
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}');
    peer = new NativePeer();
    peer.onCall = method => method === 'session/list' ? { items: [] } : `${method} answered`;
    await peer.open();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  });

  const start = (mode: string, extra: NodeJS.ProcessEnv = {}, signal = new AbortController().signal): Promise<DeepSeekHostProcess> => DeepSeekHostProcess.start({
    cliPath: FAKE_DSH, cwd: root,
    environment: { ...process.env, DSH_HOME: home, FAKE_DSH_LOG: log, FAKE_DSH_MODE: mode, FAKE_DSH_URL: peer.url, ...extra },
  }, signal);

  const invocations = async (): Promise<Invocation[]> => {
    const text = await readFile(log, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  };

  const launched = async (): Promise<Invocation> => {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 10))) {
      const host = (await invocations()).find(entry => !entry.args.includes('--version'));
      if (host) return host;
    }
    throw new Error('Fake dsh never launched its Host.');
  };

  const artifactRoot = (invocation: Invocation): string => dirname(invocation.args[invocation.args.indexOf('--patch') + 1]);

  const expectGone = async (invocation: Invocation): Promise<void> => {
    expect(() => process.kill(invocation.pid, 0)).toThrow();
    await expect(access(artifactRoot(invocation))).rejects.toThrow();
  };

  it.each([
    ['after the origin', (url: string) => new URL(url).origin.length],
    ['inside the login token', (url: string) => url.length - 3],
  ])('connects to the launch URL split %s and removes the process and its launch files on dispose', async (_split, offset) => {
    const hostProcess = await start('serve', { FAKE_DSH_SPLIT: String(offset(peer.url)) });
    const exited = jest.fn();
    hostProcess.onExit(exited);
    const invocation = await launched();
    try {
      expect(invocation).toMatchObject({ cwd: await realpath(root), args: ['--profile', 'web', '--patch', expect.any(String), '--no-open', '--port', '0'] });
      expect(await hostProcess.client.call('session/modelCatalog')).toBe('session/modelCatalog answered');
      await hostProcess.writePrompt('claudian', 'Live prompt');
      expect(await readFile(join(artifactRoot(invocation), 'prompts', 'claudian.txt'), 'utf8')).toBe('Live prompt');
    } finally { await hostProcess.dispose(); }
    await expectGone(invocation);
    expect(exited).not.toHaveBeenCalled();
  });

  it('reports an exit once its owner\'s end of stdin closes, and stays silent for exits caused by disposal', async () => {
    const hostProcess = await start('serve');
    const invocation = await launched();
    try {
      const exited = new Promise<void>(resolve => hostProcess.onExit(resolve));
      // Claudian's end of the pipe closing is what the bundled lifecycle plugin tethers the native Host to.
      (hostProcess as unknown as { process: { stdin: Writable } }).process.stdin.end();
      await exited;
      expect(() => process.kill(invocation.pid, 0)).toThrow();
    } finally { await hostProcess.dispose(); }
    await expectGone(invocation);

    const disposed = await start('serve');
    const late = jest.fn();
    const disposal = disposed.dispose();
    disposed.onExit(late);
    await disposal;
    expect(late).not.toHaveBeenCalled();
  });

  it('refuses a missing Web profile before running the CLI', async () => {
    await rm(join(home, 'profiles'), { recursive: true });
    await expect(start('serve')).rejects.toThrow(/Web profile is unavailable/);
    expect(await invocations()).toEqual([]);
  });

  it('refuses an unsupported native version without launching the Host', async () => {
    await expect(start('serve', { FAKE_DSH_VERSION: '0.2.0-rc.1' })).rejects.toThrow(/requires 0\.2\.0-rc\.2/);
    expect((await invocations()).map(entry => entry.args)).toEqual([['--version']]);
  });

  it('fails when the Host exits before printing its URL and removes its launch files', async () => {
    await expect(start('exit')).rejects.toThrow(/exited before becoming ready/);
    await expectGone(await launched());
  });

  it('stops a Host that never becomes ready when startup is cancelled or times out', async () => {
    const cancel = new AbortController();
    const cancelled = start('hang', {}, cancel.signal);
    const first = await launched();
    cancel.abort();
    await expect(cancelled).rejects.toThrow('DeepSeek startup cancelled.');
    await expectGone(first);

    await rm(log);
    const deadline = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const timing = start('hang');
    const second = await launched();
    deadline.abort();
    await expect(timing).rejects.toThrow(/timed out while loading the native profile/);
    await expectGone(second);
  });
});
