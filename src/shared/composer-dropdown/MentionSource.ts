import type { TFile } from 'obsidian';

import type { AgentMentionProvider } from '@/core/providers/types';
import { buildExternalContextDisplayEntries } from '@/utils/externalContext';
import { externalContextScanner } from '@/utils/externalContextScanner';

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

type MentionValue =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'context-file'; readonly absolutePath: string }
  | { readonly kind: 'vault-file'; readonly path: string };

export interface MentionSourceCallbacks {
  readonly getCachedVaultFiles: () => readonly TFile[];
  readonly getCachedVaultFolders: () => readonly Pick<FolderMentionItem, 'name' | 'path'>[];
  readonly getExternalContexts: () => readonly string[];
  readonly normalizePathForVault: (path: string | undefined | null) => string | null;
  readonly onAgentMentionSelect?: (agentId: string) => void;
  readonly onAttachFile: (path: string) => void;
}

export interface MentionSourceOptions {
  readonly getExtensionFolders?: (
    signal: AbortSignal,
  ) => Promise<readonly ComposerDropdownFolderItem[]> | readonly ComposerDropdownFolderItem[];
}

export class MentionSource implements ComposerDropdownSource {
  readonly id = 'mentions';
  readonly inputLoadPolicy = 'debounced';

  private agentLoadPromise: Promise<void> | null = null;
  private agentService: AgentMentionProvider | null = null;
  private destroyed = false;
  private readonly listeners = new Set<() => void>();
  private readonly loadedAgentServices = new WeakSet<object>();

  constructor(
    private readonly callbacks: MentionSourceCallbacks,
    private readonly options: MentionSourceOptions = {},
  ) {}

  private extensionFoldersLoader = this.options.getExtensionFolders;

  destroy(): void {
    this.destroyed = true;
    this.agentService = null;
    this.agentLoadPromise = null;
    this.listeners.clear();
  }

