import type {
  CollabComposerReferencePort,
  CollabComposerReferenceSubscription,
} from '@/core/collab';
import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoverySource } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { ProviderId } from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import {
  ComposerDropdownController,
  SlashCommandSource,
} from '@/shared/composer-dropdown';

import type { FileContextManager } from '../ui/FileContext';
import { CollabMemberChangesFolder } from './CollabMemberChangesFolder';
import { CollabTicketReferenceSource } from './CollabTicketReferenceSource';

export interface MainChatComposerDropdownOptions {
  readonly hiddenCommands?: ReadonlySet<string>;
  readonly collabReferences?: CollabComposerReferencePort;
  readonly onSlashCommandSelected?: (command: SlashCommand) => void;
  readonly providerConfig?: ProviderCommandDropdownConfig;
  readonly providerDiscovery?: ProviderCommandDiscoverySource<ProviderCommandEntry>;
  readonly providerId: ProviderId;
}

export class MainChatComposerDropdown {
  private readonly controller: ComposerDropdownController;
  private readonly slashSource: SlashCommandSource;
  private readonly mentionSource: ReturnType<FileContextManager['getMentionSource']>;
  private readonly selectionSubscription: CollabComposerReferenceSubscription | null;
  private readonly ticketSource: CollabTicketReferenceSource | null;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    fileContextManager: FileContextManager,
    options: MainChatComposerDropdownOptions,
  ) {
    this.slashSource = new SlashCommandSource({
      hiddenCommands: options.hiddenCommands,
      onSelect: options.onSlashCommandSelected,
      providerConfig: options.providerConfig,
      providerDiscovery: options.providerDiscovery,
      providerId: options.providerId,
    });
    this.mentionSource = fileContextManager.getMentionSource();
    const memberChanges = options.collabReferences
      ? new CollabMemberChangesFolder(options.collabReferences)
      : null;
    if (memberChanges) {
      this.mentionSource.setExtensionFoldersLoader(signal => memberChanges.getRootItems(signal));
    }
    this.selectionSubscription = options.collabReferences?.subscribeSelection(
      () => this.mentionSource.invalidate(),
    ) ?? null;
    this.ticketSource = options.collabReferences
      ? new CollabTicketReferenceSource(options.collabReferences)
      : null;
    this.controller = new ComposerDropdownController(
      containerEl,
      inputEl,
      [this.slashSource, this.mentionSource, ...(this.ticketSource ? [this.ticketSource] : [])],
    );
  }

  clearProviderCatalog(): void {
    this.slashSource.clearProviderCatalog();
  }

  containsElement(element: Node): boolean {
    return this.controller.containsElement(element);
  }

  destroy(): void {
    this.controller.destroy();
    this.selectionSubscription?.dispose();
    this.mentionSource.setExtensionFoldersLoader(undefined);
    this.ticketSource?.destroy();
    this.slashSource.destroy();
  }

  handleInputChange(): void {
    this.controller.handleInputChange();
  }

  handleKeydown(event: KeyboardEvent): boolean {
    return this.controller.handleKeydown(event);
  }

  hide(): void {
    this.controller.hide();
  }

  isVisible(): boolean {
    return this.controller.isVisible();
  }

  setEnabled(enabled: boolean): void {
    this.controller.setEnabled(enabled);
  }

  setHiddenCommands(commands: ReadonlySet<string>): void {
    this.slashSource.setHiddenCommands(commands);
  }

  setProviderCatalog(
    config: ProviderCommandDropdownConfig,
    discovery: ProviderCommandDiscoverySource<ProviderCommandEntry>,
  ): void {
    this.slashSource.setProviderCatalog(config, discovery);
  }

  setProviderId(providerId: ProviderId): void {
    this.slashSource.setProviderId(providerId);
  }
}
