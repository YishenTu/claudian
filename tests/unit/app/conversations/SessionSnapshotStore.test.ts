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

  it('sweeps only stale Markdown files and respects abort', async () => {
    const store = new SessionSnapshotStore(directory, () => clock().getTime());
    const old = new Date(clock().getTime() - 8 * 86_400_000);
    for (const name of ['old.md', 'keep.txt', 'new.md']) {
      const file = path.join(directory, name);
      await fs.writeFile(file, name);
      if (name !== 'new.md') await fs.utimes(file, old, old);
    }
    await fs.mkdir(path.join(directory, 'folder.md'));
    await store.sweep(AbortSignal.abort());
    expect(await fs.readdir(directory)).toContain('old.md');
    await store.sweep(new AbortController().signal);
    expect((await fs.readdir(directory)).sort()).toEqual(['folder.md', 'keep.txt', 'new.md']);
    await expect(new SessionSnapshotStore(path.join(directory, 'keep.txt')).sweep(new AbortController().signal)).resolves.toBeUndefined();
  });
});
