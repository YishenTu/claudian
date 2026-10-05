import { formatReasoningValueLabel } from '@/core/providers/reasoning';
import type { ProviderUIOption } from '@/core/providers/types';
import type { ModelMenuPart, ModelSelector } from '@/features/chat/composer/toolbar/ModelSelector';
import { nextToolbarId, runToolbarAction } from '@/features/chat/composer/toolbar/ToolbarMenu';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';

/** Levels the provider reports for the current model, in its order. */
interface ReasoningScale {
  options: ProviderUIOption[];
  defaultValue: string;
}

interface ReasoningSlider {
  inputEl: HTMLInputElement;
  valueEl: HTMLElement;
  segmentEls: HTMLElement[];
  tickEls: HTMLElement[];
}

/** Effort: a level on the model button, a slider in its popover. */
export class EffortSelector {
  private readonly part: ModelMenuPart;
  private callbacks: ToolbarCallbacks;
  #scale: ReasoningScale | null = null;
  #scaleKey: string | null = null;
  #slider: ReasoningSlider | null = null;
  #dragging = false;
  /** Commits still saving; the slider keeps the user's latest level until all have landed. */
  #pendingCommits = 0;

  constructor(modelSelector: ModelSelector, callbacks: ToolbarCallbacks) {
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
    this.#scale = null;
    this.#scaleKey = null;
    this.#slider = null;
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
    const currentIndex = options.findIndex(option => option.value === current);
    const currentLabel = options[currentIndex]?.label
      ?? (current ? formatReasoningValueLabel(current) : 'Default');

    this.part.chipEl.removeClass('claudian-hidden');
    this.part.chipEl.setText(currentLabel);
    this.part.describe(`effort ${currentLabel}`);
    this.part.sectionEl.removeClass('claudian-hidden');

    // Rebuild only when the levels change, so a refresh never replaces the slider under the user.
    const scale = { options, defaultValue };
    const scaleKey = JSON.stringify([
      defaultValue, options.map(option => [option.value, option.label, option.description]),
    ]);
    if (scaleKey !== this.#scaleKey || !this.#slider) {
      this.#scaleKey = scaleKey;
      this.#slider = this.#buildSlider(scale);
    }
    this.#scale = scale;

    if (!this.#dragging && this.#pendingCommits === 0) {
      const fallbackIndex = Math.max(0, options.findIndex(option => option.value === defaultValue));
      const index = currentIndex >= 0 ? currentIndex : fallbackIndex;
      this.#slider.inputEl.value = String(index);
      this.#showLevel(index, currentIndex >= 0 ? undefined : currentLabel);
    }
    this.part.menu.restoreFocus();
  }

  #buildSlider(scale: ReasoningScale): ReasoningSlider {
    const sectionEl = this.part.sectionEl;
    sectionEl.empty();
    const name = 'Effort';
    const nameId = nextToolbarId('slider-name');
    const groupEl = sectionEl.createDiv({
      cls: 'claudian-toolbar-slider-group claudian-thinking-effort',
      attr: { role: 'group', 'aria-labelledby': nameId },
    });
    const headerEl = groupEl.createDiv({ cls: 'claudian-toolbar-slider-header' });
    headerEl.createSpan({ cls: 'claudian-toolbar-slider-name', text: name, attr: { id: nameId } });
    const valueEl = headerEl.createSpan({ cls: 'claudian-toolbar-slider-value' });

    const endsEl = groupEl.createDiv({ cls: 'claudian-toolbar-slider-ends', attr: { 'aria-hidden': 'true' } });
    endsEl.createSpan({ text: 'Faster' });
    endsEl.createSpan({ text: 'Smarter' });

    // The fill and stops are drawn under a transparent native range input that takes all pointer input.
    const controlEl = groupEl.createDiv({ cls: 'claudian-toolbar-slider' });
    const trackEl = controlEl.createDiv({ cls: 'claudian-toolbar-slider-track', attr: { 'aria-hidden': 'true' } });
    trackEl.createSpan({ cls: 'claudian-toolbar-slider-fill-start' });
    const segmentEls = scale.options.slice(1).map(() => trackEl.createSpan({ cls: 'claudian-toolbar-slider-segment' }));
    const stopsEl = controlEl.createDiv({ cls: 'claudian-toolbar-slider-stops', attr: { 'aria-hidden': 'true' } });
    const tickEls = scale.options.map(option => stopsEl.createSpan({
      cls: `claudian-toolbar-slider-tick${option.value === scale.defaultValue ? ' claudian-toolbar-slider-tick--recommended' : ''}`,
    }));
    const inputEl = controlEl.createEl('input', {
      cls: 'claudian-toolbar-slider-input',
      attr: {
        type: 'range',
        min: '0',
        max: String(scale.options.length - 1),
        step: '1',
        'aria-labelledby': nameId,
        'data-menu-key': `slider:${name}`,
      },
    });

    inputEl.addEventListener('input', () => this.#showLevel(Number(inputEl.value)));
    // Change fires once when a drag is released and once per keyboard step, never per stop crossed mid-drag.
    inputEl.addEventListener('change', () => this.#commit(Number(inputEl.value)));
    inputEl.addEventListener('pointerdown', () => this.#startDrag(inputEl));

    return { inputEl, valueEl, segmentEls, tickEls };
  }

  #startDrag(inputEl: HTMLInputElement): void {
    this.#dragging = true;
    const ownerDocument = inputEl.ownerDocument;
    const endDrag = (): void => {
      this.#dragging = false;
      ownerDocument.removeEventListener('pointerup', endDrag, true);
      ownerDocument.removeEventListener('pointercancel', endDrag, true);
    };
    ownerDocument.addEventListener('pointerup', endDrag, true);
    ownerDocument.addEventListener('pointercancel', endDrag, true);
  }

  /** Shows the level under the thumb; a label override covers a saved value the provider no longer lists. */
  #showLevel(index: number, labelOverride?: string): void {
    const scale = this.#scale;
    const slider = this.#slider;
    const option = scale?.options[index];
    if (!scale || !slider || !option) return;

    const label = labelOverride ?? option.label;
    const detail = labelOverride ? '' : option.description ?? '';

    slider.inputEl.setAttribute('aria-valuetext', label);
    slider.valueEl.setText(label);
    // The level's description is announced, not shown: no text under the track and no hover tooltip.
    if (detail) {
      slider.inputEl.setAttribute('aria-description', detail);
    } else {
      slider.inputEl.removeAttribute('aria-description');
    }
    slider.segmentEls.forEach((segmentEl, segment) => segmentEl.toggleClass('is-filled', segment < index));
    slider.tickEls.forEach((tickEl, tick) => tickEl.toggleClass('is-filled', tick <= index));
  }

  #commit(index: number): void {
    const scale = this.#scale;
    const option = scale?.options[index];
    if (!scale || !option) return;
    runToolbarAction(async () => {
      this.#pendingCommits++;
      try {
        await this.callbacks.onEffortLevelChange(option.value);
      } finally {
        this.#pendingCommits--;
        // Once every commit has landed, show what was saved, including a rollback after a failure.
        if (this.#pendingCommits === 0) this.updateDisplay();
      }
    }, 'Failed to change effort level');
  }
}
