import { App, type TFile } from 'obsidian';

import { VaultFileCache } from '@/shared/mention/VaultMentionCache';

describe('VaultFileCache', () => {
  let mockApp: App;
  let mockFiles: TFile[];

  beforeEach(() => {
    mockFiles = [
      { path: 'note1.md', name: 'note1.md' } as TFile,
      { path: 'note2.md', name: 'note2.md' } as TFile,
    ];

    mockApp = new App();
    Object.assign(mockApp.vault, {
        getFiles: vi.fn().mockReturnValue(mockFiles),
    });
  });

  describe('getFiles', () => {
    it('should return stale files if reload fails', () => {
      const getFiles = vi.fn()
        .mockReturnValueOnce(mockFiles)
        .mockImplementation(() => {
          throw new Error('Vault error');
        });
      mockApp.vault.getFiles = getFiles;
      const cache = new VaultFileCache(mockApp);

      expect(cache.getFiles()).toEqual(mockFiles);

      cache.markDirty();
      expect(cache.getFiles()).toEqual(mockFiles);
      expect(getFiles).toHaveBeenCalledTimes(2);
    });

    it('should invoke onLoadError callback when getFiles fails', () => {
      const error = new Error('Vault error');
      mockApp.vault.getFiles = vi.fn(() => {
        throw error;
      });
      const onLoadError = vi.fn();

      const cache = new VaultFileCache(mockApp, { onLoadError });
      cache.getFiles();

      expect(onLoadError).toHaveBeenCalledWith(error);
    });

    it('should not reload repeatedly when vault has no files', () => {
      mockApp.vault.getFiles = vi.fn().mockReturnValue([]);
      const cache = new VaultFileCache(mockApp);

      expect(cache.getFiles()).toEqual([]);
      expect(cache.getFiles()).toEqual([]);

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('initializeInBackground', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(['background', 'queued twice', 'foreground first'])('should populate cache once with %s initialization', ordering => {
      const cache = new VaultFileCache(mockApp);
      cache.initializeInBackground();
      if (ordering === 'queued twice') cache.initializeInBackground();

      expect(mockApp.vault.getFiles).not.toHaveBeenCalled();
      const foregroundFiles = ordering === 'foreground first' ? cache.getFiles() : undefined;
      expect(foregroundFiles).toEqual(ordering === 'foreground first' ? mockFiles : undefined);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(ordering === 'foreground first' ? 1 : 0);

      vi.runAllTimers();

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
      expect(cache.getFiles()).toEqual(mockFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);

      cache.initializeInBackground();
      vi.runAllTimers();

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
    });

    it('preserves dirty files after foreground initialization overtakes the queued callback', () => {
      const cache = new VaultFileCache(mockApp);
      cache.initializeInBackground();
      expect(cache.getFiles()).toEqual(mockFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);

      const newFiles = [{ path: 'note3.md', name: 'note3.md' } as TFile];
      vi.mocked(mockApp.vault.getFiles).mockReturnValue(newFiles);
      cache.markDirty();
      vi.runAllTimers();

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
      expect(cache.getFiles()).toEqual(newFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(2);
      expect(cache.getFiles()).toEqual(newFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(2);
    });

    it('should invoke onLoadError callback when initialization fails', () => {
      const error = new Error('Vault error');
      mockApp.vault.getFiles = vi.fn(() => {
        throw error;
      });
      const onLoadError = vi.fn();

      const cache = new VaultFileCache(mockApp, { onLoadError });
      cache.initializeInBackground();
      vi.runAllTimers();

      expect(onLoadError).toHaveBeenCalledWith(error);
    });

    it('should mark initialization attempted even if loading fails', () => {
      mockApp.vault.getFiles = vi.fn(() => {
        throw new Error('Vault error');
      });

      const cache = new VaultFileCache(mockApp);
      cache.initializeInBackground();
      cache.initializeInBackground();
      expect(() => vi.runAllTimers()).not.toThrow();

      cache.initializeInBackground();
      vi.runOnlyPendingTimers();

      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(1);
      vi.mocked(mockApp.vault.getFiles).mockReturnValue(mockFiles);
      expect(cache.getFiles()).toEqual(mockFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(2);
      expect(cache.getFiles()).toEqual(mockFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(2);
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
      vi.mocked(mockApp.vault.getFiles).mockReturnValue(newFiles);

      cache.markDirty();
      const files = cache.getFiles();

      expect(files).toEqual(newFiles);
      expect(mockApp.vault.getFiles).toHaveBeenCalledTimes(2);
    });
  });
});
