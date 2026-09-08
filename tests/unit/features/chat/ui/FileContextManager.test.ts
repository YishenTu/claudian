import { TFile, TFolder } from 'obsidian';

import { FileContextManager } from '@/features/chat/ui/FileContext';

let mockVaultPath = '/vault';
jest.mock('@/utils/path', () => {
  const actual = jest.requireActual('@/utils/path');
  return {
    ...actual,
    getVaultPath: jest.fn(() => mockVaultPath),
  };
});

function createFile(path: string): TFile {
  const file = new TFile();
  Object.assign(file, {
    path,
    name: path.split('/').pop() ?? '',
    basename: (path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''),
    extension: path.split('.').pop() ?? '',
    stat: { ctime: 0, mtime: 0, size: 0 },
  });
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  Object.assign(folder, { path, name: path.split('/').pop() ?? '' });
  return folder;
}

function createMockApp(entries: Array<TFile | TFolder> = []) {
  return {
    app: {
      vault: {
        getFiles: jest.fn(() => entries.filter((entry): entry is TFile => entry instanceof TFile)),
        getAllLoadedFiles: jest.fn(() => entries),
      },
    } as never,
  };
}

describe('FileContextManager', () => {
  it('offers vault notes as wikilinks in the main chat picker', async () => {
    const { app } = createMockApp([createFile('DEMO.md'), createFile('- Bases/DEMO.md')]);
    const manager = new FileContextManager(app, {});
    try {
      const source = manager.getMentionSource();
      const match = source.match('@DEMO', 5)!;
      const items = await source.load(match, new AbortController().signal);
      for (const [path, text] of [
        ['DEMO.md', '[[DEMO.md|DEMO]] '],
        ['- Bases/DEMO.md', '[[- Bases/DEMO.md|DEMO]] '],
      ]) {
        const item = items.find(item => item.kind === 'value' && item.label === path);
        if (!item || item.kind !== 'value') throw new Error('Missing note option');
        expect(source.select(item, match)).toEqual(expect.objectContaining({ kind: 'replace', text }));
      }
    } finally {
      manager.destroy();
    }
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockVaultPath = '/vault';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('mechanically exposes the shared Vault file and folder caches', () => {
    const note = createFile('Notes/Plan.md');
    const folder = createFolder('Projects');
    const { app } = createMockApp([note, folder]);
    const manager = new FileContextManager(app, {});

    expect(manager.getCachedVaultFiles()).toEqual([note]);
    expect(manager.getCachedVaultFolders()).toEqual([{ name: 'Projects', path: 'Projects' }]);
    expect(() => manager.markFileCacheDirty()).not.toThrow();
    expect(() => manager.markFolderCacheDirty()).not.toThrow();
    manager.destroy();
  });

});
