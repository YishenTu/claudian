import type {
  ContextMenuItem,
  ContextMenuOpenContext,
} from '@pierre/trees';
import type { App, PaneType, WorkspaceLeaf } from 'obsidian';
import { Menu, Notice, TFile } from 'obsidian';

import { toVaultPath } from './vaultFileTreePaths';

export type VaultFileTreeMenuOptions = {
  app: App;
  context: ContextMenuOpenContext;
  focusPath: (path: string) => void;
  isDestroyed: () => boolean;
  item: ContextMenuItem;
  selectedPaths: readonly string[];
  sourceLeaf?: WorkspaceLeaf;
  writeClipboard?: (text: string) => Promise<void>;
};

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
    menu.addItem(item => item
      .setTitle('Open in new window')
      .setIcon('picture-in-picture-2')
      .onClick(() => openFile(options.app, singleFile, 'window')));
    menu.addSeparator();
  }

  menu.addItem(item => item
    .setTitle(files.length === 1 ? 'Copy path' : 'Copy paths')
    .setIcon('copy')
    .onClick(() => copyPaths(options, resolvedPaths)));

  if (files.length === 1) {
    options.app.workspace.trigger(
      'file-menu',
      menu,
      files[0],
      'file-explorer',
      options.sourceLeaf,
    );
  } else {
    options.app.workspace.trigger(
      'files-menu',
      menu,
      files,
      'file-explorer',
      options.sourceLeaf,
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
