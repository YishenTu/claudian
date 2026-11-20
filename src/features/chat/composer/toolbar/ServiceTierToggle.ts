import { setIcon } from 'obsidian';

import type { ProviderServiceTierToggleConfig } from '@/core/providers/types';
import { toggleServiceTier } from '@/features/chat/composer/toggleServiceTier';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';
import { t } from '@/i18n/i18n';
import type { ModelMenuPart, ModelSelector } from '@/shared/toolbar/ModelSelector';
import { runToolbarAction } from '@/shared/toolbar/ToolbarMenu';

/**
 * Speed in the model menu, with an indicator on the model button while accelerated: a Fast switch when
 * Fast is the only accelerated tier, otherwise a segment for every tier the provider offers.
 */
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

  #getPolicy(): ProviderServiceTierToggleConfig | null {
    const uiConfig = this.callbacks.getUIConfig();
    return uiConfig.getServiceTierToggle?.(this.callbacks.getSettings()) ?? null;
  }

  updateDisplay() {
    const policy = this.#getPolicy();
    const sectionEl = this.part.sectionEl;
    sectionEl.empty();
    const standard = policy?.options[0];
    const selected = policy?.options.find(option => option.value === policy.selectedValue);
    const accelerated = !!standard && !!selected && selected !== standard;
    this.part.chipEl.toggleClass('claudian-hidden', !accelerated);
    this.part.describe(!accelerated
      ? null
      : selected.value === policy?.fastValue
        ? t('chat.modelPicker.fastActive')
        : t('chat.modelPicker.speedActive', { label: selected.label }));
    // While the menu browses another provider no model is chosen there, so, as for a model
    // without service tiers, no speed is offered. The button still shows the current model's state.
    if (!policy || !standard || !this.part.showsCurrentModel()) {
      this.part.showSection(false);
      return;
    }

    this.part.showSection(true);
    const fast = policy.options.length === 2 ? policy.options[1] : undefined;
    if (fast && fast.value === policy.fastValue) {
      this.#renderFastSwitch(accelerated, selected?.label ?? standard.label, fast.description);
    } else {
      this.#renderTierSegments(policy);
    }
    this.part.menu.restoreFocus();
  }

  #renderFastSwitch(isActive: boolean, currentLabel: string, description: string | undefined): void {
    const itemEl = this.part.menu.createItem(this.part.sectionEl, {
      role: 'switch',
      checked: isActive,
      tabbable: true,
      label: t('chat.modelPicker.fast'),
      cls: 'claudian-toolbar-popover-switch-row',
      title: [t('chat.modelPicker.fastLabel', { label: currentLabel }), description].filter(Boolean).join('\n'),
      leadingIcon: 'zap',
      onSelect: () => {
        runToolbarAction(async () => {
          await this.toggle();
        }, t('chat.modelPicker.changeTierFailed'));
      },
    });
    itemEl.createSpan({ cls: `claudian-toggle-switch${isActive ? ' active' : ''}` });
  }

  /**
   * One row of segments in the switch's slot, so the popover keeps its fixed height: Standard shows a
   * crossed-out zap, and each later tier one more zap than the last. Names are the tooltips and accessible names.
   */
  #renderTierSegments(policy: ProviderServiceTierToggleConfig): void {
    const listEl = this.part.sectionEl.createDiv({
      cls: 'claudian-service-tiers',
      attr: { role: 'listbox', 'aria-label': t('chat.modelPicker.speed'), 'aria-orientation': 'horizontal' },
    });
    policy.options.forEach((option, index) => {
      const selected = option.value === policy.selectedValue;
      const itemEl = this.part.menu.createItem(listEl, {
        role: 'option',
        key: `tier:${option.value}`,
        checked: selected,
        tabbable: selected,
        label: option.label,
        cls: `claudian-service-tier${selected ? ' selected' : ''}`,
        title: [option.label, option.description].filter(Boolean).join('\n'),
        onSelect: () => {
          runToolbarAction(async () => {
            await this.callbacks.onServiceTierChange(option.value);
            this.updateDisplay();
          }, t('chat.modelPicker.changeTierFailed'));
        },
      });
      if (option.description) itemEl.setAttribute('aria-description', option.description);
      const glyphEl = itemEl.createSpan({ cls: 'claudian-service-tier-glyph', attr: { 'aria-hidden': 'true' } });
      if (index === 0) {
        setIcon(glyphEl.createSpan(), 'zap-off');
      } else {
        for (let zap = 0; zap < index; zap++) setIcon(glyphEl.createSpan(), 'zap');
      }
      itemEl.prepend(glyphEl);
    });
  }

  async toggle(): Promise<boolean> {
    const toggled = await toggleServiceTier(this.callbacks);
    if (toggled) {
      this.updateDisplay();
    }
    return toggled;
  }
}
