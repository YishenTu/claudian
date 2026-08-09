/** @jest-environment jsdom */

import { Menu, type TAbstractFile, TFile, TFolder } from 'obsidian';

import { showVaultFileTreeMenu } from '@/features/chat/ui/vault-file-tree/VaultFileTreeMenu';

const mockShowVaultFileRenameModal = jest.fn();
const mockShowVaultFileCreateModal = jest.fn();

jest.mock('@/features/chat/ui/vault-file-tree/VaultFileRenameModal', () => ({
  showVaultFileRenameModal: (...args: unknown[]) => mockShowVaultFileRenameModal(...args),
}));
jest.mock('@/features/chat/ui/vault-file-tree/VaultFileCreateModal', () => ({
  showVaultFileCreateModal: (...args: unknown[]) => mockShowVaultFileCreateModal(...args),
}));

type TestMenu = Menu & {
  hideCallback?: () => void;
  items: Array<{
    clickHandler: (() => void) | null;
    title: string;
  }>;
};

const MockMenu = Menu as typeof Menu & {
  instances: TestMenu[];
  prototype: TestMenu;
};

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? '';
  file.basename = file.name.replace(/\.[^.]+$/, '');
  file.extension = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split('/').pop() ?? '';
  return folder;
}

function createHarness() {
  const folder = createFolder('Projects');
  const plan = createFile('Projects/Plan.md');
  const notes = createFile('Notes.md');
  const files = new Map<string, TAbstractFile>([
    [folder.path, folder],
    [plan.path, plan],
    [notes.path, notes],
  ]);
  const openedLeaves: Array<{ openFile: jest.Mock; type: unknown }> = [];
  const getLeaf = jest.fn((type: unknown) => {
    const leaf = { openFile: jest.fn().mockResolvedValue(undefined), type };
    openedLeaves.push(leaf);
    return leaf;
  });
  const trigger = jest.fn((event: string, menu: TestMenu) => {
    menu.addItem(item => item.setTitle('Plugin action'));
  });
  const app = {
    fileManager: {
      promptForDeletion: jest.fn().mockResolvedValue(true),
    },
    vault: {
      getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
    },
    workspace: { getLeaf, trigger },
  };
  const anchorElement = document.createElement('div');
  const context = {
    anchorElement,
    anchorRect: {
      bottom: 46,
      height: 0,
      left: 24,
      right: 24,
      top: 46,
      width: 0,
      x: 24,
      y: 46,
    },
    close: jest.fn(),
    restoreFocus: jest.fn(),
  };
  const focusPath = jest.fn();
  const writeClipboard = jest.fn().mockResolvedValue(undefined);

  return {
    app,
    context,
    files,
    focusPath,
    getLeaf,
    openedLeaves,
    trigger,
    writeClipboard,
  };
}

function clickMenuItem(menu: TestMenu, title: string): void {
  const item = menu.items.find(candidate => candidate.title === title);
  if (!item?.clickHandler) throw new Error(`Missing menu item: ${title}`);
  item.clickHandler();
}

