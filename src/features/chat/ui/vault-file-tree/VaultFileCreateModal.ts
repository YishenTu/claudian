import type { App } from 'obsidian';
import { Notice, type TFolder } from 'obsidian';

import {
  hasVaultPathConflict,
  joinVaultPath,
  showVaultFileNameModal,
} from './VaultFileNameModal';

export type VaultFileCreationKind = 'folder' | 'note';

function getParentPath(parent: TFolder): string {
  return parent.isRoot() ? '' : parent.path;
}

function getCreationName(kind: VaultFileCreationKind, name: string): string {
  return kind === 'note' && !name.toLowerCase().endsWith('.md')
    ? `${name}.md`
    : name;
}

function getAvailableInitialName(
  app: App,
  parent: TFolder,
  kind: VaultFileCreationKind,
): string {
  const parentPath = getParentPath(parent);
  let suffix = 0;
  while (true) {
    const name = suffix === 0 ? 'Untitled' : `Untitled ${suffix}`;
    const targetPath = joinVaultPath(parentPath, getCreationName(kind, name));
    if (!hasVaultPathConflict(app, targetPath)) return name;
    suffix += 1;
  }
}

export function showVaultFileCreateModal(
  app: App,
  parent: TFolder,
  kind: VaultFileCreationKind,
): void {
  const itemLabel = kind === 'note' ? 'note' : 'folder';

  showVaultFileNameModal(app, {
    failureMessage: `Failed to create ${itemLabel}`,
    initialName: getAvailableInitialName(app, parent, kind),
    submitLabel: 'Create',
    title: kind === 'note' ? 'New note' : 'New folder',
    onSubmit: async (name) => {
      if (!parent.isRoot() && app.vault.getAbstractFileByPath(parent.path) !== parent) {
        return 'Destination folder is no longer available';
      }

      const creationName = getCreationName(kind, name);
      const targetPath = joinVaultPath(getParentPath(parent), creationName);
      if (hasVaultPathConflict(app, targetPath)) {
        return `A file or folder named "${creationName}" already exists`;
      }

      if (kind === 'folder') {
        await app.vault.createFolder(targetPath);
        return null;
      }

      const file = await app.vault.create(targetPath, '');
      try {
        await app.workspace.getLeaf(false).openFile(file);
      } catch {
        new Notice(`Created "${creationName}" but failed to open it`);
      }
      return null;
    },
  });
}
