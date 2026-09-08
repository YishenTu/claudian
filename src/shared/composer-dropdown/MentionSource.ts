import type { TFile } from 'obsidian';

import { formatVaultFileMention } from '../mention/formatMention';
import type { FolderMentionItem } from '../mention/types';
import type {
  ComposerDropdownFolderItem,
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerDropdownValueItem,
  ComposerSelectionAction,
  ComposerTriggerMatch,
} from './types';

export interface MentionSourceCallbacks {
  readonly getCachedVaultFiles: () => readonly TFile[];
  readonly getCachedVaultFolders: () => readonly FolderMentionItem[];
  readonly normalizePathForVault: (path: string | undefined | null) => string | null;
}

export interface MentionSourceOptions {
  readonly formatVaultFileMention?: (path: string) => string;
  readonly getExtensionFolders?: (
    signal: AbortSignal,
  ) => Promise<readonly ComposerDropdownFolderItem[]> | readonly ComposerDropdownFolderItem[];
}

export class MentionSource implements ComposerDropdownSource {
  readonly id = 'mentions';
  readonly inputLoadPolicy = 'debounced';

  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly callbacks: MentionSourceCallbacks,
    private readonly options: MentionSourceOptions = {},
  ) {}

  private extensionFoldersLoader = this.options.getExtensionFolders;

  destroy(): void {
    this.listeners.clear();
  }

  load(
    match: ComposerTriggerMatch,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownItem[]> | readonly ComposerDropdownItem[] {
    const query = match.query.toLocaleLowerCase();
    const extensionFolders = this.extensionFoldersLoader?.(signal);
    if (extensionFolders instanceof Promise) {
      return extensionFolders
        .then(folders => this.finishRootItems(folders, query, signal))
        .catch(error => {
          if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw error;
          }
          return this.finishRootItems([], query, signal);
        });
    }
    return this.finishRootItems(extensionFolders ?? [], query, signal);
  }

  match(input: string, cursor: number): ComposerTriggerMatch | null {
    const before = input.slice(0, cursor);
    const index = before.lastIndexOf('@');
    if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) return null;
    const query = before.slice(index + 1);
    return {
      atInputStart: index === 0,
      end: cursor,
      query,
      start: index,
      trigger: '@',
    };
  }

  select(
    item: ComposerDropdownValueItem,
    _match: ComposerTriggerMatch,
  ): ComposerSelectionAction {
    return {
      kind: 'replace',
      text: item.replacement,
    };
  }

  setExtensionFoldersLoader(
    loader: MentionSourceOptions['getExtensionFolders'],
  ): void {
    this.extensionFoldersLoader = loader;
    this.notify();
  }

  invalidate(): void {
    this.notify();
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finishRootItems(
    extensionFolders: readonly ComposerDropdownFolderItem[],
    query: string,
    signal: AbortSignal,
  ): readonly ComposerDropdownItem[] {
    if (signal.aborted) throw new DOMException('Mention lookup was cancelled.', 'AbortError');
    const items: ComposerDropdownItem[] = [];
    for (const folder of extensionFolders) {
      if (folder.label.toLocaleLowerCase().includes(query)) items.push(folder);
    }
    items.push(...this.vaultItems(query));
    return items;
  }

  private vaultItems(query: string): readonly ComposerDropdownValueItem[] {
    type Scored = {
      readonly item: ComposerDropdownValueItem;
      readonly mtime: number;
      readonly name: string;
      readonly starts: boolean;
      readonly type: 'file' | 'folder';
    };
    const compare = (left: Scored, right: Scored): number => {
      if (left.starts !== right.starts) return left.starts ? -1 : 1;
      if (left.mtime !== right.mtime) return right.mtime - left.mtime;
      if (left.type !== right.type) return left.type === 'file' ? -1 : 1;
      return left.name.localeCompare(right.name);
    };
    const files = this.callbacks.getCachedVaultFiles();
    const folderMtimes = new Map<string, number>();
    for (const file of files) {
      const parts = file.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        const path = parts.slice(0, index).join('/');
        folderMtimes.set(path, Math.max(folderMtimes.get(path) ?? 0, file.stat.mtime));
      }
    }

    const folders: Scored[] = this.callbacks.getCachedVaultFolders()
      .map(folder => ({
        name: folder.name,
        path: folder.path.replace(/\\/g, '/').replace(/\/+$/, ''),
      }))
      .filter(folder => folder.path.length > 0 && (
        folder.path.toLocaleLowerCase().includes(query)
        || folder.name.toLocaleLowerCase().includes(query)
      ))
      .map((folder): Scored => {
        const normalized = this.callbacks.normalizePathForVault(folder.path) ?? folder.path;
        return {
          item: {
            className: 'is-vault-folder',
            icon: 'folder',
            id: `vault-folder:${folder.path}`,
            kind: 'value',
            label: `@${folder.path}/`,
            replacement: `@${normalized}/ `,
          },
          mtime: folderMtimes.get(folder.path) ?? 0,
          name: folder.name,
          starts: folder.name.toLocaleLowerCase().startsWith(query),
          type: 'folder' as const,
        };
      })
      .sort(compare)
      .slice(0, 50);

    const fileItems: Scored[] = files
      .filter(file => file.path.toLocaleLowerCase().includes(query)
        || file.name.toLocaleLowerCase().includes(query))
      .map((file): Scored => {
        const normalized = this.callbacks.normalizePathForVault(file.path) ?? file.path;
        return {
          item: {
            icon: 'file-text',
            id: `vault-file:${file.path}`,
            kind: 'value',
            label: file.path,
            replacement: (this.options.formatVaultFileMention ?? formatVaultFileMention)(normalized),
          },
          mtime: file.stat.mtime,
          name: file.name,
          starts: file.name.toLocaleLowerCase().startsWith(query),
          type: 'file' as const,
        };
      })
      .sort(compare)
      .slice(0, 100);

    return [...folders, ...fileItems]
      .sort(compare)
      .map(scored => scored.item);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
