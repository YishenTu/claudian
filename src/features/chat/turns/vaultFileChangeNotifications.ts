import type { App } from 'obsidian';
import { TFile } from 'obsidian';

import { isEditTool, TOOL_APPLY_PATCH } from '@/core/tools/toolNames';
import type { ScriptToolCallItem } from '@/core/types';
import { getVaultPath, normalizePathForVault } from '@/utils/path';

/**
 * Nudges Obsidian's vault after a Write/Edit/NotebookEdit so the file tree
 * refreshes. Direct `fs` writes bypass the Vault API, and macOS + iCloud
 * FSWatcher often misses the event.
 */
export function notifyVaultFileChange(app: App, input: Record<string, unknown>): void {
  const rawPathValue = input.file_path ?? input.notebook_path;
  const rawPath = typeof rawPathValue === 'string' ? rawPathValue : undefined;
  const vaultPath = getVaultPath(app);
  const relativePath = normalizePathForVault(rawPath, vaultPath);
  if (!relativePath || relativePath.startsWith('/')) return;

  window.setTimeout(() => {
    const { vault } = app;
    const file = vault.getAbstractFileByPath(relativePath);
    if (file instanceof TFile) {
      // Existing file — tell listeners the content changed
      vault.trigger('modify', file);
    } else {
      // New file — scan parent directory so Obsidian discovers it
      const parentDir = relativePath.includes('/')
        ? relativePath.substring(0, relativePath.lastIndexOf('/'))
        : '';
      vault.adapter.list(parentDir).catch(() => { /* ignore */ });
    }
  }, 200);
}

/**
 * Refreshes files nested script calls finished changing since the previous snapshot.
 * A later script failure or cancellation does not undo them.
 */
export function notifyScriptFileChanges(
  app: App,
  previous: readonly ScriptToolCallItem[] | undefined,
  next: readonly ScriptToolCallItem[] | undefined,
): void {
  next?.forEach((call, index) => {
    if (call.status !== 'completed' || !call.input || previous?.[index]?.status === 'completed') return;
    if (isEditTool(call.name)) notifyVaultFileChange(app, call.input);
    else if (call.name === TOOL_APPLY_PATCH) notifyApplyPatchFileChanges(app, call.input);
  });
}

/** Refreshes vault for each file path in an apply_patch changes array or patch text. */
export function notifyApplyPatchFileChanges(app: App, input: Record<string, unknown>): void {
  const notified = new Set<string>();

  // Codex fileChange events supply structured changes.
  const changes = input.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (change && typeof change === 'object' && !Array.isArray(change)) {
        const changeRecord = change as Record<string, unknown>;
        if (typeof changeRecord.path === 'string') {
          notified.add(changeRecord.path);
          notifyVaultFileChange(app, { file_path: changeRecord.path });
        }
      }
    }
  }

  // Parse file paths from patch text markers (current custom_tool_call format)
  const patchText = typeof input.patch === 'string' ? input.patch : '';
  if (patchText) {
    for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const filePath = match[1]?.trim();
      if (filePath && !notified.has(filePath)) {
        notifyVaultFileChange(app, { file_path: filePath });
      }
    }
  }
}
