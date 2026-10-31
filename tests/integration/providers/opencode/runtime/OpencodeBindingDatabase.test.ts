import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { resolveOpencodeBindingDatabase } from '@/providers/opencode/runtime/OpencodeBindingDatabase';
import { resolveOpencodeDatabasePath } from '@/providers/opencode/runtime/OpencodePaths';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));

const target: ExecutionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' };
const env = { HOME: '/home/test', XDG_DATA_HOME: '/home/test/data' };

it('resolves a native binding inside its native data root without the WSL policy', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'claudian-opencode-binding-')));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorded = path.join(root, 'data', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  fs.writeFileSync(recorded, '');
  const native = { HOME: root, XDG_DATA_HOME: path.join(root, 'data') };
  for (const host of [undefined, { method: 'host-native', platformOs: 'linux', platformFamily: 'unix' } as const]) {
    expect(resolveOpencodeBindingDatabase(recorded, native, host)).toEqual({ recorded, accessible: recorded });
  }
});

// Windows-shaped paths are real on a Windows host; the fake refuses to shadow them there.
describe.skipIf(path.sep === '\\')('WSL bindings', () => {
  let host: ReturnType<typeof createWindowsHostFS>;
  beforeEach(() => { host = createWindowsHostFS({ fs, fsPromises }); });
  const linuxFile = async (linux: string) => { await host.write(host.fromLinux(linux), ''); return host.fromLinux(linux); };

  it('keeps Linux store identity as a host locator and refuses a different distro', async () => {
    expect(resolveOpencodeDatabasePath(env, target)).toBe('\\\\wsl$\\Ubuntu\\home\\test\\data\\opencode\\opencode.db');
    const recorded = host.fromLinux('/home/test/data/opencode/opencode.db', 'Other');
    await host.write(recorded, '');
    expect(resolveOpencodeBindingDatabase(recorded, { ...env, OPENCODE_DB: recorded }, target)).toEqual({ recorded, accessible: null });
  });

  it('starts an unbound session on the current target database, including an in-memory one', () => {
    for (const recorded of [null, undefined, '  ']) {
      expect(resolveOpencodeBindingDatabase(recorded, env, target)).toEqual({ recorded: null, accessible: '\\\\wsl$\\Ubuntu\\home\\test\\data\\opencode\\opencode.db' });
    }
    expect(resolveOpencodeBindingDatabase(':memory:', { ...env, OPENCODE_DB: ':memory:' }, target)).toEqual({ recorded: ':memory:', accessible: ':memory:' });
    expect(resolveOpencodeBindingDatabase(':memory:', env, target)).toEqual({ recorded: ':memory:', accessible: null });
  });

  it('trusts only an existing target configured database or target data root file without rewriting a recorded locator', async () => {
    const recorded = await linuxFile('/custom/session.db');
    const inRoot = await linuxFile('/home/test/data/opencode/opencode-old.db');
    const sibling = await linuxFile('/home/test/data/opencode-other/opencode.db');
    // The data root's parent exists but lies outside the root, though its relative path has no `../` prefix.
    const parent = host.fromLinux('/home/test/data');
    expect(fs.existsSync(parent)).toBe(true);
    expect(resolveOpencodeBindingDatabase(recorded, { ...env, OPENCODE_DB: '/custom/session.db' }, target)).toEqual({ recorded, accessible: recorded });
    expect(resolveOpencodeBindingDatabase(recorded, env, target)).toEqual({ recorded, accessible: null });
    expect(resolveOpencodeBindingDatabase(inRoot, env, target)).toEqual({ recorded: inRoot, accessible: inRoot });
    expect(resolveOpencodeBindingDatabase(sibling, env, target)).toEqual({ recorded: sibling, accessible: null });
    expect(resolveOpencodeBindingDatabase(parent, env, target)).toEqual({ recorded: parent, accessible: null });
    await host.remove(recorded);
    expect(resolveOpencodeBindingDatabase(recorded, { ...env, OPENCODE_DB: '/custom/session.db' }, target)).toEqual({ recorded, accessible: null });
  });

  it('refuses a recorded locator when the target home is unresolved, or when it is Linux-native', async () => {
    const recorded = await linuxFile('/home/test/data/opencode/opencode.db');
    expect(resolveOpencodeBindingDatabase(recorded, {}, target)).toEqual({ recorded, accessible: null });
    expect(resolveOpencodeBindingDatabase('/home/test/data/opencode/opencode.db', env, target)).toEqual({ recorded: '/home/test/data/opencode/opencode.db', accessible: null });
  });

  it('refuses rather than falling back to the host-native policy when the target policy fails', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'claudian-opencode-binding-')));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const recorded = path.join(root, '.local', 'share', 'opencode', 'opencode-old.db');
    fs.mkdirSync(path.dirname(recorded), { recursive: true });
    fs.writeFileSync(recorded, '');
    // A configured database in another distro makes the target policy fail.
    const environment = { HOME: root, OPENCODE_DB: String.raw`\\wsl$\Other\opencode.db` };
    expect(resolveOpencodeBindingDatabase(recorded, environment)).toEqual({ recorded, accessible: recorded });
    expect(resolveOpencodeBindingDatabase(recorded, environment, target)).toEqual({ recorded, accessible: null });
  });
});
