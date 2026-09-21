import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Capture and restore only after every service using the directory has closed. */
export class CollabFixtureSnapshot {
  private constructor(
    private readonly directory: string,
    private readonly snapshotDirectory: string,
  ) {}

  static async capture(directory: string): Promise<CollabFixtureSnapshot> {
    const snapshotDirectory = await mkdtemp(path.join(tmpdir(), 'claudian-fixture-snapshot-'));
    try {
      await cp(directory, snapshotDirectory, { recursive: true });
      return new CollabFixtureSnapshot(directory, snapshotDirectory);
    } catch (error) {
      await rm(snapshotDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      throw error;
    }
  }

  async restore(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await cp(this.snapshotDirectory, this.directory, { recursive: true });
  }

  dispose(): Promise<void> {
    return rm(this.snapshotDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
