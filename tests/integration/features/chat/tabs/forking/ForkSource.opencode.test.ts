import { constants, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

/** A loopback `opencode serve` stand-in that records its launch and every request. */
function writeNativeOpencode(root: string, options: { version: string; failFork?: boolean }): string {
  // A `.cjs` launcher runs through its shebang on every platform, as the shared-server suite's does.
  const cliPath = path.join(root, 'opencode.cjs');
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const log = (entry) => fs.appendFileSync(${JSON.stringify(path.join(root, 'native.log'))}, JSON.stringify(entry) + '\\n');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(`opencode v${options.version}`)}); return; }
log({ launch: process.pid, path: process.env.PATH });
let childMessages;
const sourceMessages = [
  { id: 'msg-user', type: 'user', time: { created: 1 }, text: 'Remember apples' },
  { id: 'msg-assistant', type: 'assistant', time: { created: 2 }, content: [{ type: 'text', text: 'Reply' }] },
];
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://127.0.0.1').pathname;
  log({ method: req.method, route });
  let data;
  if (route === '/api/session/ses-source/message') data = sourceMessages;
  else if (route === '/api/session/ses-child/message' && childMessages) data = childMessages;
  else if (route === '/api/session/ses-source/fork' && req.method === 'POST') {
    if (${options.failFork ? 'true' : 'false'}) { res.writeHead(500).end('Native fork failed'); return; }
    childMessages = sourceMessages.map(message => ({ ...message, id: message.id + '-child' }));
    data = { id: 'ses-child' };
  } else { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data, cursor: {} }));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o700 });
  return cliPath;
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
    writeFileSync(databasePath, '');
    return new OpencodeConversationHistoryService().buildForkProviderState(
      'ses-source',
      'msg-assistant',
      { databasePath },
      root,
      { settings: { providerConfigs: { opencode: { cliPath } } }, environment: { ...environment, OPENCODE_DB: databasePath } },
    );
  }

  it('keeps a configured CLI sibling Node directory on PATH when forking', async () => {
    const cliPath = writeNativeOpencode(root, { version: '2.0.12' });
    // The sibling runtime is the one the CLI's `env node` shebang must resolve.
    copyFileSync(process.execPath, path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'), constants.COPYFILE_FICLONE);
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
