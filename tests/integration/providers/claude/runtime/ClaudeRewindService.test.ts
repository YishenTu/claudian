import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { executeClaudeRewind } from '@/providers/claude/runtime/ClaudeRewindService';

describe('Claude rewind filesystem recovery', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-rewind-test-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it.each(['throws', 'declines'] as const)('restores files, directories, links and missing paths when the provider %s after mutation', async failure => {
    await fs.writeFile(path.join(root, 'existing.txt'), 'Original file');
    await fs.mkdir(path.join(root, 'directory'));
    await fs.writeFile(path.join(root, 'directory/nested.txt'), 'Original nested file');
    const target = path.join(root, 'link-target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'untouched.txt'), 'Link target');
    await fs.symlink(target, path.join(root, 'link'), 'junction');
    let sessionTransition: string | null = null;
    const rewind = executeClaudeRewind('user-1', {
      assistantMessageId: 'assistant-1', mode: 'code-and-conversation', vaultPath: root,
      closePersistentQuery: reason => { sessionTransition = reason; },
      setPendingResumeAt: () => { throw new Error('Failed rewind must not set a resume checkpoint'); },
      resetSession: () => { throw new Error('Failed rewind must not reset the session'); },
      rewindFiles: async (_id, dryRun) => {
        if (dryRun) return { canRewind: true, filesChanged: ['existing.txt', 'directory', 'link', 'created.txt'] };
        await fs.writeFile(path.join(root, 'existing.txt'), 'Partially rewound');
        await fs.rm(path.join(root, 'directory'), { recursive: true });
        await fs.mkdir(path.join(root, 'directory'));
        await fs.writeFile(path.join(root, 'directory/replacement.txt'), 'New content');
        await fs.unlink(path.join(root, 'link'));
        await fs.writeFile(path.join(root, 'link'), 'Replaced symlink');
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
    expect(await fs.readdir(path.join(root, 'directory'))).toEqual(['nested.txt']);
    expect(await fs.readFile(path.join(root, 'directory/nested.txt'), 'utf8')).toBe('Original nested file');
    expect((await fs.lstat(path.join(root, 'link'))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(root, 'link'))).toBe(await fs.realpath(target));
    expect(await fs.readFile(path.join(root, 'link/untouched.txt'), 'utf8')).toBe('Link target');
    await expect(fs.stat(path.join(root, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sessionTransition).toBe('rewind failed');
  });

  it('surfaces restoration failure and still restores the other affected files', async () => {
    await fs.mkdir(path.join(root, 'blocked'));
    await fs.writeFile(path.join(root, 'blocked/note.txt'), 'Original blocked file');
    await fs.writeFile(path.join(root, 'other.txt'), 'Original other file');
    let closed = false;
    const rewind = executeClaudeRewind('user-1', {
      assistantMessageId: 'assistant-1', mode: 'code-and-conversation', vaultPath: root,
      closePersistentQuery: () => { closed = true; },
      setPendingResumeAt: () => { throw new Error('Failed rewind must not set a resume checkpoint'); },
      resetSession: () => { throw new Error('Failed rewind must not reset the session'); },
      rewindFiles: async (_id, dryRun) => {
        if (dryRun) return { canRewind: true, filesChanged: ['blocked/note.txt', 'other.txt'] };
        await fs.rm(path.join(root, 'blocked'), { recursive: true });
        await fs.writeFile(path.join(root, 'blocked'), 'Parent became a file');
        await fs.writeFile(path.join(root, 'other.txt'), 'Partially rewound');
        throw new Error('Provider rewind interrupted');
      },
    });

    await expect(rewind).rejects.toThrow('Rewind failed and files could not be fully restored');
    expect(await fs.readFile(path.join(root, 'other.txt'), 'utf8')).toBe('Original other file');
    expect(await fs.readFile(path.join(root, 'blocked'), 'utf8')).toBe('Parent became a file');
    expect(closed).toBe(true);
  });
});
