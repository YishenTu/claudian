import { SharedStorageService } from '@/app/storage/SharedStorageService';
import type { SharedAppStorage } from '@/core/bootstrap/storage';

describe('SharedStorageService', () => {
  it('exposes only read-only session capabilities through SharedAppStorage', () => {
    const writerIsExposed: 'saveMetadata' extends keyof SharedAppStorage['sessions']
      ? true
      : false = false;
    const ledgerWriterIsExposed: 'saveInputLedger' extends keyof SharedAppStorage['sessions']
      ? true
      : false = false;

    expect(writerIsExposed).toBe(false);
    expect(ledgerWriterIsExposed).toBe(false);
  });

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

  it('propagates legacy tab cleanup failures', async () => {
    const error = new Error('disk full');
    const plugin = {
      app: { vault: { adapter: {} } },
      loadData: jest.fn().mockResolvedValue({
        tabManagerState: { activeTabId: null, openTabs: [] },
      }),
      saveData: jest.fn().mockRejectedValue(error),
    } as any;
    const storage = new SharedStorageService(plugin);

    await expect(storage.clearTabManagerState()).rejects.toBe(error);
  });

  it('clears only the legacy global tab snapshot', async () => {
    const plugin = {
      app: { vault: { adapter: {} } },
      loadData: jest.fn().mockResolvedValue({
        existing: true,
        tabManagerState: {
          activeTabId: 'tab-1',
          openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
        },
      }),
      saveData: jest.fn().mockResolvedValue(undefined),
    } as any;
    const storage = new SharedStorageService(plugin);

    await storage.clearTabManagerState();

    expect(plugin.saveData).toHaveBeenCalledWith({ existing: true });
  });
});
