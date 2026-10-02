import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

/** Ephemeral snapshots are local to this machine, outside the synced vault. */
export class SessionSnapshotStore {
  constructor(
    readonly directory = path.join(tmpdir(), 'claudian-sessions'),
    private readonly now: () => number = Date.now,
  ) {}

  async write(conversationId: string, markdown: string): Promise<string> {
    if (!/^conv-[0-9]+-[a-z0-9]+$/.test(conversationId)) throw new Error('Invalid conversation id');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.assertSafeDirectory();
    let timestamp = this.now();
    for (;;) {
      const file = path.join(this.directory, `${conversationId}-${timestamp}.md`);
      try {
        await fs.writeFile(file, markdown, { flag: 'wx', mode: 0o600 });
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        timestamp++;
      }
    }
  }

  async sweep(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      await this.assertSafeDirectory();
      const cutoff = this.now() - 7 * 86_400_000;
      for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
        if (signal.aborted) return;
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        try {
          const file = path.join(this.directory, entry.name);
          const stat = await fs.lstat(file);
          if (!signal.aborted && stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(file);
        } catch { /* Another process or the OS may have removed the snapshot. */ }
      }
    } catch { /* Startup maintenance is best effort, including an absent folder. */ }
  }

  private async assertSafeDirectory(): Promise<void> {
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
      throw new Error('Unsafe session snapshot directory');
    }
  }
}
