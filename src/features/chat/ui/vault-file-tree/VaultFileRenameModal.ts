import type { App, TAbstractFile } from 'obsidian';
import { TFile, TFolder } from 'obsidian';

import {
  hasVaultPathConflict,
  joinVaultPath,
  showVaultFileNameModal,
} from './VaultFileNameModal';

export function showVaultFileRenameModal(app: App, file: TAbstractFile): void {
  const initiallyMarkdown = file instanceof TFile
    && file.extension.toLowerCase() === 'md';

  showVaultFileNameModal(app, {
    failureMessage: `Failed to rename "${file.name}"`,
    initialName: initiallyMarkdown ? file.basename : file.name,
    submitLabel: 'Rename',
    title: file instanceof TFolder ? 'Rename folder' : 'Rename file',
    onSubmit: async (name) => {
      if (app.vault.getAbstractFileByPath(file.path) !== file) {
        return file instanceof TFolder
          ? 'Folder is no longer available'
          : 'File is no longer available';
      }

      const preserveMarkdownExtension = file instanceof TFile
        && file.extension.toLowerCase() === 'md';
      const targetName = preserveMarkdownExtension && !name.toLowerCase().endsWith('.md')
        ? `${name}.md`
        : name;
      const separatorIndex = file.path.lastIndexOf('/');
      const parentPath = separatorIndex >= 0 ? file.path.slice(0, separatorIndex) : '';
      const targetPath = joinVaultPath(parentPath, targetName);
      if (targetPath === file.path) return null;

      if (hasVaultPathConflict(app, targetPath, file)) {
        return `A file or folder named "${targetName}" already exists`;
      }

      await app.fileManager.renameFile(file, targetPath);
      return null;
    },
  });
}
