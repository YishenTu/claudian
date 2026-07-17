import { Notice } from 'obsidian';

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

  it('reports and propagates tab layout persistence failures', async () => {
    const error = new Error('disk full');
    const plugin = {
      app: { vault: { adapter: {} } },
      loadData: jest.fn().mockResolvedValue({ existing: true }),
      saveData: jest.fn().mockRejectedValue(error),
    } as any;
    const storage = new SharedStorageService(plugin);

    await expect(storage.setTabManagerState({
      activeTabId: null,
      openTabs: [],
    })).rejects.toBe(error);
    expect(Notice).toHaveBeenCalledWith('Failed to save tab layout');
  });
});
