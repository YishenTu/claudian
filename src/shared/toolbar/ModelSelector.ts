import type { ProviderUIOption } from '@/core/providers/types';
import { createProviderIconSvg } from '@/shared/icons';
import { nextToolbarId, runToolbarAction, ToolbarMenu, type ToolbarMenuGroup } from '@/shared/toolbar/ToolbarMenu';
import type { ModelPickerCallbacks } from '@/shared/toolbar/types';

/** A section of the model menu plus a matching detail on the model button. */
export interface ModelMenuPart {
  readonly chipEl: HTMLElement;
  readonly sectionEl: HTMLElement;
  readonly menu: ToolbarMenu;
  /** Sets this part's phrase in the model button's accessible name; null omits it. */
  describe(text: string | null): void;
  /** False while the menu browses another provider's models, so no current-model setting shows as chosen. */
  showsCurrentModel(): boolean;
}

/**
 * Model button: model, reasoning and fast mode on one chip, with one menu for all three.
 * The menu lays its columns side by side: providers (only while a new session can still pick one),
 * models, then the attached parts.
 */
export class ModelSelector {
  private readonly menu: ToolbarMenu;
  private readonly iconSlotEl: HTMLElement;
  private readonly labelEl: HTMLElement;
  private readonly providersEl: HTMLElement;
  private readonly optionsEl: HTMLElement;
  private readonly partsEl: HTMLElement;
  private readonly listId = nextToolbarId('model-list');
  private readonly partRefreshers: Array<() => void> = [];
  private readonly partDescriptions = new Map<string, string | null>();
  private modelDescription = '';
  /** The provider whose models the list shows; it changes no setting until a model is picked. */
  #browsedProviderId: string | null = null;
  /** Whether the list shows the current model's provider; the parts apply to that model only. */
  #showsCurrentModel = true;
  private callbacks: ModelPickerCallbacks;

  constructor(
    parentEl: HTMLElement,
    callbacks: ModelPickerCallbacks,
    menuGroup?: ToolbarMenuGroup,
    /** See `ToolbarMenu`'s `floatingLayer`. */
    floatingLayer?: HTMLElement,
  ) {
    this.callbacks = callbacks;
    this.menu = new ToolbarMenu(parentEl, {
      anchorCls: 'claudian-toolbar-chip-anchor--model claudian-model-selector',
      buttonCls: 'claudian-model-btn',
      menuLabel: 'Model options',
      popupRole: 'dialog',
      closeOnSelect: false,
      group: menuGroup,
      floatingLayer,
      onOpen: () => {
        this.#browsedProviderId = null;
        this.updateDisplay();
        this.renderOptions();
        for (const refresh of this.partRefreshers) refresh();
      },
    });
    this.menu.menuEl.addClass('claudian-model-popover');
    this.iconSlotEl = this.menu.createChipPart('claudian-toolbar-chip-icon');
    this.labelEl = this.menu.createChipPart('claudian-toolbar-chip-primary claudian-model-label');
    this.providersEl = this.menu.menuEl.createDiv({
      cls: 'claudian-model-column claudian-model-providers',
      attr: { role: 'tablist', 'aria-label': 'Provider', 'aria-orientation': 'vertical' },
    });
    this.optionsEl = this.menu.menuEl.createDiv({
      cls: 'claudian-model-column claudian-model-options',
    });
    this.partsEl = this.menu.menuEl.createDiv({ cls: 'claudian-model-column claudian-model-parts' });
    this.updateDisplay();
    this.renderOptions();
  }

