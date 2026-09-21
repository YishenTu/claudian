import type { AiEditReviewPersistence } from '../../core/storage/AiEditReviewPersistence';
import type { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';

const REVIEW_PATH = '.claudian/ai-edit-reviews.json';
const BACKUP_PATH = `${REVIEW_PATH}.bak`;

export class AiEditReviewStorage implements AiEditReviewPersistence {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: Pick<VaultFileAdapter, 'exists' | 'read' | 'write' | 'rename' | 'delete'>) {}

  async load(): Promise<unknown> {
    const path = await this.adapter.exists(REVIEW_PATH) ? REVIEW_PATH : BACKUP_PATH;
    if (!await this.adapter.exists(path)) return null;
    return JSON.parse(await this.adapter.read(path));
  }

  save(value: unknown): Promise<void> {
    const content = JSON.stringify(value);
    this.pending = this.pending.catch(() => undefined).then(async () => {
      const temporaryPath = `${REVIEW_PATH}.tmp`;
      await this.adapter.write(temporaryPath, content);
      // Obsidian rename rejects existing destinations. Retain a recoverable
      // previous version across both the promotion and a process interruption.
      const hadPrevious = await this.adapter.exists(REVIEW_PATH);
      if (hadPrevious) {
        await this.adapter.delete(BACKUP_PATH);
        await this.adapter.rename(REVIEW_PATH, BACKUP_PATH);
      }
      try {
        await this.adapter.rename(temporaryPath, REVIEW_PATH);
      } catch (error) {
        if (hadPrevious && !await this.adapter.exists(REVIEW_PATH)) {
          await this.adapter.rename(BACKUP_PATH, REVIEW_PATH);
        }
        throw error;
      }
    });
    return this.pending;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
