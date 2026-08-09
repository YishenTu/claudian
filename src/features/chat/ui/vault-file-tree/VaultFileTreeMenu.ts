import type {
  ContextMenuItem,
  ContextMenuOpenContext,
} from '@pierre/trees';
import type { App, PaneType, TAbstractFile } from 'obsidian';
import { Menu, Notice, TFile, TFolder } from 'obsidian';

import { showVaultFileCreateModal } from './VaultFileCreateModal';
import { showVaultFileRenameModal } from './VaultFileRenameModal';
import { toVaultPath } from './vaultFileTreePaths';

export type VaultFileTreeMenuOptions = {
  app: App;
  context: ContextMenuOpenContext;
  focusPath: (path: string) => void;
  isDestroyed: () => boolean;
  item: ContextMenuItem;
  selectedPaths: readonly string[];
  writeClipboard?: (text: string) => Promise<void>;
};

const FILE_EXPLORER_CONTEXT_MENU_SOURCE = 'file-explorer-context-menu';

function getMenuPaths(itemPath: string, selectedPaths: readonly string[]): readonly string[] {
  return selectedPaths.length > 1 && selectedPaths.includes(itemPath)
    ? selectedPaths
    : [itemPath];
}

function openFile(
  app: App,
  file: TFile,
  leafTarget: PaneType | false,
): void {
  void Promise.resolve()
    .then(() => app.workspace.getLeaf(leafTarget).openFile(file))
    .catch(() => new Notice(`Failed to open ${file.name}`));
}

function getClipboardWriter(options: VaultFileTreeMenuOptions): (text: string) => Promise<void> {
  if (options.writeClipboard) return options.writeClipboard;

  return async (text: string): Promise<void> => {
    const clipboard = options.context.anchorElement.ownerDocument.defaultView?.navigator.clipboard;
    if (!clipboard) throw new Error('Clipboard is unavailable');
    await clipboard.writeText(text);
  };
}

function copyPaths(options: VaultFileTreeMenuOptions, paths: readonly string[]): void {
  const text = paths.map(toVaultPath).join('\n');
  void Promise.resolve()
    .then(() => getClipboardWriter(options)(text))
    .catch(() => new Notice(paths.length === 1 ? 'Failed to copy path' : 'Failed to copy paths'));
}

async function deleteFiles(app: App, files: readonly TAbstractFile[]): Promise<void> {
  for (const file of files) {
    const currentFile = app.vault.getAbstractFileByPath(file.path);
    if (currentFile !== file) continue;

    try {
      await app.fileManager.promptForDeletion(currentFile);
    } catch {
      new Notice(`Failed to delete "${file.name}"`);
    }
  }
}

export function showVaultFileTreeMenu(options: VaultFileTreeMenuOptions): Menu | null {
  const paths = getMenuPaths(options.item.path, options.selectedPaths);
  const targets = paths.flatMap((path) => {
    const file = options.app.vault.getAbstractFileByPath(toVaultPath(path));
    return file ? [{ file, path }] : [];
  });
  const files = targets.map(target => target.file);
  const resolvedPaths = targets.map(target => target.path);
  if (files.length === 0) {
    options.context.close();
    return null;
  }

  const menu = new Menu().setUseNativeMenu(false);
  const singleFile = files.length === 1 && files[0] instanceof TFile ? files[0] : null;
  const singleFolder = files.length === 1 && files[0] instanceof TFolder ? files[0] : null;

  if (singleFolder) {
    menu.addItem(item => item
      .setTitle('New note')
      .setIcon('file-plus')
      .onClick(() => showVaultFileCreateModal(options.app, singleFolder, 'note')));
    menu.addItem(item => item
      .setTitle('New folder')
      .setIcon('folder-plus')
      .onClick(() => showVaultFileCreateModal(options.app, singleFolder, 'folder')));
    menu.addSeparator();
  }

  if (singleFile) {
    menu.addItem(item => item
      .setTitle('Open')
      .setIcon('file')
      .onClick(() => openFile(options.app, singleFile, false)));
    menu.addItem(item => item
      .setTitle('Open in new tab')
      .setIcon('file-plus')
      .onClick(() => openFile(options.app, singleFile, 'tab')));
    menu.addItem(item => item
      .setTitle('Open in split')
      .setIcon('columns-2')
      .onClick(() => openFile(options.app, singleFile, 'split')));
    menu.addSeparator();
  }

  if (files.length === 1) {
    menu.addItem(item => item
      .setTitle('Rename')
      .setIcon('pencil')
      .onClick(() => showVaultFileRenameModal(options.app, files[0])));
  }

  menu.addItem(item => item
    .setTitle(files.length === 1 ? 'Copy path' : 'Copy paths')
    .setIcon('copy')
    .onClick(() => copyPaths(options, resolvedPaths)));

  menu.addItem(item => item
    .setTitle('Delete')
    .setIcon('trash-2')
    .setWarning(true)
    .onClick(() => {
      void deleteFiles(options.app, files);
    }));

  if (files.length === 1) {
    options.app.workspace.trigger(
      'file-menu',
      menu,
      files[0],
      FILE_EXPLORER_CONTEXT_MENU_SOURCE,
      null,
    );
  } else {
    options.app.workspace.trigger(
      'files-menu',
      menu,
      files,
      FILE_EXPLORER_CONTEXT_MENU_SOURCE,
      null,
    );
  }

  options.context.close({ restoreFocus: false });
  menu.onHide(() => {
    if (!options.isDestroyed()) options.focusPath(options.item.path);
  });
  menu.showAtPosition(
    { x: options.context.anchorRect.x, y: options.context.anchorRect.y },
    options.context.anchorElement.ownerDocument,
  );
  return menu;
}
