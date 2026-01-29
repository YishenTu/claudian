/**
 * Claudian - Slash command dropdown
 *
 * Dropdown UI for selecting slash commands when typing /.
 * Follows the FileContext.ts pattern for input detection and keyboard navigation.
 */

import { getBuiltInCommandsForDropdown } from '../../core/commands';
import type { SlashCommand } from '../../core/types';

/**
 * SDK commands to filter out from the dropdown.
 * These are either handled differently in Claudian or don't apply.
 */
const FILTERED_SDK_COMMANDS = new Set([
  'context',
  'cost',
  'init',
  'keybindings-help',
  'release-notes',
  'security-review',
]);

export interface SlashCommandDropdownCallbacks {
  onSelect: (command: SlashCommand) => void;
  onHide: () => void;
  /**
   * Callback to fetch SDK supported commands.
   * SDK is the single source of truth for slash commands.
   * Only available after the service is initialized (first message sent).
   */
  getSdkCommands?: () => Promise<SlashCommand[]>;
}

export interface SlashCommandDropdownOptions {
  fixed?: boolean;
  hiddenCommands?: Set<string>;
}

export class SlashCommandDropdown {
  private containerEl: HTMLElement;
  private dropdownEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | HTMLInputElement;
  private callbacks: SlashCommandDropdownCallbacks;
  private onInput: () => void;
  private slashStartIndex = -1;
  private selectedIndex = 0;
  private filteredCommands: SlashCommand[] = [];
  private isFixed: boolean;
  private hiddenCommands: Set<string>;

  // SDK skills cache
  private cachedSdkSkills: SlashCommand[] = [];
  private sdkSkillsFetched = false;

  // Race condition guard for async dropdown rendering
  private requestId = 0;

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

