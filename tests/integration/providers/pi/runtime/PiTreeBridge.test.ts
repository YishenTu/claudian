import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PI_TREE_EXTENSION_SOURCE } from '@/providers/pi/runtime/PiTreeBridge';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

/** Loads the embedded extension as Pi does and inspects the session `manager` reports. */
async function inspect(nativeSessionFile: string, requestSessionFile: string): Promise<Record<string, unknown>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-tree-extension-'));
  cleanup.push(dir);
  const file = path.join(dir, 'tree.mjs');
  await fs.writeFile(file, PI_TREE_EXTENSION_SOURCE);
  const extension = await import(/* @vite-ignore */ pathToFileURL(file).href) as { default: (pi: unknown) => void };
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  extension.default({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } });
  const statuses: string[] = [];
  await handler(JSON.stringify({ id: 'request', operation: 'inspect', sessionFile: requestSessionFile, sessionId: 's1' }), {
    isIdle: () => true,
    sessionManager: { getLeafId: () => 'leaf', getSessionFile: () => nativeSessionFile, getSessionId: () => 's1' },
    ui: { setStatus: (_key: string, text: string) => statuses.push(text) },
  });
  return JSON.parse(statuses[0]) as Record<string, unknown>;
}

describe('Pi tree extension', () => {
  // A relative `sessionDir` makes Pi name its file relative to its working directory; Claudian holds it absolute.
  it('accepts the absolute path of a session file Pi names relative to its working directory', async () => {
    const absolute = path.resolve('sessions', 's1.jsonl');
    await expect(inspect(path.join('sessions', 's1.jsonl'), absolute))
      .resolves.toEqual({ cancelled: false, leafId: 'leaf', sessionFile: absolute, sessionId: 's1' });
  });

  // Pi resolves against its real working directory, while Claudian keeps the vault path it was given.
  it('reports the session file as Claudian names it through a symlinked directory', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-tree-symlink-')));
    cleanup.push(root);
    await fs.mkdir(path.join(root, 'real', 'sessions'), { recursive: true });
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'));
    const linked = path.join(root, 'link', 'sessions', 's1.jsonl');
    await expect(inspect(path.join(root, 'real', 'sessions', 's1.jsonl'), linked))
      .resolves.toMatchObject({ cancelled: false, sessionFile: linked });
  });

  it('rejects a request for another session file', async () => {
    await expect(inspect(path.resolve('sessions', 's1.jsonl'), path.resolve('sessions', 's2.jsonl')))
      .resolves.toEqual({ error: 'Pi session changed before tree navigation', uncertain: false });
  });
});