  load(
    match: ComposerTriggerMatch,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownItem[]> | readonly ComposerDropdownItem[] {
    this.ensureAgentsLoaded();
    const query = match.query.toLocaleLowerCase();
    const items: ComposerDropdownItem[] = [];

    if (query.startsWith('agents/')) {
      return this.agentFolder().load(match.query.slice('agents/'.length), signal);
    }

    const contextEntries = buildExternalContextDisplayEntries([
      ...this.callbacks.getExternalContexts(),
    ]);
    const matchingContext = contextEntries
      .filter(entry => query.startsWith(`${entry.displayNameLower}/`))
      .sort((left, right) => right.displayNameLower.length - left.displayNameLower.length)[0];
    if (matchingContext) {
      return this.externalContextFolder(
        matchingContext.displayName,
        matchingContext.contextRoot,
      ).load(match.query.slice(matchingContext.displayName.length + 1), signal);
    }

    if (this.agentService?.searchAgents('').length && 'agents'.includes(query)) {
      items.push(this.agentFolder());
    }

    const seenContextNames = new Set<string>();
    for (const entry of contextEntries) {
      if (seenContextNames.has(entry.displayName)) continue;
      if (!entry.displayNameLower.includes(query)) continue;
      seenContextNames.add(entry.displayName);
      items.push(this.externalContextFolder(entry.displayName, entry.contextRoot));
    }

    const extensionFolders = this.extensionFoldersLoader?.(signal);
    if (extensionFolders instanceof Promise) {
      return extensionFolders
        .then(folders => this.finishRootItems(items, folders, query, signal))
        .catch(error => {
          if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw error;
          }
          return this.finishRootItems(items, [], query, signal);
        });
    }
    return this.finishRootItems(items, extensionFolders ?? [], query, signal);
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

  preScanExternalContexts(): void {
    const paths = this.callbacks.getExternalContexts();
    if (paths.length === 0) return;
    window.setTimeout(() => {
      try {
        externalContextScanner.scanPaths([...paths]);
      } catch {
        // Best-effort warmup only.
      }
    }, 0);
  }

  select(
    item: ComposerDropdownValueItem,
    _match: ComposerTriggerMatch,
  ): ComposerSelectionAction {
    const value = item.value as MentionValue | undefined;
    return {
      kind: 'replace',
      text: item.replacement,
      onApplied: () => {
        if (!value) return;
        if (value.kind === 'agent') this.callbacks.onAgentMentionSelect?.(value.agentId);
        if (value.kind === 'context-file') this.callbacks.onAttachFile(value.absolutePath);
        if (value.kind === 'vault-file') this.callbacks.onAttachFile(value.path);
      },
    };
  }

  setAgentService(service: AgentMentionProvider | null): void {
    if (this.agentService === service) return;
    this.agentService = service;
    this.agentLoadPromise = null;
    this.notify();
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

  private agentFolder(): ComposerDropdownFolderItem {
    return {
      className: 'is-agent-folder',
      icon: 'bot',
      id: 'agents',
      inputPrefix: 'Agents/',
      kind: 'folder',
      label: 'Agents',
      load: query => (this.agentService?.searchAgents(query) ?? []).map(agent => ({
        className: 'is-agent',
        detail: agent.description,
        icon: 'bot',
        id: `agent:${agent.id}`,
        kind: 'value',
        label: `@${agent.id}`,
        replacement: `@${agent.id} (agent) `,
        value: { agentId: agent.id, kind: 'agent' } satisfies MentionValue,
      })),
    };
  }

  private finishRootItems(
    items: ComposerDropdownItem[],
    extensionFolders: readonly ComposerDropdownFolderItem[],
    query: string,
    signal: AbortSignal,
  ): readonly ComposerDropdownItem[] {
    if (signal.aborted) throw new DOMException('Mention lookup was cancelled.', 'AbortError');
    for (const folder of extensionFolders) {
      if (folder.label.toLocaleLowerCase().includes(query)) items.push(folder);
    }
    items.push(...this.vaultItems(query));
    return items;
  }

  private ensureAgentsLoaded(): void {
    const service = this.agentService;
    if (
      !service?.ensureLoaded
      || service.isLoaded?.()
      || this.loadedAgentServices.has(service)
      || this.agentLoadPromise
    ) return;

    const pending = service.ensureLoaded();
    this.agentLoadPromise = pending;
    void pending.then(() => {
      this.loadedAgentServices.add(service);
      if (!this.destroyed && this.agentService === service) this.notify();
    }).catch(() => {
      // Cached Agent entries remain usable after a failed refresh.
    }).finally(() => {
      if (this.agentLoadPromise === pending) this.agentLoadPromise = null;
    });
  }

  private externalContextFolder(
    displayName: string,
    contextRoot: string,
  ): ComposerDropdownFolderItem {
    return {
      className: 'is-context-folder',
      icon: 'folder',
      id: `context:${contextRoot}`,
      inputPrefix: `${displayName}/`,
      kind: 'folder',
      label: displayName,
      load: query => externalContextScanner.scanPaths([contextRoot])
        .filter(file => {
          const normalized = file.relativePath.replace(/\\/g, '/');
          return normalized.toLocaleLowerCase().includes(query.toLocaleLowerCase())
            || file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
        })
        .sort((left, right) => {
          const normalizedQuery = query.toLocaleLowerCase();
          const leftStarts = left.name.toLocaleLowerCase().startsWith(normalizedQuery);
          const rightStarts = right.name.toLocaleLowerCase().startsWith(normalizedQuery);
          if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
          return right.mtime - left.mtime;
        })
        .map(file => ({
          className: 'is-context-file',
          icon: 'folder-open',
          id: `context-file:${file.path}`,
          kind: 'value',
          label: file.relativePath.replace(/\\/g, '/'),
          replacement: `@${displayName}/${file.relativePath.replace(/\\/g, '/')} `,
          value: { absolutePath: file.path, kind: 'context-file' } satisfies MentionValue,
        })),
    };
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
            replacement: formatVaultFileMention(normalized),
            value: { kind: 'vault-file', path: normalized } satisfies MentionValue,
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
