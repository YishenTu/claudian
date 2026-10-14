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
  readonly getSessionItems?: () => readonly (ComposerDropdownValueItem & { readonly mtime: number })[];
  readonly formatVaultFileMention?: (path: string) => string;
}

export class MentionSource implements ComposerDropdownSource {
  readonly id = 'mentions';
  readonly inputLoadPolicy = 'debounced';

  private readonly listeners = new Set<() => void>();

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
    const before = input.slice(0, cursor);
    const index = before.lastIndexOf('@');
    if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) return null;
    const query = before.slice(index + 1);
    // A completed `@[label](target)` mention token is not an open trigger.
    if (/^\[(?:\\[\\\]]|[^\]\\\r\n])*\]\([^\s)]+\)/.test(query)) return null;
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
    this.notify();
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #vaultItems(query: string, sessions: readonly (ComposerDropdownValueItem & { readonly mtime: number })[]): readonly ComposerDropdownValueItem[] {
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
        return {
          path: folder.path,
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
        return {
          path: file.path,
          mtime: file.stat.mtime,
          name: file.name,
          starts: file.name.toLocaleLowerCase().startsWith(query),
          type: 'file' as const,
        };
      })
      .sort(compare)
      .slice(0, 100);

    const sessionItems: Scored[] = sessions.filter(item => item.label.toLocaleLowerCase().includes(query))
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
