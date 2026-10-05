import { setIcon } from 'obsidian';

import type { ProviderServiceTierToggleConfig } from '@/core/providers/types';
import { toggleServiceTier } from '@/features/chat/composer/toggleServiceTier';
import type { ModelMenuPart, ModelSelector } from '@/features/chat/composer/toolbar/ModelSelector';
import { runToolbarAction } from '@/features/chat/composer/toolbar/ToolbarMenu';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';

/** Fast-mode switch in the model menu, with an indicator on the model button while active. */
export class ServiceTierToggle {
  private readonly part: ModelMenuPart;
  private callbacks: ToolbarCallbacks;

  constructor(modelSelector: ModelSelector, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.part = modelSelector.attachPart(
      'serviceTier',
      'claudian-toolbar-chip-secondary claudian-service-tier-indicator',
      () => this.updateDisplay(),
    );
    setIcon(this.part.chipEl, 'zap');
    this.part.sectionEl.addClass('claudian-service-tier-toggle');
    this.updateDisplay();
  }

  #getToggleConfig(): ProviderServiceTierToggleConfig | null {
    const uiConfig = this.callbacks.getUIConfig();
    return uiConfig.getServiceTierToggle?.(this.callbacks.getSettings()) ?? null;
  }

  updateDisplay() {
    const toggleConfig = this.#getToggleConfig();
    const sectionEl = this.part.sectionEl;
    sectionEl.empty();
    this.part.chipEl.toggleClass('claudian-hidden', !toggleConfig?.isActive);
    this.part.describe(toggleConfig?.isActive ? 'fast mode on' : null);
    if (!toggleConfig) {
      sectionEl.addClass('claudian-hidden');
      return;
    }

    sectionEl.removeClass('claudian-hidden');
    const currentLabel = toggleConfig.isActive ? toggleConfig.activeLabel : toggleConfig.inactiveLabel;
    const itemEl = this.part.menu.createItem(sectionEl, {
      role: 'switch',
      checked: toggleConfig.isActive,
      tabbable: true,
      label: 'Fast mode',
      cls: 'claudian-toolbar-popover-switch-row',
      title: [`Fast mode: ${currentLabel}`, toggleConfig.description].filter(Boolean).join('\n'),
      leadingIcon: 'zap',
      onSelect: () => {
        runToolbarAction(async () => {
          await this.toggle();
        }, 'Failed to change service tier');
      },
    });
    itemEl.createSpan({ cls: `claudian-toggle-switch${toggleConfig.isActive ? ' active' : ''}` });
    this.part.menu.restoreFocus();
  }

  async toggle(): Promise<boolean> {
    const toggled = await toggleServiceTier(this.callbacks);
    if (toggled) {
      this.updateDisplay();
    }
    return toggled;
  }
}
