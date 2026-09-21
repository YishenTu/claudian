import { AiEditReviewStorage } from '@/app/storage/AiEditReviewStorage';

describe('AiEditReviewStorage', () => {
  it('restores the previous document after an interruption between renames', async () => {
    const previous = { version: 1, reviews: ['pending original'] };
    const files = new Map([
      ['.claudian/ai-edit-reviews.json.bak', JSON.stringify(previous)],
      ['.claudian/ai-edit-reviews.json.tmp', '{partial'],
    ]);
    const storage = new AiEditReviewStorage({
      exists: async path => files.has(path),
      read: async path => files.get(path)!,
      write: async (path, text) => { files.set(path, text); },
      delete: async path => { files.delete(path); },
      rename: async (from, to) => {
        if (files.has(to)) throw new Error('Destination file already exists!');
        files.set(to, files.get(from)!);
        files.delete(from);
      },
    });
    expect(await storage.load()).toEqual(previous);
    await storage.save({ version: 1, reviews: ['recovered'] });
    expect(await storage.load()).toEqual({ version: 1, reviews: ['recovered'] });
  });

  it('keeps the last saved document if replacement fails and can save again', async () => {
    const files = new Map<string, string>();
    let rejectRename = false;
    const adapter = {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path)!,
      write: async (path: string, content: string) => { files.set(path, content); },
      delete: async (path: string) => { files.delete(path); },
      rename: async (from: string, to: string) => {
        if (rejectRename && from.endsWith('.tmp')) throw new Error('Disk unavailable');
        if (files.has(to)) throw new Error('Destination file already exists!');
        files.set(to, files.get(from)!);
        files.delete(from);
      },
    };
    const storage = new AiEditReviewStorage(adapter);
    await storage.save({ version: 1, reviews: ['pending'] });
    rejectRename = true;
    await expect(storage.save({ version: 1, reviews: [] })).rejects.toThrow('Disk unavailable');
    expect(await new AiEditReviewStorage(adapter).load()).toEqual({ version: 1, reviews: ['pending'] });
    rejectRename = false;
    const first = storage.save({ version: 1, reviews: ['new'] });
    const second = storage.save({ version: 1, reviews: [] });
    await Promise.all([first, second, storage.flush()]);
    expect(await new AiEditReviewStorage(adapter).load()).toEqual({ version: 1, reviews: [] });
  });
});
