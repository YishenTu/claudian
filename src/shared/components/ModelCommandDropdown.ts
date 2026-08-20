/**
 * Claudian - Model command dropdown
 *
 * Dropup UI for picking a model. Shown when the /model built-in command is
 * executed without a matching argument.
 */

import type { ProviderUIOption } from '../../core/providers/types';
import { createProviderIconSvg } from '../icons';

export interface ModelCommandDropdownCallbacks {
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

export class ModelCommandDropdown {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private dropdownEl: HTMLElement;
  private callbacks: ModelCommandDropdownCallbacks;
  private options: ProviderUIOption[];
  private currentValue: string;
  private selectedIndex: number;
  private onInput: () => void;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    options: ProviderUIOption[],
    currentValue: string,
    callbacks: ModelCommandDropdownCallbacks
  ) {
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.options = options;
    this.currentValue = currentValue;
    this.callbacks = callbacks;
    this.selectedIndex = Math.max(0, options.findIndex((option) => option.value === currentValue));

    this.dropdownEl = this.containerEl.createDiv({ cls: 'claudian-modelcmd-dropdown' });
    this.render();
    this.dropdownEl.addClass('visible');

    // Auto-dismiss when user starts typing
    this.onInput = () => this.dismiss();
    this.inputEl.addEventListener('input', this.onInput);
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
        if (this.options.length > 0) {
          e.preventDefault();
          this.selectItem();
          return true;
        }
        return false;
      case 'Escape':
        e.preventDefault();
        this.dismiss();
        return true;
    }
    return false;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  destroy(): void {
    this.inputEl.removeEventListener('input', this.onInput);
    this.dropdownEl?.remove();
  }

  private dismiss(): void {
    this.dropdownEl.removeClass('visible');
    this.callbacks.onDismiss();
  }

  private selectItem(): void {
    if (this.options.length === 0) return;
    const selected = this.options[this.selectedIndex];
    if (!selected) return;

    if (selected.value === this.currentValue) {
      this.dismiss();
      return;
    }

    this.callbacks.onSelect(selected.value);
  }

  private navigate(direction: number): void {
    const maxIndex = this.options.length - 1;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + direction));
    this.updateSelection();
  }

  private updateSelection(): void {
    const items = this.dropdownEl.querySelectorAll('.claudian-modelcmd-item');
    items?.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.removeClass('selected');
      }
    });
  }

  private render(): void {
    this.dropdownEl.empty();

    const header = this.dropdownEl.createDiv({ cls: 'claudian-modelcmd-header' });
    header.createSpan({ text: 'Switch model' });

    if (this.options.length === 0) {
      this.dropdownEl.createDiv({ cls: 'claudian-modelcmd-empty', text: 'No models available' });
      return;
    }

    const list = this.dropdownEl.createDiv({ cls: 'claudian-modelcmd-list' });

    let lastGroup: string | undefined;
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i];
      const isCurrent = option.value === this.currentValue;

      if (option.group && option.group !== lastGroup) {
        const separator = list.createDiv({ cls: 'claudian-modelcmd-group' });
        separator.setText(option.group);
        lastGroup = option.group;
      }

      const item = list.createDiv({ cls: 'claudian-modelcmd-item' });
      if (isCurrent) item.addClass('current');
      if (i === this.selectedIndex) item.addClass('selected');

      if (option.providerIcon) {
        const iconEl = item.createDiv({ cls: 'claudian-modelcmd-item-icon' });
        iconEl.appendChild(createProviderIconSvg(option.providerIcon, {
          className: 'claudian-modelcmd-provider-icon',
          height: 14,
          ownerDocument: item.ownerDocument,
          width: 14,
        }));
      }

      const content = item.createDiv({ cls: 'claudian-modelcmd-item-content' });
      content.createDiv({ cls: 'claudian-modelcmd-item-label', text: option.label });
      if (option.description) {
        content.createDiv({ cls: 'claudian-modelcmd-item-description', text: option.description });
      }

      item.addEventListener('click', () => {
        if (isCurrent) {
          this.dismiss();
          return;
        }
        this.callbacks.onSelect(option.value);
      });

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        this.updateSelection();
      });
    }
  }
}
