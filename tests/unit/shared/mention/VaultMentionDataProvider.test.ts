import { TFile, TFolder } from 'obsidian';

import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

function createFile(path: string): TFile {
  const file = new (TFile as any)(path) as TFile;
  (file as any).stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  return file;
}

function createFolder(path: string): TFolder {
  return new (TFolder as any)(path) as TFolder;
}

describe('VaultMentionDataProvider', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns cached vault files and folders without reloading until dirty', () => {
    const files = [createFile('notes/a.md')];
    const folders = [createFolder('notes')];
    const app = {
      vault: {
        getFiles: jest.fn(() => files),
        getAllLoadedFiles: jest.fn(() => folders),
      },
    } as any;
    const provider = new VaultMentionDataProvider(app);

    expect(provider.getCachedVaultFiles()).toEqual(files);
    expect(provider.getCachedVaultFiles()).toEqual(files);
    expect(provider.getCachedVaultFolders()).toEqual([{ name: 'notes', path: 'notes' }]);
    expect(provider.getCachedVaultFolders()).toEqual([{ name: 'notes', path: 'notes' }]);

    expect(app.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(app.vault.getAllLoadedFiles).toHaveBeenCalledTimes(1);

    provider.markFilesDirty();
    provider.markFoldersDirty();
    provider.getCachedVaultFiles();
    provider.getCachedVaultFolders();

    expect(app.vault.getFiles).toHaveBeenCalledTimes(2);
    expect(app.vault.getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });

  it('initializes file and folder caches in background', () => {
    jest.useFakeTimers();
    const app = {
      vault: {
        getFiles: jest.fn(() => [createFile('notes/a.md')]),
        getAllLoadedFiles: jest.fn(() => [createFolder('notes')]),
      },
    } as any;
    const provider = new VaultMentionDataProvider(app);

    provider.initializeInBackground();

    expect(app.vault.getFiles).not.toHaveBeenCalled();
    expect(app.vault.getAllLoadedFiles).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(app.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(app.vault.getAllLoadedFiles).toHaveBeenCalledTimes(1);
  });

  it('reports file load errors only once while continuing to return an empty result', () => {
    const onFileLoadError = jest.fn();
    const app = {
      vault: {
        getFiles: jest.fn(() => {
          throw new Error('Vault unavailable');
        }),
        getAllLoadedFiles: jest.fn(() => []),
      },
    } as any;
    const provider = new VaultMentionDataProvider(app, { onFileLoadError });

    expect(provider.getCachedVaultFiles()).toEqual([]);
    expect(provider.getCachedVaultFiles()).toEqual([]);

    expect(app.vault.getFiles).toHaveBeenCalledTimes(2);
    expect(onFileLoadError).toHaveBeenCalledTimes(1);
  });
});
