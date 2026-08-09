import type { App, Workspace, WorkspaceLeaf } from 'obsidian';
import { Notice, TFile } from 'obsidian';

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
export async function openVaultFile(app: App, rawPath: string): Promise<boolean> {
  try {
    const relativePath = normalizePathForVault(rawPath, getVaultPath(app));
    if (!relativePath || relativePath.startsWith('/')) {
      new Notice(`Could not open vault file: ${rawPath}`);
      return false;
    }

    const file = app.vault.getAbstractFileByPath(relativePath);
    if (!(file instanceof TFile)) {
      new Notice(`File not found in vault: ${relativePath}`);
      return false;
    }

    await app.workspace.getLeaf().openFile(file);
    return true;
  } catch {
    new Notice(`Could not open vault file: ${rawPath}`);
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
