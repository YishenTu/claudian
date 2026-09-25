import type { App, TFile } from 'obsidian';

import { VaultFileCache } from '@/shared/mention/VaultMentionCache';

describe('VaultFileCache', () => {
  let mockApp: App;
  let mockFiles: TFile[];

  beforeEach(() => {
    mockFiles = [
      { path: 'note1.md', name: 'note1.md' } as TFile,
      { path: 'note2.md', name: 'note2.md' } as TFile,
    ];

    mockApp = {
      vault: {
        getFiles: jest.fn().mockReturnValue(mockFiles),
      },
    } as any;
  });

  describe('getFiles', () => {
    it('should return stale files if reload fails', () => {
      const getFiles = jest
        .fn()
        .mockReturnValueOnce(mockFiles)
        .mockImplementation(() => {
          throw new Error('Vault error');
        });
      mockApp.vault.getFiles = getFiles as any;
      const cache = new VaultFileCache(mockApp);

      expect(cache.getFiles()).toEqual(mockFiles);

      cache.markDirty();
      expect(cache.getFiles()).toEqual(mockFiles);
      expect(getFiles).toHaveBeenCalledTimes(2);
    });

    it('should invoke onLoadError callback when getFiles fails', () => {
      const error = new Error('Vault error');
      mockApp.vault.getFiles = jest.fn(() => {
        throw error;
      });
      const onLoadError = jest.fn();

      const cache = new VaultFileCache(mockApp, { onLoadError });
      cache.getFiles();

      expect(onLoadError).toHaveBeenCalledWith(error);
    });

    it('should not reload repeatedly when vault has no files', () => {
      mockApp.vault.getFiles = jest.fn().mockReturnValue([]);
      const cache = new VaultFileCache(mockApp);

      expect(cache.getFiles()).toEqual([]);
      expect(cache.getFiles()).toEqual([]);

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('initializeInBackground', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should populate cache in background', () => {
      const cache = new VaultFileCache(mockApp);
      cache.initializeInBackground();

      expect(mockApp.vault.getFiles).not.toHaveBeenCalled();

      jest.runAllTimers();

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
      expect(cache.getFiles()).toEqual(mockFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);

      cache.initializeInBackground();
      jest.runAllTimers();

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
    });

    it('should invoke onLoadError callback when initialization fails', () => {
      const error = new Error('Vault error');
      mockApp.vault.getFiles = jest.fn(() => {
        throw error;
      });
      const onLoadError = jest.fn();

      const cache = new VaultFileCache(mockApp, { onLoadError });
      cache.initializeInBackground();
      jest.runAllTimers();

      expect(onLoadError).toHaveBeenCalledWith(error);
    });

    it('should mark initialization attempted even if loading fails', () => {
      mockApp.vault.getFiles = jest.fn(() => {
        throw new Error('Vault error');
      });

      const cache = new VaultFileCache(mockApp);
      cache.initializeInBackground();
      expect(() => jest.runAllTimers()).not.toThrow();

      cache.initializeInBackground();
      jest.runOnlyPendingTimers();

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('markDirty', () => {
    it('should force re-fetch on next getFiles call', () => {
      const cache = new VaultFileCache(mockApp);
      const initial = cache.getFiles();
      expect(initial).toEqual(mockFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);

      expect(cache.getFiles()).toBe(initial);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);

      const newFiles = [{ path: 'note3.md', name: 'note3.md' } as TFile];
      jest.mocked(mockApp.vault.getFiles).mockReturnValue(newFiles);

      cache.markDirty();
      const files = cache.getFiles();

      expect(files).toEqual(newFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(2);
    });
  });
});
