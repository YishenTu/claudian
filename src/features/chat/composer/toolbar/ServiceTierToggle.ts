import { setIcon } from 'obsidian';

import type { ProviderServiceTierToggleConfig, ProviderUIOption } from '@/core/providers/types';
import { toggleServiceTier } from '@/features/chat/composer/toggleServiceTier';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';
import { t } from '@/i18n/i18n';
import type { ModelMenuPart, ModelSelector } from '@/shared/toolbar/ModelSelector';
import { runToolbarAction } from '@/shared/toolbar/ToolbarMenu';

type FastSwitchPolicy = Extract<ProviderServiceTierToggleConfig, { kind: 'fast-switch' }>;
type TierListPolicy = Extract<ProviderServiceTierToggleConfig, { kind: 'tiers' }>;
type TierSegmentGlyph = { readonly kind: 'off' } | { readonly kind: 'zaps'; readonly count: number };

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
    this.part.sectionEl.addClass('claudian-service-tier-toggle');
    this.updateDisplay();
  }

  #getPolicy(): ProviderServiceTierToggleConfig | null {
    const uiConfig = this.callbacks.getUIConfig();
    return uiConfig.getServiceTierToggle?.(this.callbacks.getSettings()) ?? null;
  }

  #renderZaps(parentEl: HTMLElement, count: number): void {
    for (let zap = 0; zap < count; zap++) setIcon(parentEl.createSpan(), 'zap');
  }

  updateDisplay() {
    const policy = this.#getPolicy();
    const sectionEl = this.part.sectionEl;
    sectionEl.empty();
    const selection = policy?.selection ?? null;
    this.part.chipEl.empty();
    if (selection?.kind === 'accelerated') {
      this.part.chipEl.removeClass('claudian-hidden');
      this.#renderZaps(this.part.chipEl, selection.option.level);
      this.part.describe(selection.option.isFast
        ? t('chat.modelPicker.fastActive')
        : t('chat.modelPicker.speedActive', { label: selection.option.label }));
    } else {
      this.part.chipEl.addClass('claudian-hidden');
      this.part.describe(null);
    }

    // While the menu browses another provider no model is chosen there, so, as for a model
    // without service tiers, no speed is offered. The button still shows the current model's state.
    if (!policy || !this.part.showsCurrentModel()) {
      this.part.showSection(false);
      return;
    }

    this.part.showSection(true);
    switch (policy.kind) {
      case 'fast-switch':
        this.#renderFastSwitch(policy);
        break;
      case 'tiers':
        this.#renderTierSegments(policy);
        break;
    }
    this.part.menu.restoreFocus();
  }

  #renderFastSwitch(policy: FastSwitchPolicy): void {
    const isActive = policy.selection.kind === 'accelerated';
    const currentLabel = policy.selection.option.label;
    const itemEl = this.part.menu.createItem(this.part.sectionEl, {
      role: 'switch',
      checked: isActive,
      tabbable: true,
      label: t('chat.modelPicker.fast'),
      cls: 'claudian-toolbar-popover-switch-row',
      title: [t('chat.modelPicker.fastLabel', { label: currentLabel }), policy.fast.description].filter(Boolean).join('\n'),
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
   * crossed-out zap, and each accelerated tier shows its level's zap count. Names are tooltips and accessible names.
   */
  #renderTierSegments(policy: TierListPolicy): void {
    const listEl = this.part.sectionEl.createDiv({
      cls: 'claudian-service-tiers',
      attr: { role: 'listbox', 'aria-label': t('chat.modelPicker.speed'), 'aria-orientation': 'horizontal' },
    });
    const renderSegment = (option: ProviderUIOption, selected: boolean, glyph: TierSegmentGlyph) => {
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
      if (glyph.kind === 'off') {
        setIcon(glyphEl.createSpan(), 'zap-off');
      } else {
        this.#renderZaps(glyphEl, glyph.count);
      }
      itemEl.prepend(glyphEl);
    };

    renderSegment(policy.standard, policy.selection.kind === 'standard', { kind: 'off' });
    for (const tier of policy.accelerated) {
      renderSegment(
        tier,
        policy.selection.kind === 'accelerated' && policy.selection.option.value === tier.value,
        { kind: 'zaps', count: tier.level },
      );
    }
  }

  async toggle(): Promise<boolean> {
    const toggled = await toggleServiceTier(this.callbacks);
    if (toggled) {
      this.updateDisplay();
    }
    return toggled;
  }
}
