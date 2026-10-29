import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';

import { SharedStorageService } from '@/app/storage/SharedStorageService';

describe('SharedStorageService', () => {

  it('does not create storage directories during read-only initialization', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      read: vi.fn(),
      write: vi.fn(),
      mkdir: vi.fn(),
    };
    const plugin = {
      app: { vault: { adapter } },
    } as any;
    const storage = new SharedStorageService(plugin, DEFAULT_CLAUDIAN_SETTINGS);

    await storage.initialize();

    expect(adapter.mkdir).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });
});
