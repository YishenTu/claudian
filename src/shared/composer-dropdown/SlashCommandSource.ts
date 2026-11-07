import { getBuiltInCommandsForDropdown } from '@/core/commands/builtInCommands';
import { normalizeArgumentHint } from '@/core/commands/slashCommand';
import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoverySource } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry, ProviderCommandKind } from '@/core/providers/commands/ProviderCommandEntry';
import type { ProviderId } from '@/core/providers/types';
import { t } from '@/i18n/i18n';
import type { TranslationKey } from '@/i18n/types';

import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerDropdownValueItem,
  ComposerSelectionAction,
  ComposerTriggerMatch,
} from './types';

const BUILT_IN_DESCRIPTION_KEYS: Readonly<Partial<Record<string, TranslationKey>>> = {
  'builtin:new': 'chat.suggestions.builtInDescriptions.new',
  'builtin:compact': 'chat.suggestions.builtInDescriptions.compact',
  'builtin:sessions': 'chat.suggestions.builtInDescriptions.sessions',
  'builtin:fast': 'chat.suggestions.builtInDescriptions.fast',
  'builtin:side': 'chat.suggestions.builtInDescriptions.side',
};

type SlashValue = { readonly kind: 'command' | 'retry' };

type SlashCommandDropdownItem = ComposerDropdownValueItem & {
  readonly aliases?: readonly string[];
  readonly name: string;
};

interface RankedCommand {
  readonly item: SlashCommandDropdownItem;
  /** Lower ranks list first: exact name, name prefix, name substring, then description-only. */
  readonly rank: number;
}

function nameRank(name: string, query: string): number {
  const key = name.toLocaleLowerCase();
  if (key === query) return 0;
  if (key.startsWith(query)) return 1;
  return key.includes(query) ? 2 : Number.POSITIVE_INFINITY;
}

/** Maps search-key offsets to enclosing boundaries in the unchanged command name. */
function originalMatchRange(name: string, key: string, start: number, end: number) {
  if (key.length === name.length) return { start, end };
  let originalStart = 0;
  let originalEnd = name.length;
  let boundary = 0;
  for (const character of name) {
    boundary += character.length;
    const foldedBoundary = name.slice(0, boundary).toLocaleLowerCase().length;
    if (foldedBoundary <= start) originalStart = boundary;
    if (foldedBoundary >= end) {
      originalEnd = boundary;
      break;
    }
  }
  return { start: originalStart, end: originalEnd };
}

/** Ranks by the best-matching name and marks it; an alias is shown only when it beats the primary name. */
function rankCommand(item: SlashCommandDropdownItem, query: string): RankedCommand | null {
  const prefix = item.label.slice(0, item.label.length - item.name.length);
  const primary = nameRank(item.name, query);
  const alias = (item.aliases ?? [])
    .map(name => ({ name, rank: nameRank(name, query) }))
    .reduce<{ name: string; rank: number } | null>((best, next) => (!best || next.rank < best.rank ? next : best), null);
  const matchIn = (name: string, offset: number) => {
    if (!query) return undefined;
    const key = name.toLocaleLowerCase();
    const start = key.indexOf(query);
    const range = originalMatchRange(name, key, start, start + query.length);
    return { start: offset + range.start, end: offset + range.end };
  };
  if (alias && alias.rank < primary) {
    return {
      item: { ...item, labelNote: { text: alias.name, match: matchIn(alias.name, 0) } },
      rank: alias.rank,
    };
  }
  if (Number.isFinite(primary)) {
    return { item: { ...item, labelMatch: matchIn(item.name, prefix.length) }, rank: primary };
  }
  return item.detail?.toLocaleLowerCase().includes(query) ? { item, rank: 3 } : null;
}

export interface SlashCommandSourceOptions {
  readonly hiddenCommands?: ReadonlySet<string>;
  readonly includeBuiltIns?: boolean;
  readonly providerConfig?: ProviderCommandDropdownConfig;
  readonly providerDiscovery?: ProviderCommandDiscoverySource<ProviderCommandEntry>;
  readonly providerId?: ProviderId | null;
}

export class SlashCommandSource implements ComposerDropdownSource {
  readonly id = 'slash-commands';

