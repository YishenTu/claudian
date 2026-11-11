import type { TFile } from 'obsidian';

import { formatVaultFileMention } from '../mention/formatMention';
import type { FolderMentionItem } from '../mention/types';
import type {
  ComposerDropdownSource,
  ComposerDropdownValueItem,
  ComposerSelectionAction,
  ComposerTriggerMatch,
} from './types';

export interface MentionSourceCallbacks {
  readonly getCachedVaultFiles: () => readonly TFile[];
  readonly getCachedVaultFolders: () => readonly FolderMentionItem[];
}

export interface MentionSourceOptions {
  readonly getSessionItems?: () => readonly SessionMentionItem[];
  readonly formatVaultFileMention?: (path: string) => string;
}

type SessionMentionItem = ComposerDropdownValueItem & { readonly mtime: number };

/** Case-insensitive containment shared by the open-trigger check and result filtering. */
function containsQuery(query: string, ...fields: readonly string[]): boolean {
  return fields.some(field => field.toLocaleLowerCase().includes(query));
}

function normalizeFolderPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export class MentionSource implements ComposerDropdownSource {
  readonly id = 'mentions';

  private readonly listeners = new Set<() => void>();
  /** Last spaced query that matched no name; kept only while each match extends it. */
  #unmatchedQuery: string | null = null;

  constructor(
    private readonly callbacks: MentionSourceCallbacks,
    private readonly options: MentionSourceOptions = {},
  ) {}

  destroy(): void {
    this.listeners.clear();
  }

  load(
    match: ComposerTriggerMatch,
    signal: AbortSignal,
  ): readonly ComposerDropdownValueItem[] {
    if (signal.aborted) throw new DOMException('Mention lookup was cancelled.', 'AbortError');
    return this.#vaultItems(match.query.toLocaleLowerCase(), this.options.getSessionItems?.() ?? []);
  }

  match(input: string, cursor: number): ComposerTriggerMatch | null {
    const unmatchedQuery = this.#unmatchedQuery;
    this.#unmatchedQuery = null;
    const before = input.slice(0, cursor);
    const index = before.lastIndexOf('@');
    if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) return null;
    const query = before.slice(index + 1);
    // A completed `@[label](target)` mention token is not an open trigger.
    if (/^\[(?:\\[\\\]]|[^\]\\\r\n])*\]\([^\s)]+\)/.test(query)) return null;
    // Once a spaced query matches no name, further typing cannot match again; close for the rest of the line.
    if (/\s/.test(query)) {
      const lowerQuery = query.toLocaleLowerCase();
      // Substring search is monotonic, so extending a rejected query skips the vault scan.
      if ((unmatchedQuery !== null && lowerQuery.startsWith(unmatchedQuery)) || !this.#hasAnyMatch(lowerQuery)) {
        this.#unmatchedQuery = lowerQuery;
        return null;
      }
    }
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

  invalidate(): void {
    this.#unmatchedQuery = null;
    this.notify();
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #hasAnyMatch(query: string): boolean {
    return this.callbacks.getCachedVaultFolders().some(folder => {
      const path = normalizeFolderPath(folder.path);
      return path !== '' && containsQuery(query, folder.name, path);
    })
      || this.callbacks.getCachedVaultFiles().some(file => containsQuery(query, file.name, file.path))
      || (this.options.getSessionItems?.() ?? []).some(item => containsQuery(query, item.label));
  }

  #vaultItems(query: string, sessions: readonly SessionMentionItem[]): readonly ComposerDropdownValueItem[] {
    type Scored = {
      readonly path: string;
      readonly mtime: number;
      readonly name: string;
      readonly starts: boolean;
      readonly type: 'file' | 'folder' | 'session';
      readonly item?: ComposerDropdownValueItem;
    };
    const compare = (left: Scored, right: Scored): number => {
      if (left.starts !== right.starts) return left.starts ? -1 : 1;
      if (left.mtime !== right.mtime) return right.mtime - left.mtime;
      if (left.type !== right.type) return ['file', 'folder', 'session'].indexOf(left.type) - ['file', 'folder', 'session'].indexOf(right.type);
      return left.name.localeCompare(right.name);
    };
    // Keep a small sorted result set instead of sorting every matching vault entry.
    // Insert after equal entries to preserve the vault's stable tie order.
    const retain = (items: Scored[], item: Scored, limit: number): void => {
      if (items.length === limit && compare(item, items[limit - 1]) >= 0) return;
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(item, items[middle]) < 0) high = middle;
        else low = middle + 1;
      }
      items.splice(low, 0, item);
      if (items.length > limit) items.pop();
    };
    const matchingFolders: Scored[] = [];
    for (const folder of this.callbacks.getCachedVaultFolders()) {
      const path = normalizeFolderPath(folder.path);
      if (!path) continue;
      if (query && !containsQuery(query, folder.name, path)) continue;
      const name = query ? folder.name.toLocaleLowerCase() : '';
      matchingFolders.push({
        path, name: folder.name, mtime: 0, starts: name.startsWith(query), type: 'folder',
      });
    }

    const directoryMtimes = new Map<string, number>();
    const fileItems: Scored[] = [];
    for (const file of this.callbacks.getCachedVaultFiles()) {
      if (matchingFolders.length > 0) {
        const separator = file.path.lastIndexOf('/');
        if (separator >= 0) {
          const directory = file.path.slice(0, separator);
          directoryMtimes.set(directory, Math.max(directoryMtimes.get(directory) ?? 0, file.stat.mtime));
        }
      }
      if (query && !containsQuery(query, file.name, file.path)) continue;
      const name = query ? file.name.toLocaleLowerCase() : '';
      retain(fileItems, {
        path: file.path,
        mtime: file.stat.mtime,
        name: file.name,
        starts: name.startsWith(query),
        type: 'file',
      }, 100);
    }

    // Each distinct directory contributes its newest file to all of its ancestors.
    const folderMtimes = new Map<string, number>();
    for (const [directory, mtime] of directoryMtimes) {
      let path = directory;
      while (path) {
        folderMtimes.set(path, Math.max(folderMtimes.get(path) ?? 0, mtime));
        const separator = path.lastIndexOf('/');
        if (separator < 0) break;
        path = path.slice(0, separator);
      }
    }
    const folders: Scored[] = [];
    for (const folder of matchingFolders) {
      retain(folders, { ...folder, mtime: folderMtimes.get(folder.path) ?? 0 }, 50);
    }

    const sessionItems: Scored[] = sessions.filter(item => containsQuery(query, item.label))
      .map(item => ({ path: item.id, name: item.label, mtime: item.mtime,
        starts: item.label.toLocaleLowerCase().startsWith(query), type: 'session', item }));
    return [...folders, ...fileItems, ...sessionItems]
      .sort(compare)
      .map((scored): ComposerDropdownValueItem => {
        if (scored.item) return scored.item;
        if (scored.type === 'folder') {
          return {
            className: 'is-vault-folder',
            icon: 'folder',
            id: `vault-folder:${scored.path}`,
            kind: 'value',
            label: `@${scored.path}/`,
            replacement: `@${scored.path}/ `,
          };
        }
        return {
          icon: 'file-text',
          id: `vault-file:${scored.path}`,
          kind: 'value',
          label: scored.path,
          replacement: (this.options.formatVaultFileMention ?? formatVaultFileMention)(scored.path),
        };
      });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
