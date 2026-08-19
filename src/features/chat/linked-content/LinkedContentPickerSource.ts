import type { TFile } from 'obsidian';

import { normalizeLinkedContentPath } from '@/core/path/LinkedContentPath';

export type LinkedContentPickerItemKind = 'none' | 'file' | 'folder';

export interface LinkedContentPickerItem {
  readonly id: string;
  readonly kind: LinkedContentPickerItemKind;
  readonly path: string | null;
  readonly label: string;
  readonly detail: string;
  readonly icon: string;
}

export interface LinkedContentPickerSourceOptions {
  readonly getCachedVaultFiles: () => readonly TFile[];
  readonly getCachedVaultFolders: () => readonly { readonly name: string; readonly path: string }[];
}

function isVisiblePath(path: string): boolean {
  return !path.split('/').some(segment => segment.startsWith('.'));
}

function fileLabel(file: TFile): string {
  return file.extension.toLocaleLowerCase() === 'md' ? file.basename : file.name;
}

export class LinkedContentPickerSource {
  constructor(private readonly options: LinkedContentPickerSourceOptions) {}

  list(): readonly LinkedContentPickerItem[] {
    const items: LinkedContentPickerItem[] = [
      {
        id: 'none',
        kind: 'none',
        path: null,
        label: 'None',
        detail: 'No Linked content',
        icon: 'circle-slash',
      },
    ];
    const seenPaths = new Set<string>();

    const folders = this.options.getCachedVaultFolders()
      .map(folder => ({ folder, path: normalizeLinkedContentPath(folder.path) }))
      .filter((entry): entry is { folder: { readonly name: string; readonly path: string }; path: string } => (
        entry.path !== null && isVisiblePath(entry.path)
      ))
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const { folder, path } of folders) {
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      items.push({
        id: `folder:${path}`,
        kind: 'folder',
        path,
        label: folder.name || path.split('/').pop() || path,
        detail: path,
        icon: 'folder',
      });
    }

    const files = this.options.getCachedVaultFiles()
      .map(file => ({ file, path: normalizeLinkedContentPath(file.path) }))
      .filter((entry): entry is { file: TFile; path: string } => (
        entry.path !== null && isVisiblePath(entry.path)
      ))
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const { file, path } of files) {
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      items.push({
        id: `file:${path}`,
        kind: 'file',
        path,
        label: fileLabel(file),
        detail: path,
        icon: file.extension.toLocaleLowerCase() === 'md' ? 'file-text' : 'file',
      });
    }

    return items;
  }
}
