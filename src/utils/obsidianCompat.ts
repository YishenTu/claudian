import type { EditorView } from '@codemirror/view';
import type { App, Editor, TFile, Workspace, WorkspaceLeaf } from 'obsidian';
import { View } from 'obsidian';

/**
 * Gets the CodeMirror EditorView from an Obsidian Editor.
 * Obsidian's Editor type doesn't expose the internal `.cm` property.
 */
export function getEditorView(editor: Editor): EditorView | undefined {
  return (editor as unknown as { cm?: EditorView }).cm;
}

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

function isVaultFile(value: unknown): value is TFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<TFile>;
  return typeof candidate.path === 'string'
    && typeof candidate.basename === 'string';
}

/** These desktop chrome refresh hooks are not part of Obsidian's published typings. */
export function refreshWorkspaceViewChrome(workspace: Workspace, leaf: WorkspaceLeaf): void {
  const hostLeaf = leaf as WorkspaceLeaf & { updateHeader?: () => void };
  if (typeof hostLeaf.updateHeader === 'function') hostLeaf.updateHeader();
  if (workspace.getActiveViewOfType(View)?.leaf !== leaf) return;
  const hostWorkspace = workspace as Workspace & { updateTitle?: () => void };
  if (typeof hostWorkspace.updateTitle === 'function') hostWorkspace.updateTitle();
}
