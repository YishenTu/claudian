import type { App, TFile, Workspace, WorkspaceLeaf } from 'obsidian';

export function getVaultFileByPath(app: App, filePath: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (isVaultFile(file)) {
    return file;
  }
  return null;
}

export function focusWorkspaceLeaf(workspace: Workspace, leaf: WorkspaceLeaf): void {
  workspace.setActiveLeaf(leaf, { focus: true });
}

function isVaultFile(value: unknown): value is TFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<TFile>;
  return typeof candidate.path === 'string'
    && typeof candidate.basename === 'string';
}
