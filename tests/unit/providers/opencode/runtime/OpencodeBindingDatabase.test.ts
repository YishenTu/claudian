import type * as fs from 'node:fs';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { resolveOpencodeBindingDatabase } from '@/providers/opencode/runtime/OpencodeBindingDatabase';
import { resolveOpencodeDatabasePath } from '@/providers/opencode/runtime/OpencodePaths';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>(), existsSync: vi.fn(() => true) }));

const target: ExecutionTarget = { method: 'wsl', platformOs: 'linux', platformFamily: 'unix', distroName: 'Ubuntu' };
const env = { HOME: '/home/test', XDG_DATA_HOME: '/home/test/data' };

it('keeps Linux store identity as a host locator and refuses a different distro', () => {
  expect(resolveOpencodeDatabasePath(env, target)).toBe('\\\\wsl$\\Ubuntu\\home\\test\\data\\opencode\\opencode.db');
  const recorded = '\\\\wsl.localhost\\Other\\home\\test\\data\\opencode\\opencode.db';
  expect(resolveOpencodeBindingDatabase(recorded, { ...env, OPENCODE_DB: recorded }, target)).toEqual({ recorded, accessible: null });
});

it('trusts only the target configured database or target data root without rewriting a recorded locator', () => {
  const recorded = '\\\\wsl$\\Ubuntu\\custom\\session.db';
  expect(resolveOpencodeBindingDatabase(recorded, { ...env, OPENCODE_DB: '/custom/session.db' }, target)).toEqual({ recorded, accessible: recorded });
  expect(resolveOpencodeBindingDatabase(recorded, env, target)).toEqual({ recorded, accessible: null });
});

it('does not reinterpret a recorded Linux-native locator as a Windows or WSL database', () => {
  const recorded = '/home/test/data/opencode/opencode.db';
  expect(resolveOpencodeBindingDatabase(recorded, env, target)).toEqual({ recorded, accessible: null });
});
