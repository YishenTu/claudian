import { SharedStorageService } from '@/app/storage/SharedStorageService';

describe('SharedStorageService', () => {
  it('does not create storage directories during read-only initialization', async () => {
    const adapter = {
      exists: jest.fn().mockResolvedValue(false),
      read: jest.fn(),
      write: jest.fn(),
      mkdir: jest.fn(),
    };
    const plugin = {
      app: { vault: { adapter } },
    } as any;
    const storage = new SharedStorageService(plugin);

    await storage.initialize();

    expect(adapter.mkdir).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });
});
