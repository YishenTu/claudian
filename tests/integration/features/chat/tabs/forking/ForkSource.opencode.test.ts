// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';

import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

function writeNativeOpencode(root: string, options: { version: string; failFork?: boolean }): string {
  const cli = writeOpencodeNativePeer(path.join(root, 'opencode.cjs'), {
    scenario: 'history', ...options, logFile: path.join(root, 'native.log'), forkId: 'ses-child',
  });
  const diag = JSON.stringify(path.join(root, 'diag.log'));
  appendFileSync(cli, `
;(() => { const f = require('fs'); const d = (e) => f.appendFileSync(${diag}, JSON.stringify({ e, pid: process.pid, argv: process.argv.slice(2).join(' '), t: Date.now() }) + '\\n');
d('boot'); process.stdin.on('end', () => d('stdin-end')); process.on('exit', () => d('exit'));
const h = require('http'); const o = h.Server.prototype.close; h.Server.prototype.close = function (...a) { d('server-close-called'); this.on('close', () => d('server-closed')); return o.apply(this, a); };
setInterval(() => { const hs = process._getActiveHandles().map(x => x.constructor.name); d('alive ' + hs.join(',')); }, 500).unref(); })();
`);
  return cli;
}

function dumpDiag(label: string, root: string, t0: number): void {
  const file = path.join(root, 'diag.log');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
  process.stderr.write(`[DIAG ${label}] t0=${t0} end=+${Date.now() - t0}\n` + lines.map(l => { const j = JSON.parse(l); return `  +${j.t - t0} ${j.pid} ${j.argv} ${j.e}`; }).join('\n') + '\n');
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
  // Windows can keep a just-exited executable's image (the copied node.exe) locked briefly after the process is gone.
  // Only async `rm` retries that: Node 24's native `rmSync` neither retries "Permission denied" nor waits between attempts on Windows.
  afterEach(() => { const t = Date.now(); return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).finally(() => process.stderr.write(`[DIAG rm] ${Date.now() - t}ms` + "\n")); });

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
    const t0 = Date.now();
    await expect(fork(cliPath, { ...process.env, PATH: '/restricted' })).resolves.toMatchObject({
      sessionId: 'ses-child',
    });
    dumpDiag('sibling', root, t0);
    const launch = readNativeLog(root).find(entry => 'launch' in entry);
    expect(String(launch?.path).split(path.delimiter)).toContain(root);
    expect(readNativeLog(root)).toContainEqual({ method: 'POST', route: '/api/session/ses-source/fork' });
    // The auxiliary server has exited before the fork resolves; only the OS may still hold its image.
    expect(() => process.kill(Number(launch?.launch), 0)).toThrow();
  });

  it('reports native fork errors and shuts down the auxiliary server', async () => {
    const cliPath = writeNativeOpencode(root, { version: '2.0.12', failFork: true });
    const t0 = Date.now();
    await expect(fork(cliPath)).rejects.toThrow();
    dumpDiag('failFork', root, t0);
    const log = readNativeLog(root);
    const launch = log.find(entry => 'launch' in entry);
    expect(log).toContainEqual({ method: 'POST', route: '/api/session/ses-source/fork' });
    // Shutdown completes before the fork rejects, so the process is already gone.
    expect(() => process.kill(Number(launch?.launch), 0)).toThrow();
  });

  it('rejects an OpenCode v1 CLI before starting a native server', async () => {
    const cliPath = writeNativeOpencode(root, { version: '1.18.31' });
    const t0 = Date.now();
    await expect(fork(cliPath)).rejects.toThrow('OpenCode v1 is no longer supported');
    dumpDiag('v1', root, t0);
    expect(readNativeLog(root)).toEqual([]);
  });
});
