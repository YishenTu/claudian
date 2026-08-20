import { getBuiltInCommandsForDropdown } from '@/core/commands/builtInCommands';
import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoverySource } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { ProviderId } from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import { normalizeArgumentHint } from '@/utils/slashCommand';

import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerDropdownValueItem,
  ComposerSelectionAction,
  ComposerTriggerMatch,
} from './types';

type SlashValue =
  | {
    readonly command: SlashCommand;
    readonly kind: 'command';
  }
  | { readonly kind: 'retry' };

export interface SlashCommandSourceOptions {
  readonly hiddenCommands?: ReadonlySet<string>;
  readonly includeBuiltIns?: boolean;
  readonly onSelect?: (command: SlashCommand) => void;
  readonly providerConfig?: ProviderCommandDropdownConfig;
  readonly providerDiscovery?: ProviderCommandDiscoverySource<ProviderCommandEntry>;
  readonly providerId?: ProviderId;
}

export class SlashCommandSource implements ComposerDropdownSource {
  readonly id = 'slash-commands';

  private discovery: ProviderCommandDiscoverySource<ProviderCommandEntry> | null;
  private discoveryUnsubscribe: (() => void) | null = null;
  private hiddenCommands: ReadonlySet<string>;
  private readonly includeBuiltIns: boolean;
  private readonly listeners = new Set<() => void>();
  private readonly onSelect: ((command: SlashCommand) => void) | undefined;
  private providerConfig: ProviderCommandDropdownConfig | null;
  private providerId: ProviderId | null;

  constructor(options: SlashCommandSourceOptions = {}) {
    this.discovery = options.providerDiscovery ?? null;
    this.hiddenCommands = options.hiddenCommands ?? new Set();
    this.includeBuiltIns = options.includeBuiltIns ?? true;
    this.onSelect = options.onSelect;
    this.providerConfig = options.providerConfig ?? null;
    this.providerId = options.providerId ?? options.providerConfig?.providerId ?? null;
    this.bindDiscovery();
  }

  clearProviderCatalog(): void {
    this.discoveryUnsubscribe?.();
    this.discoveryUnsubscribe = null;
    this.discovery = null;
    this.providerConfig = null;
    this.notify();
  }

  destroy(): void {
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
      this.startDiscovery('load');
      result = { status: 'loading' };
    }
    const providerEntries = result?.status === 'ready' ? result.items : [];
    const includeBuiltIns = this.includeBuiltIns
      && match.atInputStart
      && match.trigger === '/';
    const items = this.buildItems(providerEntries, includeBuiltIns)
      .filter(item => {
        const query = match.query.toLocaleLowerCase();
        return item.label.toLocaleLowerCase().includes(query)
          || item.detail?.toLocaleLowerCase().includes(query);
      })
      .sort((left, right) => left.label.localeCompare(right.label));

    if (result && result.status !== 'ready' && result.status !== 'empty') {
      const label = result.status === 'requires-session' || result.status === 'error'
        ? result.message
        : 'Loading provider commands…';
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
          detail: 'Try provider command discovery again',
          icon: 'refresh-cw',
          id: 'provider-retry',
          kind: 'value',
          label: 'Retry',
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
        onApplied: () => this.startDiscovery('retry'),
      };
    }
    return {
      kind: 'replace',
      text: item.replacement,
      onApplied: () => this.onSelect?.(value.command),
    };
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
    this.bindDiscovery();
    this.notify();
  }

  setProviderId(providerId: ProviderId): void {
    this.providerId = providerId;
    this.notify();
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bindDiscovery(): void {
    this.discoveryUnsubscribe = this.discovery?.subscribe(() => this.notify()) ?? null;
  }

  private startDiscovery(action: 'load' | 'retry'): void {
    const discovery = this.discovery;
    if (!discovery) return;
    void Promise.resolve().then(() => discovery[action]()).catch(() => undefined);
  }

  private buildItems(
    providerEntries: readonly ProviderCommandEntry[],
    includeBuiltIns: boolean,
  ): ComposerDropdownValueItem[] {
    const items: ComposerDropdownValueItem[] = [];
    const seen = new Set<string>();

    if (includeBuiltIns) {
      for (const command of getBuiltInCommandsForDropdown(this.providerId ?? undefined)) {
        const key = command.name.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const slashCommand: SlashCommand = command;
        items.push({
          detail: command.argumentHint
            ? `${command.description} · ${normalizeArgumentHint(command.argumentHint)}`
            : command.description,
          id: command.id,
          kind: 'value',
          label: `/${command.name}`,
          replacement: `/${command.name} `,
          value: { command: slashCommand, kind: 'command' } satisfies SlashValue,
        });
      }
    }

    for (const entry of providerEntries) {
      const key = entry.name.toLocaleLowerCase();
      if (seen.has(key) || this.hiddenCommands.has(key)) continue;
      seen.add(key);
      const command: SlashCommand = {
        agent: entry.agent,
        allowedTools: entry.allowedTools,
        argumentHint: entry.argumentHint,
        content: entry.content,
        context: entry.context,
        description: entry.description,
        disableModelInvocation: entry.disableModelInvocation,
        hooks: entry.hooks,
        id: entry.id,
        kind: entry.kind,
        model: entry.model,
        name: entry.name,
        source: entry.source,
        userInvocable: entry.userInvocable,
      };
      items.push({
        detail: entry.argumentHint
          ? `${entry.description ?? ''} · ${normalizeArgumentHint(entry.argumentHint)}`.trim()
          : entry.description,
        id: entry.id,
        kind: 'value',
        label: `${entry.displayPrefix}${entry.name}`,
        replacement: `${entry.insertPrefix}${entry.name} `,
        value: { command, kind: 'command' } satisfies SlashValue,
      });
    }
    return items;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
