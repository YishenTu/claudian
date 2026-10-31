// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';

import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

function writeNativeOpencode(root: string, options: { version: string; failFork?: boolean }): string {
  return writeOpencodeNativePeer(path.join(root, 'opencode.cjs'), {
    scenario: 'history', ...options, logFile: path.join(root, 'native.log'), forkId: 'ses-child',
  });
}

function readNativeLog(root: string): Array<Record<string, unknown>> {
  const file = path.join(root, 'native.log');
  return existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    : [];
}

describe('OpenCode fork integration', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-opencode-fork-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function fork(cliPath: string, environment: NodeJS.ProcessEnv = process.env) {
    const databasePath = path.join(root, 'opencode.db');
    writeFileSync(databasePath, JSON.stringify({ 'ses-source': { messages: [
      { id: 'msg-user', type: 'user', time: { created: 1 }, text: 'Remember apples' },
      { id: 'msg-assistant', type: 'assistant', time: { created: 2 }, content: [{ type: 'text', text: 'Reply' }] },
    ] } }));
    return new OpencodeConversationHistoryService().buildForkProviderState(
      'ses-source',
      'msg-assistant',
      { databasePath },
      root,
      { config: { cliPath }, environmentText: '', environment: { ...environment, OPENCODE_DB: databasePath } },
    );
  }

  it('keeps a configured CLI sibling Node directory on PATH when forking', async () => {
    const cliPath = writeNativeOpencode(root, { version: '2.0.12' });
    // The sibling runtime is the one the CLI's `env node` shebang must resolve.
    // POSIX links the runtime: executing a freshly written binary can fail with ETXTBSY.
    if (process.platform === 'win32') copyFileSync(process.execPath, path.join(root, 'node.exe'));
    else symlinkSync(process.execPath, path.join(root, 'node'));
    await expect(fork(cliPath, { ...process.env, PATH: '/restricted' })).resolves.toMatchObject({
      sessionId: 'ses-child',
    });
    const launch = readNativeLog(root).find(entry => 'launch' in entry);
    expect(String(launch?.path).split(path.delimiter)).toContain(root);
    expect(readNativeLog(root)).toContainEqual({ method: 'POST', route: '/api/session/ses-source/fork' });
  });

  it('reports native fork errors and shuts down the auxiliary server', async () => {
    const cliPath = writeNativeOpencode(root, { version: '2.0.12', failFork: true });
    await expect(fork(cliPath)).rejects.toThrow();
    const log = readNativeLog(root);
    const launch = log.find(entry => 'launch' in entry);
    expect(log).toContainEqual({ method: 'POST', route: '/api/session/ses-source/fork' });
    // Shutdown completes before the fork rejects, so the process is already gone.
    expect(() => process.kill(Number(launch?.launch), 0)).toThrow();
  });

  it('rejects an OpenCode v1 CLI before starting a native server', async () => {
    const cliPath = writeNativeOpencode(root, { version: '1.18.31' });
    await expect(fork(cliPath)).rejects.toThrow('OpenCode v1 is no longer supported');
    expect(readNativeLog(root)).toEqual([]);
  });
});
