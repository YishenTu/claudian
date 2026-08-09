import type { App, Workspace, WorkspaceLeaf } from 'obsidian';
import { Notice, TFile } from 'obsidian';

import { type FileReference,parseFileReference } from './FileReference';
import { getVaultPath, normalizePathForVault } from './path';

export function getVaultFileByPath(app: App, filePath: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (isVaultFile(file)) {
    return file;
  }
  return null;
}

export async function revealWorkspaceLeaf(workspace: Workspace, leaf: WorkspaceLeaf): Promise<void> {
  await workspace.revealLeaf(leaf);
}

/** Opens a provider-reported vault path in Obsidian. */
export async function openVaultFile(app: App, value: string | FileReference): Promise<boolean> {
  const reference = typeof value === 'string' ? parseFileReference(value) : value;
  try {
    const relativePath = normalizePathForVault(reference.path, getVaultPath(app));
    if (!relativePath || relativePath.startsWith('/')) {
      new Notice(`Could not open vault file: ${reference.path}`);
      return false;
    }

    const file = app.vault.getAbstractFileByPath(relativePath);
    if (!(file instanceof TFile)) {
      new Notice(`File not found in vault: ${relativePath}`);
      return false;
    }

    const leaf = app.workspace.getLeaf();
    await leaf.openFile(file);

    if (reference.lineStart !== undefined) {
      const editor = (leaf.view as { editor?: {
        focus?: () => void;
        getLine?: (line: number) => string;
        setSelection?: (anchor: { line: number; ch: number }, head?: { line: number; ch: number }) => void;
      } }).editor;
      if (editor?.setSelection) {
        const startLine = Math.max(0, reference.lineStart - 1);
        const endLine = Math.max(startLine, (reference.lineEnd ?? reference.lineStart) - 1);
        const endCh = editor.getLine ? editor.getLine(endLine).length : 0;
        editor.setSelection({ line: startLine, ch: 0 }, { line: endLine, ch: endCh });
        editor.focus?.();
      }
    }
    return true;
  } catch {
    new Notice(`Could not open vault file: ${reference.path}`);
    return false;
  }
}

function isVaultFile(value: unknown): value is TFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<TFile>;
  return typeof candidate.path === 'string'
    && typeof candidate.basename === 'string';
}
