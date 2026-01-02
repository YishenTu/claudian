/**
 * File opener utility for chips.
 */

import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import * as path from 'path';

import { getVaultPath } from '../../../../utils/path';

export interface FileOpenResult {
  opened: boolean;
  openedWithDefaultApp: boolean;
}

export async function openFileFromChip(
  app: App,
  normalizePathForVault: (path: string | undefined | null) => string | null,
  filePath: string
): Promise<FileOpenResult> {
  const normalizedPath = normalizePathForVault(filePath);
  if (!normalizedPath) return { opened: false, openedWithDefaultApp: false };

  const file = app.vault.getAbstractFileByPath(normalizedPath);
  if (file instanceof TFile) {
    try {
      await app.workspace.getLeaf('tab').openFile(file);
      return { opened: true, openedWithDefaultApp: false };
    } catch (error) {
      console.warn('Failed to open file in Obsidian:', error);
      const vaultPath = getVaultPath(app);
      const absolutePath = vaultPath ? path.join(vaultPath, file.path) : file.path;
      const opened = await openWithDefaultApp(app, absolutePath);
      return { opened, openedWithDefaultApp: opened };
    }
  }

  if (path.isAbsolute(normalizedPath)) {
    const opened = await openWithDefaultApp(app, normalizedPath);
    return { opened, openedWithDefaultApp: opened };
  }

  return { opened: false, openedWithDefaultApp: false };
}

async function openWithDefaultApp(app: App, filePath: string): Promise<boolean> {
  if (!filePath) return false;

  const appAny = app as any;
  if (typeof appAny.openWithDefaultApp === 'function') {
    try {
      await appAny.openWithDefaultApp(filePath);
      return true;
    } catch (err) {
      console.error('Failed to open file in default app:', err);
      return false;
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron');
    if (shell?.openPath) {
      const result = await shell.openPath(filePath);
      if (result) {
        console.error('Failed to open file in default app:', result);
        return false;
      }
      return true;
    }
    if (shell?.openExternal) {
      const target = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
      await shell.openExternal(target);
      return true;
    }
  } catch (err) {
    console.error('Failed to open file in default app:', err);
  }

  return false;
}