    this.onInput = () => this.handleInputChange();
    this.inputEl.addEventListener('input', this.onInput);
  }

  setHiddenCommands(commands: Set<string>): void {
    this.hiddenCommands = commands;
  }

  handleInputChange(): void {
    const text = this.getInputValue();
    const cursorPos = this.getCursorPosition();
    const textBeforeCursor = text.substring(0, cursorPos);

    // Only show dropdown if / is at position 0
    if (text.charAt(0) !== '/') {
      this.hide();
      return;
    }

    const slashIndex = 0;

    const searchText = textBeforeCursor.substring(slashIndex + 1);

    // Hide if there's whitespace in the search text (command already selected)
    if (/\s/.test(searchText)) {
      this.hide();
      return;
    }

    this.slashStartIndex = slashIndex;
    this.showDropdown(searchText);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.isVisible()) return false;

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
        if (this.filteredCommands.length > 0) {
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
    if (this.dropdownEl) {
      this.dropdownEl.removeClass('visible');
    }
    this.slashStartIndex = -1;
    this.callbacks.onHide();
  }

  destroy(): void {
    this.inputEl.removeEventListener('input', this.onInput);
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  /**
   * Resets the SDK skills cache.
   * Call this when switching conversations or creating a new chat.
   */
  resetSdkSkillsCache(): void {
    this.cachedSdkSkills = [];
    this.sdkSkillsFetched = false;
    this.requestId = 0;
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

  private async showDropdown(searchText: string): Promise<void> {
    const currentRequest = ++this.requestId;

    const builtInCommands = getBuiltInCommandsForDropdown();
    const searchLower = searchText.toLowerCase();

    // Fetch SDK commands if not cached and callback is available
    // SDK is the single source of truth for slash commands
    // Only mark as fetched when we get non-empty results (service is ready)
    // This allows retries when service isn't ready yet or on transient errors
    if (!this.sdkSkillsFetched && this.callbacks.getSdkCommands) {
      try {
        const sdkCommands = await this.callbacks.getSdkCommands();
        // Discard results if a newer request was made during await
        if (currentRequest !== this.requestId) return;
        if (sdkCommands.length > 0) {
          this.cachedSdkSkills = sdkCommands;
          this.sdkSkillsFetched = true;
        }
        // Keep sdkSkillsFetched false to allow retry on empty results
      } catch {
        // Keep sdkSkillsFetched false to allow retry on error
        if (currentRequest !== this.requestId) return;
      }
    }

    const allCommands = this.buildCommandList(builtInCommands);

    this.filteredCommands = allCommands
      .filter(cmd =>
        cmd.name.toLowerCase().includes(searchLower) ||
        cmd.description?.toLowerCase().includes(searchLower)
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    // Final race condition check before rendering
    if (currentRequest !== this.requestId) return;

    if (searchText.length > 0 && this.filteredCommands.length === 0) {
      this.hide();
      return;
    }

    this.selectedIndex = 0;
    this.render();
  }

  /**
   * Builds the merged command list from built-in and SDK commands.
   * Built-in commands have highest priority and are not subject to hiding.
   * SDK commands are deduplicated, filtered, and respect user hiding.
   */
  private buildCommandList(builtInCommands: SlashCommand[]): SlashCommand[] {
    const seenNames = new Set<string>();
    const allCommands: SlashCommand[] = [];

    // Add Claudian built-in commands first (highest priority)
    // Built-in commands are not subject to user hiding (they are essential UI actions)
    for (const cmd of builtInCommands) {
      const nameLower = cmd.name.toLowerCase();
      if (!seenNames.has(nameLower)) {
        seenNames.add(nameLower);
        allCommands.push(cmd);
      }
    }

    for (const cmd of this.cachedSdkSkills) {
      const nameLower = cmd.name.toLowerCase();
      if (
        FILTERED_SDK_COMMANDS.has(nameLower) ||
        seenNames.has(nameLower) ||
        this.hiddenCommands.has(nameLower)
      ) {
        continue;
      }
      seenNames.add(nameLower);
      allCommands.push(cmd);
    }

    return allCommands;
  }

  private render(): void {
    if (!this.dropdownEl) {
      this.dropdownEl = this.createDropdownElement();
    }

    this.dropdownEl.empty();

    if (this.filteredCommands.length === 0) {
      const emptyEl = this.dropdownEl.createDiv({ cls: 'claudian-slash-empty' });
      emptyEl.setText('No matching commands');
    } else {
      for (let i = 0; i < this.filteredCommands.length; i++) {
        const cmd = this.filteredCommands[i];
        const itemEl = this.dropdownEl.createDiv({ cls: 'claudian-slash-item' });

        if (i === this.selectedIndex) {
          itemEl.addClass('selected');
        }

        const nameEl = itemEl.createSpan({ cls: 'claudian-slash-name' });
        nameEl.setText(`/${cmd.name}`);

        if (cmd.argumentHint) {
          const hintEl = itemEl.createSpan({ cls: 'claudian-slash-hint' });
          hintEl.setText(`[${cmd.argumentHint}]`);
        }

        if (cmd.description) {
          const descEl = itemEl.createDiv({ cls: 'claudian-slash-desc' });
          descEl.setText(cmd.description);
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

    this.dropdownEl.addClass('visible');

    // Position for fixed mode (inline editor)
    if (this.isFixed) {
      this.positionFixed();
    }
  }

  private createDropdownElement(): HTMLElement {
    if (this.isFixed) {
      // For inline editor: append to containerEl with fixed positioning
      const dropdown = this.containerEl.createDiv({
        cls: 'claudian-slash-dropdown claudian-slash-dropdown-fixed',
      });
      return dropdown;
    } else {
      // For chat panel: append to container with absolute positioning
      return this.containerEl.createDiv({ cls: 'claudian-slash-dropdown' });
    }
  }

  private positionFixed(): void {
    if (!this.dropdownEl || !this.isFixed) return;

    const inputRect = this.inputEl.getBoundingClientRect();
    this.dropdownEl.style.position = 'fixed';
    this.dropdownEl.style.bottom = `${window.innerHeight - inputRect.top + 4}px`;
    this.dropdownEl.style.left = `${inputRect.left}px`;
    this.dropdownEl.style.right = 'auto';
    this.dropdownEl.style.width = `${Math.max(inputRect.width, 280)}px`;
    this.dropdownEl.style.zIndex = '10001'; // Above CM6 widgets
  }

  private navigate(direction: number): void {
    const maxIndex = this.filteredCommands.length - 1;
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
    if (this.filteredCommands.length === 0) return;

    const selected = this.filteredCommands[this.selectedIndex];
    if (!selected) return;

    const text = this.getInputValue();
    const beforeSlash = text.substring(0, this.slashStartIndex);
    const afterCursor = text.substring(this.getCursorPosition());
    const replacement = `/${selected.name} `;

    this.setInputValue(beforeSlash + replacement + afterCursor);
    this.setCursorPosition(beforeSlash.length + replacement.length);

    this.hide();
    this.callbacks.onSelect(selected);
    this.inputEl.focus();
  }
}
