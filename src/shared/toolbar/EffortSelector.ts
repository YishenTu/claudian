import { formatReasoningValueLabel } from '@/core/providers/reasoning';
import type { ProviderUIOption } from '@/core/providers/types';
import type { ModelMenuPart, ModelSelector } from '@/shared/toolbar/ModelSelector';
import { nextToolbarId, runToolbarAction } from '@/shared/toolbar/ToolbarMenu';
import type { ModelPickerCallbacks } from '@/shared/toolbar/types';

/** Bars in each level's strength glyph, however many levels the provider reports. */
const STRENGTH_BARS = 4;

/** Effort: a level on the model button, a list of levels in its popover. */
export class EffortSelector {
  private readonly part: ModelMenuPart;
  private callbacks: ModelPickerCallbacks;

  constructor(modelSelector: ModelSelector, callbacks: ModelPickerCallbacks) {
    this.callbacks = callbacks;
    this.part = modelSelector.attachPart(
      'reasoning',
      'claudian-toolbar-chip-secondary claudian-thinking-current',
      () => this.updateDisplay(),
    );
    this.part.sectionEl.addClass('claudian-thinking-selector');
    this.updateDisplay();
  }

  #hide(): void {
    this.part.chipEl.addClass('claudian-hidden');
    this.part.sectionEl.addClass('claudian-hidden');
    this.part.sectionEl.empty();
    this.part.describe(null);
  }

  updateDisplay() {
    const capabilities = this.callbacks.getCapabilities();
    if (capabilities.reasoningControl === 'none') {
      this.#hide();
      return;
    }

    const settings = this.callbacks.getSettings();
    const model = settings.model;
    const uiConfig = this.callbacks.getUIConfig();
    const options: ProviderUIOption[] = uiConfig.getReasoningOptions(model, settings);
    const defaultValue = uiConfig.getDefaultReasoningValue(model, settings);
    const shouldHide = options.length === 0
      || (options.length === 1 && options[0]?.value === defaultValue);
    if (shouldHide) {
      this.#hide();
      return;
    }

    const current = settings.reasoning;
    const currentLabel = options.find(option => option.value === current)?.label
      ?? (current ? formatReasoningValueLabel(current) : 'Default');

    this.part.chipEl.removeClass('claudian-hidden');
    this.part.chipEl.setText(currentLabel);
    this.part.describe(`effort ${currentLabel}`);
    this.part.sectionEl.removeClass('claudian-hidden');
    this.#renderLevels(options, defaultValue, current);
    this.part.menu.restoreFocus();
  }

  /** Levels from the deepest at the top to the fastest at the bottom; the provider lists them fastest first. */
  #renderLevels(options: ProviderUIOption[], defaultValue: string, current: string | null): void {
    const sectionEl = this.part.sectionEl;
    sectionEl.empty();
    const headingId = nextToolbarId('heading');
    sectionEl.createDiv({ cls: 'claudian-toolbar-popover-heading', text: 'Thinking', attr: { id: headingId } });
    const listEl = sectionEl.createDiv({
      cls: 'claudian-thinking-levels',
      attr: { role: 'listbox', 'aria-labelledby': headingId },
    });
    // The list is one tab stop: the current level, else the default, else the top level.
    // No level is chosen while the menu browses another provider's models.
    const chosen = this.part.showsCurrentModel() ? current : null;
    const tabStop = [chosen, defaultValue].find(value => options.some(option => option.value === value))
      ?? options[options.length - 1].value;
    for (let index = options.length - 1; index >= 0; index--) {
      const option = options[index];
      const selected = option.value === chosen;
      const itemEl = this.part.menu.createItem(listEl, {
        role: 'option',
        key: `level:${option.value}`,
        checked: selected,
        tabbable: option.value === tabStop,
        label: option.label,
        cls: `claudian-thinking-level${selected ? ' selected' : ''}`,
        onSelect: () => {
          runToolbarAction(async () => {
            await this.callbacks.onEffortLevelChange(option.value);
            this.updateDisplay();
          }, 'Failed to change effort level');
        },
      });
      // The level's description is announced, not shown: no text under the level and no hover tooltip.
      if (option.description) itemEl.setAttribute('aria-description', option.description);

      const barsEl = itemEl.createSpan({ cls: 'claudian-thinking-strength', attr: { 'aria-hidden': 'true' } });
      const filled = Math.max(1, Math.round(((index + 1) / options.length) * STRENGTH_BARS));
      for (let bar = 0; bar < STRENGTH_BARS; bar++) {
        barsEl.createSpan({ cls: bar < filled ? 'is-filled' : '' });
      }
      itemEl.prepend(barsEl);
    }
  }
}
