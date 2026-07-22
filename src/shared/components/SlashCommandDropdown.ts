import { getBuiltInCommandsForDropdown } from '../../core/commands/builtInCommands';
import type { ProviderCommandDropdownConfig } from '../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoveryResult } from '../../core/providers/commands/ProviderCommandDiscoveryResult';
import type { ProviderCommandEntry } from '../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../core/types';
import { normalizeArgumentHint } from '../../utils/slashCommand';

interface DropdownItem {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
  displayPrefix: string;
  insertPrefix: string;
  isBuiltIn: boolean;
  slashCommand?: SlashCommand;
  providerEntry?: ProviderCommandEntry;
}

export interface SlashCommandDropdownCallbacks {
  onSelect: (command: SlashCommand) => void;
  onHide: () => void;
}

export interface SlashCommandDropdownOptions {
  fixed?: boolean;
  hiddenCommands?: Set<string>;
  providerConfig?: ProviderCommandDropdownConfig;
  /** Catalog-only compatibility path used by auxiliary consumers such as inline edit. */
  getProviderEntries?: () => Promise<ProviderCommandEntry[]>;
  /** Typed provider-protocol discovery used by the active chat composer. */
  discoverProviderEntries?: () => Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>>;
}

type ProviderDiscoveryViewState =
  | { status: 'loading' }
  | ProviderCommandDiscoveryResult<ProviderCommandEntry>;

const PROVIDER_DISCOVERY_TIMEOUT_MS = 8_000;

export class SlashCommandDropdown {
  private containerEl: HTMLElement;
  private dropdownEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | HTMLInputElement;
  private callbacks: SlashCommandDropdownCallbacks;
  private enabled = true;
  private onInput: () => void;
  private triggerStartIndex = -1;
  private activeTriggerChar = '/';
  private selectedIndex = 0;
  private filteredItems: DropdownItem[] = [];
  private isFixed: boolean;
  private hiddenCommands: Set<string>;

  private providerConfig: ProviderCommandDropdownConfig | null;
  private getProviderEntries: (() => Promise<ProviderCommandEntry[]>) | null;
  private discoverProviderEntries: (
    () => Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>>
  ) | null;
  private cachedProviderEntries: ProviderCommandEntry[] = [];
  private providerEntriesFetched = false;
  private providerDiscoveryState: ProviderDiscoveryViewState | null = null;

