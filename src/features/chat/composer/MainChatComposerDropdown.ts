import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoverySource } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { ProviderId } from '@/core/providers/types';
import {
  ComposerDropdownController,
  SlashCommandSource,
} from '@/shared/composer-dropdown';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

import type { FileContextManager } from '../ui/FileContext';

export interface MainChatComposerDropdownOptions {
  readonly hiddenCommands?: ReadonlySet<string>;
  readonly providerConfig?: ProviderCommandDropdownConfig;
  readonly providerDiscovery?: ProviderCommandDiscoverySource<ProviderCommandEntry>;
  readonly providerId: ProviderId | null;
}

export class MainChatComposerDropdown {
  private readonly controller: ComposerDropdownController;
  private readonly slashSource: SlashCommandSource;
  private readonly mentionSource: ReturnType<FileContextManager['getMentionSource']>;

  constructor(
    containerEl: HTMLElement,
    inputEl: ComposerInputElement,
    fileContextManager: FileContextManager,
    options: MainChatComposerDropdownOptions,
  ) {
    this.slashSource = new SlashCommandSource({
      hiddenCommands: options.hiddenCommands,
      providerConfig: options.providerConfig,
      providerDiscovery: options.providerDiscovery,
      providerId: options.providerId,
    });
    this.mentionSource = fileContextManager.getMentionSource();
    this.controller = new ComposerDropdownController(
      containerEl,
      inputEl,
      [this.slashSource, this.mentionSource],
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

  setBuiltInsEnabled(enabled: boolean): void {
    this.slashSource.setBuiltInsEnabled(enabled);
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

  setProviderId(providerId: ProviderId | null): void {
    this.slashSource.setProviderId(providerId);
  }
}
