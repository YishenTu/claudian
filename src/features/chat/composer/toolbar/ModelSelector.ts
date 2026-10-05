import { nextToolbarId, runToolbarAction, ToolbarMenu, type ToolbarMenuGroup } from '@/features/chat/composer/toolbar/ToolbarMenu';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';
import { createProviderIconSvg } from '@/shared/icons';

/** A section of the model menu plus a matching detail on the model button. */
export interface ModelMenuPart {
  readonly chipEl: HTMLElement;
  readonly sectionEl: HTMLElement;
  readonly menu: ToolbarMenu;
  /** Sets this part's phrase in the model button's accessible name; null omits it. */
  describe(text: string | null): void;
}

/** Model button: model, reasoning and fast mode on one chip, with one menu for all three. */
export class ModelSelector {
  private readonly menu: ToolbarMenu;
  private readonly iconSlotEl: HTMLElement;
  private readonly labelEl: HTMLElement;
  private readonly optionsEl: HTMLElement;
  private readonly partRefreshers: Array<() => void> = [];
  private readonly partDescriptions = new Map<string, string | null>();
  private modelDescription = '';
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks, menuGroup?: ToolbarMenuGroup) {
    this.callbacks = callbacks;
    this.menu = new ToolbarMenu(parentEl, {
      anchorCls: 'claudian-toolbar-chip-anchor--model claudian-model-selector',
      buttonCls: 'claudian-model-btn',
      menuLabel: 'Model options',
      popupRole: 'dialog',
      closeOnSelect: false,
      group: menuGroup,
      onOpen: () => {
        this.updateDisplay();
        this.renderOptions();
        for (const refresh of this.partRefreshers) refresh();
      },
    });
    this.iconSlotEl = this.menu.createChipPart('claudian-toolbar-chip-icon');
    this.labelEl = this.menu.createChipPart('claudian-toolbar-chip-primary claudian-model-label');
    this.optionsEl = this.menu.menuEl.createDiv({
      cls: 'claudian-toolbar-popover-section claudian-model-options',
    });
    this.updateDisplay();
    this.renderOptions();
  }

  /** Lets the reasoning and service-tier controls share this button and menu. */
  attachPart(key: string, chipCls: string, refresh: () => void): ModelMenuPart {
    this.partRefreshers.push(refresh);
    this.partDescriptions.set(key, null);
    return {
      chipEl: this.menu.createChipPart(chipCls),
      sectionEl: this.menu.menuEl.createDiv({ cls: 'claudian-toolbar-popover-section' }),
      menu: this.menu,
      describe: (text) => {
        this.partDescriptions.set(key, text);
        this.#updateAccessibleName();
      },
    };
  }

  #getAvailableModels() {
    const settings = this.callbacks.getSettings();
    const uiConfig = this.callbacks.getUIConfig();
    return uiConfig.getModelOptions({
      ...settings,
      environmentVariables: this.callbacks.getEnvironmentVariables?.(),
    });
  }

  /** The name carries every value the chip shows, including ones narrow layouts hide. */
  #updateAccessibleName(): void {
    const parts = [this.modelDescription];
    for (const description of this.partDescriptions.values()) {
      if (description) parts.push(description);
    }
    this.menu.buttonEl.setAttribute('aria-label', parts.join(', '));
  }

  updateDisplay() {
    const currentModel = this.callbacks.getSettings().model;
    const models = this.#getAvailableModels();
    const modelInfo = models.find(m => m.value === currentModel);

    const displayModel = modelInfo || models[0];
    const icon = displayModel?.providerIcon
      ?? this.callbacks.getUIConfig().getProviderIcon?.();

    this.iconSlotEl.empty();
    if (icon) {
      createProviderIconSvg(icon, {
        className: 'claudian-model-provider-icon',
        height: 12,
        parent: this.iconSlotEl,
        width: 12,
      });
    }
    const label = modelInfo?.label || (currentModel ? 'Model unavailable' : 'Set up models');
    this.labelEl.setText(label);
    this.modelDescription = modelInfo ? `Model: ${label}` : label;
    this.#updateAccessibleName();
    this.menu.buttonEl.title = modelInfo ? '' : 'Choose an enabled model in provider settings. If discovery failed, refresh the model list.';
  }

  renderOptions() {
    this.optionsEl.empty();

    const currentModel = this.callbacks.getSettings().model;
    const models = this.#getAvailableModels();
    if (!models.length) {
      this.optionsEl.createDiv({
        cls: 'claudian-toolbar-popover-empty',
        text: 'No models available. Check provider settings and refresh the model list if discovery failed.',
        attr: { role: 'status' },
      });
    }

    const listEl = models.length
      ? this.optionsEl.createDiv({ cls: 'claudian-model-list', attr: { role: 'listbox', 'aria-label': 'Model' } })
      : null;
    // Ungrouped models sit directly in the list; each provider group gets a labelled group.
    let groupEl: HTMLElement | null = null;
    let lastGroup: string | undefined;
    const hasSelection = models.some(model => model.value === currentModel);
    for (const [index, model] of models.entries()) {
      if (!listEl) break;
      if (model.group && model.group !== lastGroup) {
        const headingId = nextToolbarId('heading');
        groupEl = listEl.createDiv({
          cls: 'claudian-toolbar-popover-group',
          attr: { role: 'group', 'aria-labelledby': headingId },
        });
        groupEl.createDiv({
          cls: 'claudian-toolbar-popover-heading claudian-model-group',
          text: model.group,
          attr: { id: headingId },
        });
      }
      lastGroup = model.group;

      const selected = model.value === currentModel;
      this.menu.createItem(model.group && groupEl ? groupEl : listEl, {
        role: 'option',
        checked: selected,
        // The list is one tab stop: the selected model, or the first when none is.
        tabbable: hasSelection ? selected : index === 0,
        label: model.label,
        cls: `claudian-model-option${selected ? ' selected' : ''}`,
        title: model.description,
        providerIcon: model.providerIcon ?? this.callbacks.getUIConfig().getProviderIcon?.(),
        providerId: model.providerId,
        showCheck: true,
        onSelect: () => {
          runToolbarAction(async () => {
            await this.callbacks.onModelChange(model.value);
            this.updateDisplay();
            this.renderOptions();
          }, 'Failed to change model');
        },
      });
    }
    this.menu.restoreFocus();
  }
}