  private discovery: ProviderCommandDiscoverySource<ProviderCommandEntry> | null;
  private watchController: AbortController | null = null;
  private discoveryUnsubscribe: (() => void) | null = null;
  private hiddenCommands: ReadonlySet<string>;
  private includeBuiltIns: boolean;
  private readonly listeners = new Set<() => void>();
  private providerConfig: ProviderCommandDropdownConfig | null;
  private providerId: ProviderId | null;

  constructor(options: SlashCommandSourceOptions = {}) {
    this.discovery = options.providerDiscovery ?? null;
    this.hiddenCommands = options.hiddenCommands ?? new Set();
    this.includeBuiltIns = options.includeBuiltIns ?? true;
    this.providerConfig = options.providerConfig ?? null;
    this.providerId = options.providerId ?? options.providerConfig?.providerId ?? null;
    this.#bindDiscovery();
  }

  onOpen(): void {
    this.#watchDiscovery();
    if (this.providerConfig?.refreshOnOpen && this.discovery?.getSnapshot().status !== 'idle') {
      this.#startDiscovery('retry');
    }
  }

  onClose(): void {
    this.watchController?.abort();
    this.watchController = null;
  }

  #watchDiscovery(): void {
    this.watchController?.abort();
    this.watchController = new AbortController();
    this.discovery?.watch?.(this.watchController.signal);
  }

  clearProviderCatalog(): void {
    this.watchController?.abort();
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = null;
    this.discovery = null;
    this.providerConfig = null;
    this.notify();
  }

  destroy(): void {
    this.onClose();
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = null;
    this.discovery = null;
    this.listeners.clear();
  }

  load(
    match: ComposerTriggerMatch,
    _signal: AbortSignal,
  ): readonly ComposerDropdownItem[] {
    const snapshot = this.discovery?.getSnapshot();
    let result = snapshot;
    if (snapshot?.status === 'idle') {
      this.#startDiscovery('load');
      result = { status: 'loading' };
    }
    const providerEntries = result?.status === 'ready' ? result.items : [];
    const includeBuiltIns = this.includeBuiltIns
      && match.atInputStart
      && match.trigger === '/';
    const query = match.query.toLocaleLowerCase();
    const items = this.#buildItems(providerEntries, includeBuiltIns)
      .map(item => rankCommand(item, query))
      .filter((ranked): ranked is RankedCommand => ranked !== null)
      .sort((left, right) => left.rank - right.rank || left.item.label.localeCompare(right.item.label))
      .map(ranked => ranked.item);

    if (result && result.status !== 'ready' && result.status !== 'empty') {
      const label = result.status === 'requires-session' || result.status === 'error'
        ? result.message
        : t('chat.suggestions.providerLoading');
      const statusItems: ComposerDropdownItem[] = [
        ...items,
        {
          id: `provider-${result.status}`,
          kind: 'status',
          label,
          state: result.status === 'error' ? 'error' : 'loading',
        },
      ];
      if (result.status === 'error' && result.retryable) {
        statusItems.push({
          detail: t('chat.suggestions.providerRetry'),
          icon: 'refresh-cw',
          id: 'provider-retry',
          kind: 'value',
          label: t('common.retry'),
          replacement: '',
          value: { kind: 'retry' } satisfies SlashValue,
        });
      }
      return statusItems;
    }
    return items;
  }

  match(input: string, cursor: number): ComposerTriggerMatch | null {
    const before = input.slice(0, cursor);
    const triggers = this.providerConfig?.triggerChars ?? ['/'];
    for (let index = cursor - 1; index >= 0; index--) {
      const char = before[index];
      if (/\s/.test(char)) break;
      if (!triggers.includes(char)) continue;
      if (index > 0 && !/\s/.test(before[index - 1])) return null;
      const query = before.slice(index + 1);
      if (/\s/.test(query)) return null;
      return {
        atInputStart: index === 0,
        end: cursor,
        query,
        start: index,
        trigger: char,
      };
    }
    return null;
  }

  select(
    item: ComposerDropdownValueItem,
    _match: ComposerTriggerMatch,
  ): ComposerSelectionAction {
    const value = item.value as SlashValue | undefined;
    if (!value) return { kind: 'none' };
    if (value.kind === 'retry') {
      return {
        kind: 'invoke',
        onApplied: () => this.#startDiscovery('retry'),
      };
    }
    return {
      kind: 'replace',
      text: item.replacement,
    };
  }

  /** Resolves an inserted token such as `/review` with the same precedence the dropdown offers it. */
  resolveCommandKind(token: string, atInputStart: boolean): ProviderCommandKind | null {
    const key = token.toLocaleLowerCase();
    if (this.includeBuiltIns && atInputStart && key.startsWith('/')) {
      const name = key.slice(1);
      if (getBuiltInCommandsForDropdown(this.providerId ?? undefined).some(command =>
        [command.name, ...(command.aliases ?? [])].some(alias => alias.toLocaleLowerCase() === name))) {
        return 'command';
      }
    }
    const snapshot = this.discovery?.getSnapshot();
    if (snapshot?.status !== 'ready') return null;
    const entry = snapshot.items.find(item => !this.hiddenCommands.has(item.name.toLocaleLowerCase())
      && `${item.insertPrefix}${item.name}`.toLocaleLowerCase() === key);
    return entry?.kind ?? null;
  }

  /** Destinations without Claudian built-in commands hide them entirely. */
  setBuiltInsEnabled(enabled: boolean): void {
    if (this.includeBuiltIns === enabled) return;
    this.includeBuiltIns = enabled;
    this.notify();
  }

  setHiddenCommands(commands: ReadonlySet<string>): void {
    this.hiddenCommands = commands;
    this.notify();
  }

  setProviderCatalog(
    config: ProviderCommandDropdownConfig,
    discovery: ProviderCommandDiscoverySource<ProviderCommandEntry>,
  ): void {
    this.discoveryUnsubscribe?.();
    this.providerConfig = config;
    this.providerId = config.providerId;
    this.discovery = discovery;
    this.#bindDiscovery();
    this.notify();
  }

  setProviderId(providerId: ProviderId | null): void {
    this.providerId = providerId;
    this.notify();
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #bindDiscovery(): void {
    if (this.watchController) this.#watchDiscovery();
    this.discoveryUnsubscribe = this.discovery?.subscribe(() => this.notify()) ?? null;
  }

  #startDiscovery(action: 'load' | 'retry'): void {
    const discovery = this.discovery;
    if (!discovery) return;
    void Promise.resolve().then(() => discovery[action]()).catch(() => undefined);
  }

  #buildItems(
    providerEntries: readonly ProviderCommandEntry[],
    includeBuiltIns: boolean,
  ): SlashCommandDropdownItem[] {
    const items: SlashCommandDropdownItem[] = [];
    const seen = new Set<string>();

    if (includeBuiltIns) {
      for (const command of getBuiltInCommandsForDropdown(this.providerId ?? undefined)) {
        const key = command.name.toLocaleLowerCase();
        if (seen.has(key)) continue;
        for (const name of [command.name, ...(command.aliases ?? [])]) seen.add(name.toLocaleLowerCase());
        const descriptionKey = BUILT_IN_DESCRIPTION_KEYS[command.id];
        const description = descriptionKey ? t(descriptionKey) : command.description;
        items.push({
          aliases: command.aliases,
          detail: command.argumentHint
            ? `${description} · ${normalizeArgumentHint(command.argumentHint)}`
            : description,
          id: command.id,
          kind: 'value',
          label: `/${command.name}`,
          name: command.name,
          replacement: `/${command.name} `,
          value: { kind: 'command' } satisfies SlashValue,
        });
      }
    }

    for (const entry of providerEntries) {
      const key = entry.name.toLocaleLowerCase();
      if (seen.has(key) || this.hiddenCommands.has(key)) continue;
      seen.add(key);
      items.push({
        detail: entry.argumentHint
          ? `${entry.description ?? ''} · ${normalizeArgumentHint(entry.argumentHint)}`.trim()
          : entry.description,
        id: entry.id,
        kind: 'value',
        label: `${entry.displayPrefix}${entry.name}`,
        name: entry.name,
        replacement: `${entry.insertPrefix}${entry.name} `,
        value: { kind: 'command' } satisfies SlashValue,
      });
    }
    return items;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
