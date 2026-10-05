import { TFile, TFolder } from 'obsidian';

import { FileContextManager } from '@/features/chat/composer/FileContextManager';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

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
    const manager = new FileContextManager(new VaultMentionDataProvider(app));
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

  it('shares vault cache reads across composers while keeping mention selection independent', async () => {
    const note = createFile('Notes/Plan.md');
    const folder = createFolder('Projects');
    const { app } = createMockApp([note, folder]);
    const data = new VaultMentionDataProvider(app);
    const first = new FileContextManager(data);
    const second = new FileContextManager(data);
    expect(first.getCachedVaultFiles()).toEqual([note]);
    expect(second.getCachedVaultFiles()).toEqual([note]);
    expect(first.getCachedVaultFolders()).toEqual([{ name: 'Projects', path: 'Projects' }]);
    expect(second.getCachedVaultFolders()).toEqual([{ name: 'Projects', path: 'Projects' }]);
    jest.runOnlyPendingTimers();
    expect((app as any).vault.getFiles).toHaveBeenCalledTimes(1);
    expect((app as any).vault.getAllLoadedFiles).toHaveBeenCalledTimes(1);
    first.destroy();
    data.markFilesDirty();
    expect(second.getCachedVaultFiles()).toEqual([note]);
    expect((app as any).vault.getFiles).toHaveBeenCalledTimes(2);
    const source = second.getMentionSource();
    const items = await source.load(source.match('@Plan', 5)!, new AbortController().signal);
    expect(items.some(item => item.label === 'Notes/Plan.md')).toBe(true);
    second.destroy();
  });

});

it('offers only eligible sessions and follows the captured main/parent conversation getter', async () => {
  const { app } = createMockApp([createFile('Review.md')]);
  let current = 'conv-1-main';
  const rows = [
    { id: current, title: 'Main', hasSessionReference: true },
    { id: 'conv-2-other', title: 'Other', hasSessionReference: true },
    { id: 'conv-3-old', title: 'Archived', hasSessionReference: true, isArchived: true },
    { id: 'conv-4-legacy', title: 'Legacy', hasSessionReference: true, isLegacySession: true },
    { id: 'conv-5-missing', title: 'Missing', hasSessionReference: false },
  ].map(row => ({ ...row, providerId: 'claude' as const, createdAt: 0, lastActivityAt: 0, messageCount: 1, preview: '' }));
  const manager = new FileContextManager(new VaultMentionDataProvider(app), {
    getConversationList: () => rows,
    getCurrentConversationId: () => current,
  });
  try {
    const source = manager.getMentionSource();
    const load = () => source.load(source.match('@', 1)!, new AbortController().signal);
    expect((await load()).map(item => item.label)).toEqual(['Review.md', 'Other']);
    current = 'conv-2-other';
    expect((await load()).map(item => item.label)).toEqual(['Review.md', 'Main']);
    const plain = new FileContextManager(new VaultMentionDataProvider(app));
    expect((await plain.getMentionSource().load(source.match('@', 1)!, new AbortController().signal)).map(item => item.label)).toEqual(['Review.md']);
    plain.destroy();
  } finally { manager.destroy(); }
});
