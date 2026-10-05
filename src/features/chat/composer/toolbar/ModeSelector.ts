import type { ProviderModeSelectorConfig, ProviderUIOption } from '@/core/providers/types';
import { runToolbarAction, ToolbarMenu, type ToolbarMenuGroup } from '@/features/chat/composer/toolbar/ToolbarMenu';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';

/** Provider mode choice; shown only when the provider supplies exactly two options. */
export class ModeSelector {
  private readonly menu: ToolbarMenu;
  private readonly labelEl: HTMLElement;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks, menuGroup?: ToolbarMenuGroup) {
    this.callbacks = callbacks;
    this.menu = new ToolbarMenu(parentEl, {
      anchorCls: 'claudian-mode-selector',
      menuLabel: 'Mode',
      closeOnSelect: true,
      group: menuGroup,
      onOpen: () => this.updateDisplay(),
    });
    this.labelEl = this.menu.createChipPart('claudian-toolbar-chip-primary claudian-mode-label');
    this.updateDisplay();
  }

  #getSelectorConfig(): ProviderModeSelectorConfig | null {
    return this.callbacks.getUIConfig().getModeSelector?.(this.callbacks.getSettings()) ?? null;
  }

  /** Resolves which of the two options carries the provider's active style. */
  #resolveActiveOption(selectorConfig: ProviderModeSelectorConfig): ProviderUIOption {
    const second = selectorConfig.options[1];
    return selectorConfig.activeValue
      ? selectorConfig.options.find((option) => option.value === selectorConfig.activeValue) ?? second
      : second;
  }

  updateDisplay() {
    const selectorConfig = this.#getSelectorConfig();
    if (!selectorConfig || selectorConfig.options.length !== 2) {
      this.menu.close(false);
      this.menu.anchorEl.addClass('claudian-hidden');
      return;
    }

    this.menu.anchorEl.removeClass('claudian-hidden');
    const active = this.#resolveActiveOption(selectorConfig);
    const currentOption = selectorConfig.options.find((option) => option.value === selectorConfig.value)
      ?? selectorConfig.options[0];
    const currentLabel = currentOption.label || selectorConfig.label;

    this.labelEl.setText(currentLabel);
    this.menu.buttonEl.toggleClass('claudian-toolbar-chip--accent', currentOption.value === active.value);
    this.menu.buttonEl.setAttribute('aria-label', `${selectorConfig.label}: ${currentLabel}`);
    this.menu.menuEl.setAttribute('aria-label', selectorConfig.label);

    this.menu.menuEl.empty();
    for (const option of selectorConfig.options) {
      this.menu.createItem(this.menu.menuEl, {
        role: 'menuitemradio',
        checked: option.value === currentOption.value,
        label: option.label,
        detail: option.description,
        showCheck: true,
        onSelect: () => {
          if (option.value === currentOption.value) return;
          runToolbarAction(async () => {
            await this.callbacks.onModeChange(option.value);
            this.updateDisplay();
          }, 'Failed to change mode');
        },
      });
    }
    this.menu.restoreFocus();
  }

  renderOptions() {
    this.updateDisplay();
  }
}