  /** Lets the reasoning and service-tier controls share this button and menu. */
  attachPart(key: string, chipCls: string, refresh: () => void): ModelMenuPart {
    this.partRefreshers.push(refresh);
    this.partDescriptions.set(key, null);
    return {
      chipEl: this.menu.createChipPart(chipCls),
      sectionEl: this.partsEl.createDiv({ cls: 'claudian-toolbar-popover-section' }),
      menu: this.menu,
      describe: (text) => {
        this.partDescriptions.set(key, text);
        this.#updateAccessibleName();
      },
      showsCurrentModel: () => this.#showsCurrentModel,
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
    const currentModel = this.callbacks.getSettings().model;
    const allModels = this.#getAvailableModels();
    // Only a new session's models name their provider; a started session keeps the one it has.
    const providers = new Map<string, ProviderUIOption>();
    for (const model of allModels) {
      if (model.providerId && !providers.has(model.providerId)) providers.set(model.providerId, model);
    }
    const currentProviderId = allModels.find(model => model.value === currentModel)?.providerId;
    if (!this.#browsedProviderId || !providers.has(this.#browsedProviderId)) {
      this.#browsedProviderId = currentProviderId ?? providers.keys().next().value ?? null;
    }
    this.#renderProviders(providers);
    this.#setShowsCurrentModel(!providers.size || this.#browsedProviderId === currentProviderId);
    const models = providers.size
      ? allModels.filter(model => model.providerId === this.#browsedProviderId)
      : allModels;

    this.optionsEl.empty();
    const headingId = nextToolbarId('heading');
    this.optionsEl.createDiv({ cls: 'claudian-toolbar-popover-heading', text: 'Model', attr: { id: headingId } });
    if (!models.length) {
      this.optionsEl.createDiv({
        cls: 'claudian-toolbar-popover-empty',
        text: 'No models available. Check provider settings and refresh the model list if discovery failed.',
        attr: { role: 'status' },
      });
    }

    const listEl = models.length
      ? this.optionsEl.createDiv({
        cls: 'claudian-model-list',
        attr: { id: this.listId, role: 'listbox', 'aria-labelledby': headingId },
      })
      : null;
    // Ungrouped models sit directly in the list; each upstream group gets a labelled group.
    let groupEl: HTMLElement | null = null;
    let lastGroup: string | undefined;
    const hasSelection = models.some(model => model.value === currentModel);
    for (const [index, model] of models.entries()) {
      if (!listEl) break;
      if (model.group && model.group !== lastGroup) {
        const groupHeadingId = nextToolbarId('heading');
        groupEl = listEl.createDiv({
          cls: 'claudian-toolbar-popover-group',
          attr: { role: 'group', 'aria-labelledby': groupHeadingId },
        });
        groupEl.createDiv({
          cls: 'claudian-toolbar-popover-heading claudian-model-group',
          text: model.group,
          attr: { id: groupHeadingId },
        });
      }
      lastGroup = model.group;

      const selected = model.value === currentModel;
      const itemEl = this.menu.createItem(model.group && groupEl ? groupEl : listEl, {
        role: 'option',
        key: `model:${model.value}`,
        checked: selected,
        // The list is one tab stop: the selected model, or the first when none is.
        tabbable: hasSelection ? selected : index === 0,
        label: model.label,
        detail: model.description,
        cls: 'claudian-model-option',
        title: model.description,
        showCheck: true,
        onSelect: () => {
          runToolbarAction(async () => {
            await this.callbacks.onModelChange(model.value);
            this.updateDisplay();
            this.renderOptions();
          }, 'Failed to change model');
        },
      });
      // The model's name is the option's name; its title already carries the description.
      itemEl.querySelector('.claudian-toolbar-popover-option-detail')?.setAttribute('aria-hidden', 'true');
    }
    this.menu.restoreFocus();
  }

  /**
   * While another provider is browsed, the parts show no current-model setting as chosen and
   * cannot change it, since they apply to the model in use.
   */
  #setShowsCurrentModel(shows: boolean): void {
    if (shows) this.partsEl.removeAttribute('inert');
    else this.partsEl.setAttribute('inert', '');
    this.partsEl.toggleClass('claudian-model-parts--inert', !shows);
    if (shows === this.#showsCurrentModel) return;
    this.#showsCurrentModel = shows;
    for (const refresh of this.partRefreshers) refresh();
  }

  /** One icon tab per provider, each named by its provider's display name. */
  #renderProviders(providers: ReadonlyMap<string, ProviderUIOption>): void {
    this.providersEl.empty();
    this.providersEl.toggleClass('claudian-hidden', providers.size === 0);
    for (const [providerId, model] of providers) {
      const selected = providerId === this.#browsedProviderId;
      const name = model.providerLabel ?? providerId;
      const tabEl = this.menu.createItem(this.providersEl, {
        role: 'tab',
        key: `provider:${providerId}`,
        checked: selected,
        tabbable: selected,
        label: name,
        cls: 'claudian-model-provider-tab',
        title: name,
        onSelect: () => {
          if (this.#browsedProviderId === providerId) return;
          this.#browsedProviderId = providerId;
          this.renderOptions();
        },
      });
      // The tab shows only its icon; the provider's name stays its accessible name.
      tabEl.empty();
      tabEl.setAttribute('aria-label', name);
      tabEl.setAttribute('aria-controls', this.listId);
      tabEl.dataset.provider = providerId;
      const iconEl = tabEl.createSpan({ cls: 'claudian-model-provider-tile' });
      const icon = model.providerIcon ?? this.callbacks.getUIConfig().getProviderIcon?.();
      if (icon) {
        createProviderIconSvg(icon, {
          className: 'claudian-model-provider-icon',
          height: 13,
          parent: iconEl,
          width: 13,
        });
      }
    }
  }
}
