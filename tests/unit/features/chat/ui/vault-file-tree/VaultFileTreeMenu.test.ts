/** @jest-environment jsdom */

import { Menu, type TAbstractFile, TFile, TFolder } from 'obsidian';

import { showVaultFileTreeMenu } from '@/features/chat/ui/vault-file-tree/VaultFileTreeMenu';

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
  const sourceLeaf = { id: 'claudian-leaf' };

  return {
    app,
    context,
    files,
    focusPath,
    getLeaf,
    openedLeaves,
    sourceLeaf,
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
      sourceLeaf: harness.sourceLeaf as never,
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    expect(menu.items.map(item => item.title)).toEqual([
      'Open',
      'Open in new tab',
      'Open in split',
      'Open in new window',
      'Copy path',
      'Plugin action',
    ]);
    expect(harness.context.close).toHaveBeenCalledWith({ restoreFocus: false });
    expect(harness.trigger).toHaveBeenCalledWith(
      'file-menu',
      menu,
      harness.files.get('Projects/Plan.md'),
      'file-explorer',
      harness.sourceLeaf,
    );
    expect(harness.trigger.mock.invocationCallOrder[0])
      .toBeLessThan((menu.showAtPosition as jest.Mock).mock.invocationCallOrder[0]);
    expect(menu.showAtPosition).toHaveBeenCalledWith(
      { x: 24, y: 46 },
      harness.context.anchorElement.ownerDocument,
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
      sourceLeaf: harness.sourceLeaf as never,
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    clickMenuItem(menu, 'Open');
    clickMenuItem(menu, 'Open in new tab');
    clickMenuItem(menu, 'Open in split');
    clickMenuItem(menu, 'Open in new window');
    clickMenuItem(menu, 'Copy path');
    await Promise.resolve();

    expect(harness.getLeaf.mock.calls.map(call => call[0])).toEqual([
      false,
      'tab',
      'split',
      'window',
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
      sourceLeaf: harness.sourceLeaf as never,
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    expect(menu.items.map(item => item.title)).toEqual(['Copy paths', 'Plugin action']);
    expect(harness.trigger).toHaveBeenCalledWith(
      'files-menu',
      menu,
      [harness.files.get('Projects/Plan.md'), harness.files.get('Notes.md')],
      'file-explorer',
      harness.sourceLeaf,
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
      sourceLeaf: harness.sourceLeaf as never,
      writeClipboard: harness.writeClipboard,
    }) as TestMenu;

    expect(menu.items.map(item => item.title)).toEqual(['Copy path', 'Plugin action']);
    expect(harness.trigger).toHaveBeenCalledWith(
      'file-menu',
      menu,
      harness.files.get('Projects'),
      'file-explorer',
      harness.sourceLeaf,
    );
  });
});
