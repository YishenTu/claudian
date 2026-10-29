import { TFile, TFolder } from 'obsidian';

import { VaultFolderCache } from '@/shared/mention/VaultMentionCache';

function createFolder(path: string): TFolder {
  return new (TFolder as any)(path) as TFolder;
}

function createFile(path: string): TFile {
  return new (TFile as any)(path) as TFile;
}

describe('VaultFolderCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes root and hidden folders', () => {
    const loadedFiles = [
      createFolder(''),
      createFolder('/'),
      createFolder('//'),
      createFolder('.obsidian'),
      createFolder('src/.private'),
      createFolder('src'),
      createFolder('src/components'),
      createFile('notes/example.md'),
    ];
    const app = {
      vault: {
        getAllLoadedFiles: vi.fn(() => loadedFiles),
      },
    } as any;
    const cache = new VaultFolderCache(app);

    const folders = cache.getFolders().map(folder => folder.path);

    expect(folders).toEqual(['src', 'src/components']);
  });

  it('returns cached folders until marked dirty', () => {
    let loadedFiles = [createFolder('src')];
    const getAllLoadedFiles = vi.fn(() => loadedFiles);
    const app = {
      vault: { getAllLoadedFiles },
    } as any;
    const cache = new VaultFolderCache(app);

    const initial = cache.getFolders().map(folder => folder.path);
    loadedFiles = [createFolder('docs')];
    const second = cache.getFolders().map(folder => folder.path);

    expect(initial).toEqual(['src']);
    expect(second).toEqual(['src']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);

    cache.markDirty();
    const refreshed = cache.getFolders().map(folder => folder.path);

    expect(refreshed).toEqual(['docs']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });

  it.each(['background', 'queued twice', 'foreground first'])('supports %s initialization without reloading', ordering => {
    vi.useFakeTimers();
    const getAllLoadedFiles = vi.fn(() => [createFolder('src')]);
    const app = {
      vault: { getAllLoadedFiles },
    } as any;
    const cache = new VaultFolderCache(app);

    cache.initializeInBackground();
    if (ordering === 'queued twice') cache.initializeInBackground();
    expect(getAllLoadedFiles).not.toHaveBeenCalled();
    const foregroundFolders = ordering === 'foreground first' ? cache.getFolders().map(folder => folder.path) : undefined;
    expect(foregroundFolders).toEqual(ordering === 'foreground first' ? ['src'] : undefined);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(ordering === 'foreground first' ? 1 : 0);

    vi.runOnlyPendingTimers();
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);

    const folders = cache.getFolders().map(folder => folder.path);
    expect(folders).toEqual(['src']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);
    cache.initializeInBackground();
    vi.runOnlyPendingTimers();
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);
  });

  it('preserves dirty folders after foreground initialization overtakes the queued callback', () => {
    vi.useFakeTimers();
    const getAllLoadedFiles = vi.fn(() => [createFolder('src')]);
    const cache = new VaultFolderCache({ vault: { getAllLoadedFiles } } as any);
    cache.initializeInBackground();
    expect(cache.getFolders().map(folder => folder.path)).toEqual(['src']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);

    getAllLoadedFiles.mockReturnValue([createFolder('docs')]);
    cache.markDirty();
    vi.runOnlyPendingTimers();

    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);
    expect(cache.getFolders().map(folder => folder.path)).toEqual(['docs']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(2);
    expect(cache.getFolders().map(folder => folder.path)).toEqual(['docs']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });

  it('returns stale folders if reload fails', () => {
    const getAllLoadedFiles = vi.fn()
      .mockReturnValueOnce([createFolder('src')])
      .mockImplementation(() => {
        throw new Error('Vault error');
      });
    const app = {
      vault: { getAllLoadedFiles },
    } as any;
    const cache = new VaultFolderCache(app);

    expect(cache.getFolders().map(folder => folder.path)).toEqual(['src']);

    cache.markDirty();
    expect(cache.getFolders().map(folder => folder.path)).toEqual(['src']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });

  it('does not reload repeatedly when vault has no visible folders', () => {
    const getAllLoadedFiles = vi.fn(() => []);
    const app = {
      vault: { getAllLoadedFiles },
    } as any;
    const cache = new VaultFolderCache(app);

    expect(cache.getFolders()).toEqual([]);
    expect(cache.getFolders()).toEqual([]);

    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);
  });

  it('marks background initialization as attempted after failure', () => {
    vi.useFakeTimers();
    const getAllLoadedFiles = vi.fn((): TFolder[] => {
      throw new Error('Vault error');
    });
    const app = {
      vault: { getAllLoadedFiles },
    } as any;
    const cache = new VaultFolderCache(app);

    cache.initializeInBackground();
    cache.initializeInBackground();
    vi.runOnlyPendingTimers();
    cache.initializeInBackground();
    vi.runOnlyPendingTimers();

    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);
    getAllLoadedFiles.mockImplementation(() => [createFolder('src')]);
    expect(cache.getFolders().map(folder => folder.path)).toEqual(['src']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(2);
    expect(cache.getFolders().map(folder => folder.path)).toEqual(['src']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });
});