describe('VaultFileTreeMenu', () => {
  beforeEach(() => {
    mockShowVaultFileCreateModal.mockReset();
    mockShowVaultFileRenameModal.mockReset();
    MockMenu.instances = [];
    MockMenu.prototype.onHide = function (callback: () => void): void {
      this.hideCallback = callback;
    };
    MockMenu.prototype.showAtPosition = jest.fn(function (this: TestMenu) {
      return this;
    });
  });

  it('shows safe file actions and publishes file-menu before display', () => {
    const harness = createHarness();

    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => false,
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      selectedPaths: ['Notes.md'],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    expect(menu.items.map(item => item.title)).toEqual([
      'Open',
      'Open in new tab',
      'Open in split',
      'Rename',
      'Copy path',
      'Delete',
      'Plugin action',
    ]);
    expect(harness.context.close).toHaveBeenCalledWith({ restoreFocus: false });
    expect(harness.trigger).toHaveBeenCalledWith(
      'file-menu',
      menu,
      harness.files.get('Projects/Plan.md'),
      'file-explorer-context-menu',
      null,
    );
    expect(harness.trigger.mock.invocationCallOrder[0])
      .toBeLessThan((menu.showAtPosition as jest.Mock).mock.invocationCallOrder[0]);
    expect(menu.showAtPosition).toHaveBeenCalledWith(
      { x: 24, y: 46 },
      harness.context.anchorElement.ownerDocument,
    );
  });

  it('offers rename for a single file and opens the rename modal', () => {
    const harness = createHarness();
    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => false,
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      selectedPaths: [],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    clickMenuItem(menu, 'Rename');

    expect(mockShowVaultFileRenameModal).toHaveBeenCalledWith(
      harness.app,
      harness.files.get('Projects/Plan.md'),
    );
  });

  it('opens a file in each public Obsidian leaf target and copies its path', async () => {
    const harness = createHarness();
    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => false,
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      selectedPaths: [],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    clickMenuItem(menu, 'Open');
    clickMenuItem(menu, 'Open in new tab');
    clickMenuItem(menu, 'Open in split');
    clickMenuItem(menu, 'Copy path');
    await Promise.resolve();

    expect(harness.getLeaf.mock.calls.map(call => call[0])).toEqual([
      false,
      'tab',
      'split',
    ]);
    for (const leaf of harness.openedLeaves) {
      expect(leaf.openFile).toHaveBeenCalledWith(harness.files.get('Projects/Plan.md'));
    }
    expect(harness.writeClipboard).toHaveBeenCalledWith('Projects/Plan.md');
  });

  it('uses the selected set for multi-target menus and restores the clicked row focus', async () => {
    const harness = createHarness();
    let destroyed = false;
    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => destroyed,
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      selectedPaths: ['Projects/Plan.md', 'Notes.md'],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    expect(menu.items.map(item => item.title)).toEqual([
      'Copy paths',
      'Delete',
      'Plugin action',
    ]);
    expect(harness.trigger).toHaveBeenCalledWith(
      'files-menu',
      menu,
      [harness.files.get('Projects/Plan.md'), harness.files.get('Notes.md')],
      'file-explorer-context-menu',
      null,
    );

    clickMenuItem(menu, 'Copy paths');
    await Promise.resolve();
    expect(harness.writeClipboard).toHaveBeenCalledWith('Projects/Plan.md\nNotes.md');

    menu.hideCallback?.();
    expect(harness.focusPath).toHaveBeenCalledWith('Projects/Plan.md');
    destroyed = true;
    menu.hideCallback?.();
    expect(harness.focusPath).toHaveBeenCalledTimes(1);
  });

  it('publishes a folder as a single file-menu target without navigation actions', () => {
    const harness = createHarness();
    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => false,
      item: { kind: 'directory', name: 'Projects', path: 'Projects/' },
      selectedPaths: [],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    expect(menu.items.map(item => item.title)).toEqual([
      'New note',
      'New folder',
      'Rename',
      'Copy path',
      'Delete',
      'Plugin action',
    ]);
    expect(harness.trigger).toHaveBeenCalledWith(
      'file-menu',
      menu,
      harness.files.get('Projects'),
      'file-explorer-context-menu',
      null,
    );

    clickMenuItem(menu, 'Rename');
    expect(mockShowVaultFileRenameModal).toHaveBeenCalledWith(
      harness.app,
      harness.files.get('Projects'),
    );

    clickMenuItem(menu, 'New note');
    expect(mockShowVaultFileCreateModal).toHaveBeenCalledWith(
      harness.app,
      harness.files.get('Projects'),
      'note',
    );

    clickMenuItem(menu, 'New folder');
    expect(mockShowVaultFileCreateModal).toHaveBeenCalledWith(
      harness.app,
      harness.files.get('Projects'),
      'folder',
    );
  });

  it('deletes a single item through Obsidian confirmation', async () => {
    const harness = createHarness();
    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => false,
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      selectedPaths: [],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    clickMenuItem(menu, 'Delete');
    await Promise.resolve();

    expect(harness.app.fileManager.promptForDeletion).toHaveBeenCalledWith(
      harness.files.get('Projects/Plan.md'),
    );
  });

  it('deletes each still-existing item in a multi-selection', async () => {
    const harness = createHarness();
    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => false,
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      selectedPaths: ['Projects/Plan.md', 'Notes.md'],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    clickMenuItem(menu, 'Delete');
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.app.fileManager.promptForDeletion.mock.calls).toEqual([
      [harness.files.get('Projects/Plan.md')],
      [harness.files.get('Notes.md')],
    ]);
  });

  it('does not delete a replacement that reuses a stale menu path', async () => {
    const harness = createHarness();
    const original = harness.files.get('Projects/Plan.md');
    const menu = showVaultFileTreeMenu({
      app: harness.app as never,
      context: harness.context,
      focusPath: harness.focusPath,
      isDestroyed: () => false,
      item: { kind: 'file', name: 'Plan.md', path: 'Projects/Plan.md' },
      selectedPaths: [],
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;
    const replacement = createFile('Projects/Plan.md');
    harness.files.set(replacement.path, replacement);

    clickMenuItem(menu, 'Delete');
    await Promise.resolve();

    expect(original).not.toBe(replacement);
    expect(harness.app.fileManager.promptForDeletion).not.toHaveBeenCalled();
  });
});
