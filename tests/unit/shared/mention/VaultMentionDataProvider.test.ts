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

/** The view owns one subscription shared by every tab's mention source. */
describe('VaultMentionDataProvider vault events', () => {
  function fixture() {
    const listeners = new Map<string, () => void>();
    const vault = {
      getFiles: jest.fn(() => [createFile('notes/a.md')]),
      getAllLoadedFiles: jest.fn(() => [createFolder('notes')]),
      on: jest.fn((name: string, callback: () => void) => {
        listeners.set(name, callback);
        return { name };
      }),
      offref: jest.fn((ref: { name: string }) => listeners.delete(ref.name)),
    };
    const provider = new VaultMentionDataProvider({ vault } as never);
    const unsubscribe = provider.register(vault as never);
    provider.getCachedVaultFiles();
    provider.getCachedVaultFolders();
    return { provider, vault, listeners, unsubscribe };
  }

  it.each(['create', 'delete', 'rename'])('reloads both caches after %s', event => {
    const { provider, vault, listeners } = fixture();
    listeners.get(event)!();
    provider.getCachedVaultFiles();
    provider.getCachedVaultFolders();
    expect(vault.getFiles).toHaveBeenCalledTimes(2);
    expect(vault.getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });

  it('preserves cached folders when only file content changed', () => {
    const { provider, vault, listeners } = fixture();
    listeners.get('modify')!();
    provider.getCachedVaultFiles();
    provider.getCachedVaultFolders();
    expect(vault.getFiles).toHaveBeenCalledTimes(2);
    expect(vault.getAllLoadedFiles).toHaveBeenCalledTimes(1);
  });

  it('releases each listener once and refreshes stale caches after reopening', () => {
    const { provider, vault, listeners, unsubscribe } = fixture();
    unsubscribe();
    unsubscribe();
    expect(vault.offref).toHaveBeenCalledTimes(4);
    expect(listeners.size).toBe(0);
    provider.getCachedVaultFiles();
    expect(vault.getFiles).toHaveBeenCalledTimes(1);
    provider.register(vault as never);
    provider.getCachedVaultFiles();
    provider.getCachedVaultFolders();
    expect(vault.getFiles).toHaveBeenCalledTimes(2);
    expect(vault.getAllLoadedFiles).toHaveBeenCalledTimes(2);
  });
});
