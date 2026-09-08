import { existsSync } from 'fs';
import { type App, Notice, TFile, TFolder } from 'obsidian';
import { isAbsolute, win32 } from 'path';

export function isComposerPathAvailable(app: App, path: string): boolean {
  if (isAbsolute(path) || win32.isAbsolute(path)) return existsSync(path);
  const isFolder = path.endsWith('/');
  const target = app.vault.getAbstractFileByPath(isFolder ? path.slice(0, -1) : path);
  return isFolder ? target instanceof TFolder : target instanceof TFile;
}

export async function openComposerPath(app: App, path: string): Promise<void> {
  if (path.endsWith('/')) {
    const folder = app.vault.getAbstractFileByPath(path.slice(0, -1));
    if (!(folder instanceof TFolder)) {
      new Notice(`Folder not found in this vault: ${path}`);
      return;
    }
    try {
      const workspace = app.workspace;
      let leaf = workspace.getLeavesOfType('file-explorer')[0];
      if (!leaf) {
        leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf('tab');
        await leaf.setViewState({ type: 'file-explorer', active: true });
      }
      await workspace.revealLeaf(leaf);
      // The core Files view exposes these methods outside Obsidian's public typings.
      const view = leaf.view as unknown as {
        revealInFolder?: (target: TFolder) => Promise<void> | void;
        revealFile?: (target: TFolder) => Promise<void> | void;
      };
      const reveal = view.revealInFolder ?? view.revealFile;
      if (!reveal) throw new Error('File explorer cannot reveal folders');
      await reveal.call(view, folder);
    } catch {
      new Notice(`Could not reveal folder: ${path}`);
    }
    return;
  }
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice(`Note not found in this vault: ${path}`);
    return;
  }
  try {
    await app.workspace.getLeaf('tab').openFile(file);
  } catch {
    new Notice(`Could not open note: ${path}`);
  }
}
