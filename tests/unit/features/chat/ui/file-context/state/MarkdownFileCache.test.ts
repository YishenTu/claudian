import type { App, TFile } from 'obsidian';

import { MarkdownFileCache } from '@/features/chat/ui/file-context/state/MarkdownFileCache';

describe('MarkdownFileCache', () => {
  let mockApp: App;
  let mockFiles: TFile[];

  beforeEach(() => {
    mockFiles = [
      { path: 'note1.md', name: 'note1.md' } as TFile,
      { path: 'note2.md', name: 'note2.md' } as TFile,
    ];

    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue(mockFiles),
      },
    } as any;
  });

  describe('getFiles', () => {
    it('should return cached files on first call', () => {
      const cache = new MarkdownFileCache(mockApp);
      const files = cache.getFiles();

      expect(files).toEqual(mockFiles);
      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
    });

    it('should return cached files on subsequent calls without re-fetching', () => {
      const cache = new MarkdownFileCache(mockApp);
      cache.getFiles();
      cache.getFiles();

      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
    });

    it('should re-fetch when marked dirty', () => {
      const cache = new MarkdownFileCache(mockApp);
      cache.getFiles();
      cache.markDirty();
      cache.getFiles();

      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(2);
    });

    it('should return the same array reference (no defensive copy)', () => {
      const cache = new MarkdownFileCache(mockApp);
      const files1 = cache.getFiles();
      const files2 = cache.getFiles();

      expect(files1).toBe(files2);
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
      const cache = new MarkdownFileCache(mockApp);
      cache.initializeInBackground();

      expect(mockApp.vault.getMarkdownFiles).not.toHaveBeenCalled();

      jest.runAllTimers();

      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
    });

    it('should not re-initialize if already initialized', () => {
      const cache = new MarkdownFileCache(mockApp);
      cache.initializeInBackground();
      jest.runAllTimers();

      cache.initializeInBackground();
      jest.runAllTimers();

      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', () => {
      mockApp.vault.getMarkdownFiles = jest.fn(() => {
        throw new Error('Vault error');
      });

      const cache = new MarkdownFileCache(mockApp);
      cache.initializeInBackground();

      expect(() => jest.runAllTimers()).not.toThrow();
    });

    it('should make cache available after initialization', () => {
      const cache = new MarkdownFileCache(mockApp);
      cache.initializeInBackground();
      jest.runAllTimers();

      const files = cache.getFiles();

      expect(files).toEqual(mockFiles);
      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('markDirty', () => {
    it('should force re-fetch on next getFiles call', () => {
      const cache = new MarkdownFileCache(mockApp);
      cache.getFiles();

      const newFiles = [{ path: 'note3.md', name: 'note3.md' } as TFile];
      mockApp.vault.getMarkdownFiles = jest.fn().mockReturnValue(newFiles);

      cache.markDirty();
      const files = cache.getFiles();

      expect(files).toEqual(newFiles);
      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
    });
  });
});
