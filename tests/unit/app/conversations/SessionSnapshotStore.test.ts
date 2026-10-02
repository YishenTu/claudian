import { testClock } from '@test/helpers/testClock';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { SessionSnapshotStore } from '@/app/conversations/SessionSnapshotStore';

describe('session snapshot storage', () => {
  let directory: string;
  const clock = testClock();
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(tmpdir(), 'claudian-snapshot-test-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('creates immutable snapshots even when two sends share a millisecond', async () => {
    const store = new SessionSnapshotStore(directory, () => clock().getTime());
    const first = await store.write('conv-1-abc', 'first');
    const second = await store.write('conv-1-abc', 'second');
    expect(first).toBe(path.join(directory, `conv-1-abc-${clock().getTime()}.md`));
    expect(second).not.toBe(first);
    expect(await fs.readFile(first, 'utf8')).toBe('first');
    expect(await fs.readFile(second, 'utf8')).toBe('second');
    await expect(store.write('../escape', 'text')).rejects.toThrow();
  });

  it.each([0, 1100])('sweeps only stale Markdown files and respects abort (clock offset: %s days)', async days => {
    const sweepClock = testClock({ days });
    const store = new SessionSnapshotStore(directory, () => sweepClock().getTime());
    const old = new Date(sweepClock().getTime() - 8 * 86_400_000);
    for (const name of ['old.md', 'keep.txt', 'new.md']) {
      const file = path.join(directory, name);
      await fs.writeFile(file, name);
      const modifiedAt = name === 'new.md' ? sweepClock() : old;
      await fs.utimes(file, modifiedAt, modifiedAt);
    }
    await fs.mkdir(path.join(directory, 'folder.md'));
    await store.sweep(AbortSignal.abort());
    expect(await fs.readdir(directory)).toContain('old.md');
    await store.sweep(new AbortController().signal);
    expect((await fs.readdir(directory)).sort()).toEqual(['folder.md', 'keep.txt', 'new.md']);
    await expect(new SessionSnapshotStore(path.join(directory, 'keep.txt')).sweep(new AbortController().signal)).resolves.toBeUndefined();
  });
  (process.platform === 'win32' ? describe.skip : describe)('POSIX directory trust', () => {
    it.each(['writable', 'owner', 'symlink'])('rejects an unsafe existing directory (%s) for writes and cleanup', async kind => {
      const target = path.join(directory, 'target');
      await fs.mkdir(target, { mode: 0o700 });
      const oldFile = path.join(target, 'old.md');
      await fs.writeFile(oldFile, 'keep');
      const old = new Date(clock().getTime() - 8 * 86_400_000);
      await fs.utimes(oldFile, old, old);
      let storeDirectory = target;
      if (kind === 'writable') await fs.chmod(target, 0o777);
      if (kind === 'owner') jest.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
      if (kind === 'symlink') {
        storeDirectory = path.join(directory, 'link');
        await fs.symlink(target, storeDirectory);
      }
      try {
        const store = new SessionSnapshotStore(storeDirectory, () => clock().getTime());
        await expect(store.write('conv-1-abc', 'private')).rejects.toThrow('Unsafe session snapshot directory');
        await expect(store.sweep(new AbortController().signal)).resolves.toBeUndefined();
        expect(await fs.readdir(target)).toEqual(['old.md']);
      } finally { jest.restoreAllMocks(); }
    });
  });
});
