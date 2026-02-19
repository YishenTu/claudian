import { TFile, TFolder } from 'obsidian';

import { VaultFolderCache } from '@/features/chat/ui/file-context/state/VaultFolderCache';

function createFolder(path: string): TFolder {
  return new (TFolder as any)(path) as TFolder;
}

function createFile(path: string): TFile {
  return new (TFile as any)(path) as TFile;
}

describe('VaultFolderCache', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('excludes root and hidden folders', () => {
    const loadedFiles = [
      createFolder(''),
      createFolder('.obsidian'),
      createFolder('src/.private'),
      createFolder('src'),
      createFolder('src/components'),
      createFile('notes/example.md'),
    ];
    const app = {
      vault: {
        getAllLoadedFiles: jest.fn(() => loadedFiles),
      },
    } as any;
    const cache = new VaultFolderCache(app);

    const folders = cache.getFolders().map(folder => folder.path);

    expect(folders).toEqual(['src', 'src/components']);
  });

  it('returns cached folders until marked dirty', () => {
    let loadedFiles = [createFolder('src')];
    const getAllLoadedFiles = jest.fn(() => loadedFiles);
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
  });

  it('refreshes folder list after markDirty', () => {
    let loadedFiles = [createFolder('src')];
    const getAllLoadedFiles = jest.fn(() => loadedFiles);
    const app = {
      vault: { getAllLoadedFiles },
    } as any;
    const cache = new VaultFolderCache(app);

    cache.getFolders();
    loadedFiles = [createFolder('docs')];
    cache.markDirty();
    const refreshed = cache.getFolders().map(folder => folder.path);

    expect(refreshed).toEqual(['docs']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });

  it('supports lazy background initialization', () => {
    jest.useFakeTimers();
    const getAllLoadedFiles = jest.fn(() => [createFolder('src')]);
    const app = {
      vault: { getAllLoadedFiles },
    } as any;
    const cache = new VaultFolderCache(app);

    cache.initializeInBackground();
    expect(getAllLoadedFiles).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);

    const folders = cache.getFolders().map(folder => folder.path);
    expect(folders).toEqual(['src']);
    expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);
  });
});
