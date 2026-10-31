import { App, TFile, TFolder } from 'obsidian';

import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

function createFile(path: string): TFile {
  const file = Object.assign(new TFile(), { path, name: path.split('/').pop() ?? '', extension: path.split('.').pop() ?? '' });
  (file).stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  return file;
}

function createFolder(path: string): TFolder {
  return Object.assign(new TFolder(), { path, name: path.split('/').pop() ?? '' });
}

describe('VaultMentionDataProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached vault files and folders without reloading until dirty', () => {
    const files = [createFile('notes/a.md')];
    const folders = [createFolder('notes')];
    const app = new App();
    Object.assign(app.vault, {
        getFiles: vi.fn(() => files),
        getAllLoadedFiles: vi.fn(() => folders),
    });
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

  it.each(['background', 'queued twice', 'foreground first'])('initializes real file and folder caches once with %s ordering', ordering => {
    vi.useFakeTimers();
    const files = [createFile('notes/a.md')];
    const folders = [createFolder('notes')];
    const app = new App();
    Object.assign(app.vault, {
        getFiles: vi.fn(() => files),
        getAllLoadedFiles: vi.fn(() => folders),
    });
    const provider = new VaultMentionDataProvider(app);

    provider.initializeInBackground();
    if (ordering === 'queued twice') provider.initializeInBackground();

    expect(app.vault.getFiles).not.toHaveBeenCalled();
    expect(app.vault.getAllLoadedFiles).not.toHaveBeenCalled();
    const foregroundFiles = ordering === 'foreground first' ? provider.getCachedVaultFiles() : undefined;
    const foregroundFolders = ordering === 'foreground first' ? provider.getCachedVaultFolders() : undefined;
    expect(foregroundFiles).toEqual(ordering === 'foreground first' ? files : undefined);
    expect(foregroundFolders).toEqual(ordering === 'foreground first' ? [{ name: 'notes', path: 'notes' }] : undefined);
    expect(app.vault.getFiles).toHaveBeenCalledTimes(ordering === 'foreground first' ? 1 : 0);
    expect(app.vault.getAllLoadedFiles).toHaveBeenCalledTimes(ordering === 'foreground first' ? 1 : 0);

    vi.runOnlyPendingTimers();

    expect(app.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(app.vault.getAllLoadedFiles).toHaveBeenCalledTimes(1);
    expect(provider.getCachedVaultFiles()).toEqual(files);
    expect(provider.getCachedVaultFolders()).toEqual([{ name: 'notes', path: 'notes' }]);
    provider.initializeInBackground();
    vi.runOnlyPendingTimers();
    expect(app.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(app.vault.getAllLoadedFiles).toHaveBeenCalledTimes(1);
  });

  it('reports file load errors only once while continuing to return an empty result', () => {
    const onFileLoadError = vi.fn();
    const app = new App();
    Object.assign(app.vault, {
        getFiles: vi.fn(() => {
          throw new Error('Vault unavailable');
        }),
        getAllLoadedFiles: vi.fn(() => []),
    });
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
      getFiles: vi.fn(() => [createFile('notes/a.md')]),
      getAllLoadedFiles: vi.fn(() => [createFolder('notes')]),
      on: vi.fn((name: string, callback: () => void) => {
        listeners.set(name, callback);
        return { name };
      }),
      offref: vi.fn((ref: { name: string }) => listeners.delete(ref.name)),
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
