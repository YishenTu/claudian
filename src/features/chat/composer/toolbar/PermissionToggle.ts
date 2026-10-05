import { setIcon } from 'obsidian';

import type { ProviderPermissionModeOption } from '@/core/providers/types';
import { runToolbarAction, ToolbarMenu, type ToolbarMenuGroup } from '@/features/chat/composer/toolbar/ToolbarMenu';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';

/** Choice among the provider's permission modes. */
export class PermissionToggle {
  private readonly menu: ToolbarMenu;
  private readonly iconEl: HTMLElement;
  private readonly labelEl: HTMLElement;
  private callbacks: ToolbarCallbacks;
  private visible = true;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks, menuGroup?: ToolbarMenuGroup) {
    this.callbacks = callbacks;
    this.menu = new ToolbarMenu(parentEl, {
      anchorCls: 'claudian-permission-toggle',
      menuLabel: 'Permission mode',
      closeOnSelect: true,
      group: menuGroup,
      onOpen: () => this.updateDisplay(),
    });
    this.iconEl = this.menu.createChipPart('claudian-toolbar-chip-icon');
    this.labelEl = this.menu.createChipPart('claudian-toolbar-chip-primary claudian-permission-label');
    this.updateDisplay();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateDisplay();
  }

  #getOptions(): readonly ProviderPermissionModeOption[] {
    return this.callbacks.getUIConfig().getPermissionModeOptions?.(this.callbacks.getSettings()) ?? [];
  }

  updateDisplay() {
    const options = this.#getOptions();
    if (!this.visible || options.length === 0) {
      this.menu.close(false);
      this.menu.anchorEl.addClass('claudian-hidden');
      return;
    }

    this.menu.anchorEl.removeClass('claudian-hidden');
    const mode = this.callbacks.getSettings().permissionMode;
    // The projection normalizes the stored mode; the first option only covers a transient mismatch.
    const current = options.find(option => option.value === mode) ?? options[0];
    const bypasses = current.bypassesApprovals === true;
    this.labelEl.setText(current.label);
    this.iconEl.empty();
    this.iconEl.toggleClass('claudian-hidden', !bypasses);
    if (bypasses) setIcon(this.iconEl, 'shield-alert');
    this.menu.buttonEl.toggleClass('claudian-toolbar-chip--alert', bypasses);
    this.menu.buttonEl.setAttribute('aria-label', `Permission mode: ${current.label}`);

    this.menu.menuEl.empty();
    for (const choice of options) {
      this.menu.createItem(this.menu.menuEl, {
        role: 'menuitemradio',
        checked: choice.value === mode,
        label: choice.label,
        detail: choice.description,
        showCheck: true,
        onSelect: () => {
          if (choice.value === this.callbacks.getSettings().permissionMode) return;
          runToolbarAction(async () => {
            await this.callbacks.onPermissionModeChange(choice.value);
            this.updateDisplay();
          }, 'Failed to change permission mode');
        },
      });
    }
    this.menu.restoreFocus();
  }
}