  private requestId = 0;
  private catalogGeneration = 0;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement | HTMLInputElement,
    callbacks: SlashCommandDropdownCallbacks,
    options: SlashCommandDropdownOptions = {}
  ) {
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;
    this.isFixed = options.fixed ?? false;
    this.hiddenCommands = options.hiddenCommands ?? new Set();
    this.providerConfig = options.providerConfig ?? null;
    this.getProviderEntries = options.getProviderEntries ?? null;
    this.discoverProviderEntries = options.getProviderEntries
      ? null
      : options.discoverProviderEntries ?? null;

    this.onInput = () => this.handleInputChange();
    this.inputEl.addEventListener('input', this.onInput);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.hide();
    }
  }

  setHiddenCommands(commands: Set<string>): void {
    this.hiddenCommands = commands;
  }

  setProviderCatalog(
    config: ProviderCommandDropdownConfig,
    discoverEntries: () => Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>>,
  ): void {
    this.clearProviderView();
    this.catalogGeneration++;
    this.requestId++;
    this.providerConfig = config;
    this.discoverProviderEntries = discoverEntries;
    this.getProviderEntries = null;
    this.cachedProviderEntries = [];
    this.providerEntriesFetched = false;
    this.providerDiscoveryState = null;
  }

  clearProviderCatalog(): void {
    this.clearProviderView();
    this.catalogGeneration++;
    this.requestId++;
    this.providerConfig = null;
    this.discoverProviderEntries = null;
    this.getProviderEntries = null;
    this.cachedProviderEntries = [];
    this.providerEntriesFetched = false;
    this.providerDiscoveryState = null;
  }

  handleInputChange(): void {
    if (!this.enabled) return;

    const text = this.getInputValue();
    const cursorPos = this.getCursorPosition();
    const textBeforeCursor = text.substring(0, cursorPos);
    const triggerChars = this.providerConfig?.triggerChars ?? ['/'];

    // Scan backward from cursor for the nearest valid trigger char.
    // Valid trigger: at position 0, or preceded by whitespace.
    let triggerIndex = -1;
    let triggerChar = '';

    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = textBeforeCursor.charAt(i);
      if (/\s/.test(ch)) break;
      if (triggerChars.includes(ch)) {
        if (i === 0 || /\s/.test(textBeforeCursor.charAt(i - 1))) {
          triggerIndex = i;
          triggerChar = ch;
        }
        break;
      }
    }

    if (triggerIndex === -1) {
      this.hide();
      return;
    }

    const searchText = textBeforeCursor.substring(triggerIndex + 1);

    if (/\s/.test(searchText)) {
      this.hide();
      return;
    }

    this.triggerStartIndex = triggerIndex;
    this.activeTriggerChar = triggerChar;
    const isAtPosition0 = triggerIndex === 0;
    void this.showDropdown(searchText, isAtPosition0);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.enabled || !this.isVisible()) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.navigate(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this.navigate(-1);
        return true;
      case 'Enter':
      case 'Tab':
        if (this.filteredItems.length > 0) {
          e.preventDefault();
          this.selectItem();
          return true;
        }
        return false;
      case 'Escape':
        e.preventDefault();
        this.hide();
        return true;
    }
    return false;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  hide(): void {
    this.requestId++;
    if (this.dropdownEl) {
      this.dropdownEl.removeClass('visible');
    }
    this.triggerStartIndex = -1;
    this.callbacks.onHide();
  }

  destroy(): void {
    this.catalogGeneration++;
    this.requestId++;
    this.inputEl.removeEventListener('input', this.onInput);
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  resetSdkSkillsCache(): void {
    this.requestId++;
    this.cachedProviderEntries = [];
    this.providerEntriesFetched = false;
    this.providerDiscoveryState = null;
  }

  private clearProviderView(): void {
    this.filteredItems = [];
    this.hide();
    this.dropdownEl?.empty();
  }

  private getInputValue(): string {
    return this.inputEl.value;
  }

  private getCursorPosition(): number {
    return this.inputEl.selectionStart || 0;
  }

  private setInputValue(value: string): void {
    this.inputEl.value = value;
  }

  private setCursorPosition(pos: number): void {
    this.inputEl.selectionStart = pos;
    this.inputEl.selectionEnd = pos;
  }

  private async showDropdown(searchText: string, isAtPosition0 = true): Promise<void> {
    const currentRequest = ++this.requestId;
    const currentGeneration = this.catalogGeneration;
    const searchLower = searchText.toLowerCase();
    const includeBuiltIns = isAtPosition0 && this.activeTriggerChar === '/';

    if (this.discoverProviderEntries) {
      this.providerDiscoveryState = { status: 'loading' };
      this.cachedProviderEntries = [];
      this.updateFilteredItems(searchLower, includeBuiltIns);
      this.render();

      let result: ProviderCommandDiscoveryResult<ProviderCommandEntry>;
      try {
        result = await this.discoverProviderEntriesWithTimeout();
      } catch {
        result = {
          status: 'error',
          message: 'Could not load provider commands',
          retryable: true,
        };
      }

      if (
        currentRequest !== this.requestId
        || currentGeneration !== this.catalogGeneration
      ) {
        return;
      }

      this.providerDiscoveryState = result;
      this.cachedProviderEntries = result.status === 'ready' ? [...result.items] : [];
      this.updateFilteredItems(searchLower, includeBuiltIns);
      this.finishRender(searchText);
      return;
    }

    await this.fetchProviderEntries(currentRequest);

    if (currentRequest !== this.requestId) return;

    this.updateFilteredItems(searchLower, includeBuiltIns);
    this.finishRender(searchText);
  }

  private async discoverProviderEntriesWithTimeout(): Promise<
    ProviderCommandDiscoveryResult<ProviderCommandEntry>
  > {
    if (!this.discoverProviderEntries) {
      return { status: 'empty' };
    }

    let timeoutId: number | null = null;
    const timeout = new Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>>(
      resolve => {
        timeoutId = window.setTimeout(() => resolve({
          status: 'error',
          message: 'Provider command discovery timed out',
          retryable: true,
        }), PROVIDER_DISCOVERY_TIMEOUT_MS);
      },
    );

    try {
      return await Promise.race([this.discoverProviderEntries(), timeout]);
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  private updateFilteredItems(searchLower: string, includeBuiltIns: boolean): void {
    this.filteredItems = this.buildItemList(includeBuiltIns)
      .filter(item =>
        item.name.toLowerCase().includes(searchLower)
        || item.description?.toLowerCase().includes(searchLower)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private finishRender(searchText: string): void {
    const hasProviderState = this.providerDiscoveryState?.status !== 'ready'
      && this.providerDiscoveryState !== null;
    if (searchText.length > 0 && this.filteredItems.length === 0 && !hasProviderState) {
      this.hide();
      return;
    }

    this.selectedIndex = 0;
    this.render();
  }

  private async fetchProviderEntries(currentRequest: number): Promise<void> {
    if (this.providerEntriesFetched || !this.getProviderEntries) return;

    try {
      const entries = await this.getProviderEntries();
      if (currentRequest !== this.requestId) return;
      if (entries.length > 0) {
        this.cachedProviderEntries = entries;
        this.providerEntriesFetched = true;
      }
    } catch {
      if (currentRequest !== this.requestId) return;
    }
  }

  private buildItemList(includeBuiltIns: boolean): DropdownItem[] {
    const seenNames = new Set<string>();
    const items: DropdownItem[] = [];

    if (includeBuiltIns) {
      const builtIns = getBuiltInCommandsForDropdown(this.providerConfig?.providerId);
      for (const cmd of builtIns) {
        const nameLower = cmd.name.toLowerCase();
        if (!seenNames.has(nameLower)) {
          seenNames.add(nameLower);
          items.push({
            name: cmd.name,
            description: cmd.description,
            argumentHint: cmd.argumentHint,
            content: cmd.content,
            displayPrefix: '/',
            insertPrefix: '/',
            isBuiltIn: true,
            slashCommand: cmd,
          });
        }
      }
    }

    for (const entry of this.cachedProviderEntries) {
      const nameLower = entry.name.toLowerCase();
      if (seenNames.has(nameLower) || this.hiddenCommands.has(nameLower)) {
        continue;
      }
      seenNames.add(nameLower);
      items.push({
        name: entry.name,
        description: entry.description,
        argumentHint: entry.argumentHint,
        content: entry.content,
        displayPrefix: entry.displayPrefix,
        insertPrefix: entry.insertPrefix,
        isBuiltIn: false,
        providerEntry: entry,
        slashCommand: {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          content: entry.content,
          argumentHint: entry.argumentHint,
          allowedTools: entry.allowedTools,
          model: entry.model,
          source: entry.source,
          kind: entry.kind,
          disableModelInvocation: entry.disableModelInvocation,
          userInvocable: entry.userInvocable,
          context: entry.context,
          agent: entry.agent,
          hooks: entry.hooks,
        },
      });
    }

    return items;
  }

  private render(): void {
    if (!this.dropdownEl) {
      this.dropdownEl = this.createDropdownElement();
    }

    this.dropdownEl.empty();

    if (this.filteredItems.length === 0 && !this.providerDiscoveryState) {
      const emptyEl = this.dropdownEl.createDiv({ cls: 'claudian-slash-empty' });
      emptyEl.setText('No matching commands');
    } else {
      for (let i = 0; i < this.filteredItems.length; i++) {
        const item = this.filteredItems[i];
        const itemEl = this.dropdownEl.createDiv({ cls: 'claudian-slash-item' });

        if (i === this.selectedIndex) {
          itemEl.addClass('selected');
        }

        const nameEl = itemEl.createSpan({ cls: 'claudian-slash-name' });
        nameEl.setText(`${item.displayPrefix}${item.name}`);

        if (item.argumentHint) {
          const hintEl = itemEl.createSpan({ cls: 'claudian-slash-hint' });
          hintEl.setText(normalizeArgumentHint(item.argumentHint));
        }

        if (item.description) {
          const descEl = itemEl.createDiv({ cls: 'claudian-slash-desc' });
          descEl.setText(item.description);
        }

        itemEl.addEventListener('click', () => {
          this.selectedIndex = i;
          this.selectItem();
        });

        itemEl.addEventListener('mouseenter', () => {
          this.selectedIndex = i;
          this.updateSelection();
        });
      }
    }

    this.renderProviderDiscoveryState();

    this.dropdownEl.addClass('visible');

    if (this.isFixed) {
      this.positionFixed();
    }
  }

  private renderProviderDiscoveryState(): void {
    if (!this.dropdownEl || !this.providerDiscoveryState) return;

    const state = this.providerDiscoveryState;
    if (state.status === 'ready') return;

    const stateEl = this.dropdownEl.createDiv({
      cls: `claudian-slash-provider-state is-${state.status}`,
    });
    const messageEl = stateEl.createSpan({ cls: 'claudian-slash-provider-state-message' });

    switch (state.status) {
      case 'loading':
        messageEl.setText('Loading provider commands…');
        break;
      case 'empty':
        messageEl.setText('No provider commands advertised');
        break;
      case 'requires-session':
        messageEl.setText(state.message);
        break;
      case 'error': {
        messageEl.setText(state.message);
        const retryEl = stateEl.createEl('button', {
          cls: 'claudian-slash-provider-retry',
          text: 'Retry',
          attr: { type: 'button' },
        });
        retryEl.addEventListener('click', () => this.handleInputChange());
        break;
      }
    }
  }

  private createDropdownElement(): HTMLElement {
    if (this.isFixed) {
      return this.containerEl.createDiv({
        cls: 'claudian-slash-dropdown claudian-slash-dropdown-fixed',
      });
    } else {
      return this.containerEl.createDiv({ cls: 'claudian-slash-dropdown' });
    }
  }

  private positionFixed(): void {
    if (!this.dropdownEl || !this.isFixed) return;

    const inputRect = this.inputEl.getBoundingClientRect();
    this.dropdownEl.setCssProps({
      '--claudian-fixed-dropdown-bottom': `${window.innerHeight - inputRect.top + 4}px`,
      '--claudian-fixed-dropdown-left': `${inputRect.left}px`,
      '--claudian-fixed-dropdown-width': `${Math.max(inputRect.width, 280)}px`,
    });
  }

  private navigate(direction: number): void {
    const maxIndex = this.filteredItems.length - 1;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + direction));
    this.updateSelection();
  }

  private updateSelection(): void {
    const items = this.dropdownEl?.querySelectorAll('.claudian-slash-item');
    items?.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.removeClass('selected');
      }
    });
  }

  private selectItem(): void {
    if (this.filteredItems.length === 0) return;

    const selected = this.filteredItems[this.selectedIndex];
    if (!selected) return;

    const text = this.getInputValue();
    const beforeTrigger = text.substring(0, this.triggerStartIndex);
    const afterCursor = text.substring(this.getCursorPosition());
    const replacement = `${selected.insertPrefix}${selected.name} `;

    this.setInputValue(beforeTrigger + replacement + afterCursor);
    this.setCursorPosition(beforeTrigger.length + replacement.length);

    this.hide();
    if (selected.slashCommand) {
      this.callbacks.onSelect(selected.slashCommand);
    }
    this.inputEl.focus();
  }
}
