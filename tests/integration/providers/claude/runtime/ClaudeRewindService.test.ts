import * as nodeFS from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';

import { executeClaudeRewind } from '@/providers/claude/runtime/ClaudeRewindService';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));

describe('Claude rewind filesystem recovery', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-rewind-test-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it.each(['throws', 'declines'] as const)('restores tracked files, linked files, dangling links and missing paths when the provider %s after mutation', async failure => {
    await fs.writeFile(path.join(root, 'existing.txt'), 'Original file');
    await fs.mkdir(path.join(root, 'directory'));
    await fs.writeFile(path.join(root, 'directory/nested.txt'), 'Original nested file');
    const target = path.join(root, 'link-target.md');
    await fs.writeFile(target, 'Link target');
    await fs.symlink(target, path.join(root, 'linked.md'));
    await fs.symlink(path.join(root, 'missing-target.md'), path.join(root, 'dangling.md'));
    let closeCount = 0;
    const rewind = executeClaudeRewind('user-1', {
      assistantMessageId: 'assistant-1', mode: 'code-and-conversation', vaultPath: root,
      closePersistentQuery: () => { closeCount += 1; },
      rewindFiles: async (_id, dryRun) => {
        // Dry runs do not apply the SDK's link-safety refusal, so a linked path can be reported but stays untouched.
        if (dryRun) return { canRewind: true, filesChanged: ['existing.txt', 'directory/nested.txt', 'linked.md', 'dangling.md', 'created.txt'] };
        await fs.writeFile(path.join(root, 'existing.txt'), 'Partially rewound');
        await fs.rm(path.join(root, 'directory'), { recursive: true });
        await fs.writeFile(path.join(root, 'created.txt'), 'Created during rewind');
        if (failure === 'throws') throw new Error('Provider rewind interrupted');
        return { canRewind: false, error: 'Provider declined rewind' };
      },
    });

    const outcome = await rewind.then(value => ({ value }), (error: Error) => ({ error: error.message }));
    const restoredFailure = { error: expect.stringContaining('Rewind failed but files were restored') };
    expect(outcome).toMatchObject(failure === 'throws'
      ? restoredFailure
      : { value: { canRewind: false } });
    expect(await fs.readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('Original file');
    expect(await fs.readFile(path.join(root, 'directory/nested.txt'), 'utf8')).toBe('Original nested file');
    expect((await fs.lstat(path.join(root, 'linked.md'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('Link target');
    expect((await fs.lstat(path.join(root, 'dangling.md'))).isSymbolicLink()).toBe(true);
    await expect(fs.stat(path.join(root, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(closeCount).toBe(1);
  });

  it('surfaces restoration failure and still restores the other affected files', async () => {
    await fs.mkdir(path.join(root, 'blocked'));
    await fs.writeFile(path.join(root, 'blocked/note.txt'), 'Original blocked file');
    await fs.writeFile(path.join(root, 'other.txt'), 'Original other file');
    let closed = false;
    const rewind = executeClaudeRewind('user-1', {
      assistantMessageId: 'assistant-1', mode: 'code-and-conversation', vaultPath: root,
      closePersistentQuery: () => { closed = true; },
      rewindFiles: async (_id, dryRun) => {
        if (dryRun) return { canRewind: true, filesChanged: ['blocked/note.txt', 'other.txt'] };
        await fs.rm(path.join(root, 'blocked'), { recursive: true });
        await fs.writeFile(path.join(root, 'blocked'), 'Parent became a file');
        await fs.writeFile(path.join(root, 'other.txt'), 'Partially rewound');
        throw new Error('Provider rewind interrupted');
      },
    });

    const error = await rewind.catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Rewind failed and files could not be fully restored');
    expect(await fs.readFile(path.join(root, 'other.txt'), 'utf8')).toBe('Original other file');
    expect(await fs.readFile(path.join(root, 'blocked'), 'utf8')).toBe('Parent became a file');
    expect(closed).toBe(true);
    const recoveryDirectory = message.match(/Backup retained at: (.+)$/)?.[1];
    expect(recoveryDirectory).toBeDefined();
    if (!recoveryDirectory) throw new Error('Expected the recoverable backup directory in the error');
    try {
      const recovery = message.match(/Recovery copy: (.+) -> (.+)\n/);
      expect(recovery?.[2]).toBe(path.join(root, 'blocked/note.txt'));
      if (!recovery) throw new Error('Expected the original path and its recovery copy in the error');
      expect(await fs.readFile(recovery[1], 'utf8')).toBe('Original blocked file');
      await fs.rm(path.join(root, 'blocked'));
      await fs.mkdir(path.join(root, 'blocked'));
      await fs.copyFile(recovery[1], recovery[2]);
      expect(await fs.readFile(path.join(root, 'blocked/note.txt'), 'utf8')).toBe('Original blocked file');
    } finally {
      await fs.rm(recoveryDirectory, { recursive: true, force: true });
    }
  });

  // WindowsHostFS models Windows paths on POSIX hosts; on Windows they are real host paths.
  it.skipIf(process.platform === 'win32')('backs up and restores WSL preview paths through their host paths after a failed rewind', async () => {
    const host = createWindowsHostFS({ fs: nodeFS, fsPromises: fs });
    const files = { '/mnt/c/Vault/note.md': 'C:\\Vault\\note.md', '/home/me/external.md': '\\\\wsl$\\Ubuntu\\home\\me\\external.md' };
    for (const hostPath of Object.values(files)) await host.write(hostPath, `Original ${hostPath}`);
    const executionTarget = { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' } as const;
    await expect(executeClaudeRewind('user-1', {
      executionTarget, vaultPath: 'C:\\Vault', assistantMessageId: 'assistant-1', mode: 'code-and-conversation',
      closePersistentQuery: () => {},
      rewindFiles: async (_id, dryRun) => {
        if (dryRun) return { canRewind: true, filesChanged: Object.keys(files) };
        for (const hostPath of Object.values(files)) await host.write(hostPath, 'Partially rewound');
        throw new Error('Provider rewind interrupted');
      },
    })).rejects.toThrow('files were restored');
    for (const hostPath of Object.values(files)) expect(await host.read(hostPath)).toBe(`Original ${hostPath}`);
  });

  it.skipIf(process.platform === 'win32')('reports WSL rewind changes as host paths', async () => {
    createWindowsHostFS({ fs: nodeFS, fsPromises: fs });
    const executionTarget = { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' } as const;
    await expect(executeClaudeRewind('user-1', {
      executionTarget, vaultPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\vault', assistantMessageId: undefined, mode: 'code-and-conversation',
      closePersistentQuery: () => {},
      rewindFiles: async () => ({ canRewind: true, filesChanged: ['note.md', '/mnt/d/shared.md'] }),
    })).resolves.toMatchObject({ canRewind: true, filesChanged: ['\\\\wsl$\\Ubuntu\\home\\me\\vault\\note.md', 'D:\\shared.md'] });
  });
});
