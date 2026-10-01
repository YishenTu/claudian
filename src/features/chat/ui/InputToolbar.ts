import { Notice, setIcon } from 'obsidian';

import { formatReasoningValueLabel } from '../../../core/providers/reasoning';
import type {
  ProviderCapabilities,
  ProviderChatUIConfig,
  ProviderIconSvg,
  ProviderModeSelectorConfig,
  ProviderPermissionModeOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import type { UsageInfo } from '../../../core/types';
import { createProviderIconSvg } from '../../../shared/icons';
import { toggleServiceTier } from '../actions/toggleServiceTier';
import type { ChatSettings } from '../ChatSettings';

function runToolbarAction(action: () => Promise<void>, failureMessage: string): void {
  void action().catch(() => {
    new Notice(failureMessage);
  });
}

export type ToolbarSettings = ChatSettings & Record<string, unknown>;

export interface ToolbarCallbacks {
  onModelChange: (model: string) => Promise<void>;
  onModeChange: (mode: string) => Promise<void>;
  onEffortLevelChange: (effort: string) => Promise<void>;
  onServiceTierChange: (serviceTier: string) => Promise<void>;
  onPermissionModeChange: (mode: string) => Promise<void>;
  getSettings: () => ToolbarSettings;
  getEnvironmentVariables?: () => string;
  getUIConfig: () => ProviderChatUIConfig;
  getCapabilities: () => ProviderCapabilities;
}

const MENU_ITEM_SELECTOR = [
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="switch"]',
  'input[type="range"]',
].join(', ');
const RANGE_SELECTOR = 'input[type="range"]';
/** Keys a focused range input uses to change its own value. */
const RANGE_VALUE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

let toolbarElementSequence = 0;

function nextToolbarId(prefix: string): string {
  return `claudian-toolbar-${prefix}-${++toolbarElementSequence}`;
}

type MenuFocusTarget = 'checked' | 'first' | 'last';

/** The toolbar's menus as one unit: at most one is open, and teardown closes it. */
export interface ToolbarMenus {
  /** Closes the open menu and returns focus to its button; false when none was open. */
  closeOpenMenu(): boolean;
  destroy(): void;
}

/** Keeps at most one toolbar menu open. */
class ToolbarMenuGroup implements ToolbarMenus {
  #openMenu: ToolbarMenu | null = null;

  activate(menu: ToolbarMenu): void {
    if (this.#openMenu && this.#openMenu !== menu) this.#openMenu.close(false);
    this.#openMenu = menu;
  }

  release(menu: ToolbarMenu): void {
    if (this.#openMenu === menu) this.#openMenu = null;
  }

  closeOpenMenu(): boolean {
    const menu = this.#openMenu;
    if (!menu) return false;
    menu.close(true);
    return true;
  }

  destroy(): void {
    this.#openMenu?.close(false);
    this.#openMenu = null;
  }
}

interface ToolbarMenuOptions {
  anchorCls: string;
  /** A menu holds only menu items; a dialog also holds other controls, such as a slider. */
  popupRole?: 'menu' | 'dialog';
  buttonCls?: string;
  menuLabel: string;
  closeOnSelect: boolean;
  group?: ToolbarMenuGroup;
  /** Rereads settings into the button and menu before the menu shows. */
  onOpen: () => void;
}

interface ToolbarMenuItemOptions {
  role: 'menuitemradio' | 'menuitemcheckbox' | 'option' | 'switch';
  /** Options report aria-selected; the other roles report aria-checked. */
  checked: boolean;
  /** Dialog controls take one tab stop each; menu items are reached with arrow keys only. */
  tabbable?: boolean;
  label: string;
  cls?: string;
  detail?: string;
  title?: string;
  providerIcon?: ProviderIconSvg | null;
  /** Names the option's provider for per-provider brand styling. */
  providerId?: string;
  leadingIcon?: string;
  showCheck?: boolean;
  onSelect: () => void;
}

/** A native chip button whose menu opens on click or from the keyboard. */
class ToolbarMenu {
  readonly anchorEl: HTMLElement;
  readonly buttonEl: HTMLButtonElement;
  readonly menuEl: HTMLElement;
  readonly #chevronEl: HTMLElement;
  readonly #options: ToolbarMenuOptions;
  readonly #popupRole: 'menu' | 'dialog';
  #lastFocusedKey: string | null = null;
  #keyTarget: Window | null = null;

  constructor(parentEl: HTMLElement, options: ToolbarMenuOptions) {
    this.#options = options;
    this.#popupRole = options.popupRole ?? 'menu';
    const menuId = nextToolbarId('menu');
    this.anchorEl = parentEl.createDiv({ cls: `claudian-toolbar-chip-anchor ${options.anchorCls}` });
    this.buttonEl = this.anchorEl.createEl('button', {
      cls: `claudian-toolbar-chip${options.buttonCls ? ` ${options.buttonCls}` : ''}`,
      attr: {
        type: 'button',
        'aria-haspopup': this.#popupRole,
        'aria-expanded': 'false',
        'aria-controls': menuId,
      },
    });
    this.#chevronEl = this.buttonEl.createSpan({ cls: 'claudian-toolbar-chip-chevron' });
    setIcon(this.#chevronEl, 'chevron-down');
    this.menuEl = this.anchorEl.createDiv({
      cls: 'claudian-toolbar-popover',
      attr: { id: menuId, role: this.#popupRole, 'aria-label': options.menuLabel, tabindex: '-1' },
    });
    this.menuEl.hidden = true;

    this.buttonEl.addEventListener('click', this.#onButtonClick);
    this.buttonEl.addEventListener('keydown', this.#onButtonKeydown);
    this.menuEl.addEventListener('keydown', this.#onMenuKeydown);
    this.menuEl.addEventListener('focusin', this.#onMenuFocusIn);
    this.anchorEl.addEventListener('focusout', this.#onAnchorFocusOut);
  }

  get isOpen(): boolean {
    return !this.menuEl.hidden;
  }

  /** Adds button content ahead of the chevron. */
  createChipPart(cls: string): HTMLElement {
    const partEl = this.buttonEl.createSpan({ cls });
    this.buttonEl.appendChild(this.#chevronEl);
    return partEl;
  }

  createItem(parentEl: HTMLElement, options: ToolbarMenuItemOptions): HTMLButtonElement {
    const itemEl = parentEl.createEl('button', {
      cls: `claudian-toolbar-popover-option${options.cls ? ` ${options.cls}` : ''}`,
      attr: {
        type: 'button',
        role: options.role,
        [options.role === 'option' ? 'aria-selected' : 'aria-checked']: String(options.checked),
        tabindex: options.tabbable ? '0' : '-1',
        'data-menu-key': `${options.role}:${options.label}`,
      },
    });
    if (options.providerId) itemEl.dataset.provider = options.providerId;
    if (options.providerIcon) {
      createProviderIconSvg(options.providerIcon, {
        className: 'claudian-model-provider-icon',
        height: 12,
        parent: itemEl,
        width: 12,
      });
    }
    if (options.leadingIcon) {
      setIcon(itemEl.createSpan({ cls: 'claudian-toolbar-popover-option-icon' }), options.leadingIcon);
    }
    // Labels stay direct children of the item unless a detail line needs a stacked copy block.
    const copyEl = options.detail
      ? itemEl.createSpan({ cls: 'claudian-toolbar-popover-option-copy' })
      : itemEl;
    copyEl.createSpan({ cls: 'claudian-toolbar-popover-option-label', text: options.label });
    if (options.detail) {
      copyEl.createSpan({ cls: 'claudian-toolbar-popover-option-detail', text: options.detail });
    }
    if (options.title) itemEl.setAttribute('title', options.title);
    if (options.showCheck && options.checked) {
      setIcon(itemEl.createSpan({ cls: 'claudian-toolbar-popover-option-check' }), 'check');
    }
    itemEl.addEventListener('click', () => {
      if (this.#options.closeOnSelect) this.close(true);
      options.onSelect();
    });
    return itemEl;
  }

  open(focus: MenuFocusTarget = 'checked'): void {
    if (!this.isOpen) {
      this.#options.group?.activate(this);
      this.#options.onOpen();
      if (this.anchorEl.classList.contains('claudian-hidden')) {
        this.#options.group?.release(this);
        return;
      }
      this.menuEl.hidden = false;
      this.buttonEl.setAttribute('aria-expanded', 'true');
      this.anchorEl.ownerDocument.addEventListener('pointerdown', this.#onDocumentPointerDown, true);
      // Window capture runs ahead of Obsidian's keymap, whose view scope cancels a running turn on Escape.
      this.#keyTarget = this.anchorEl.ownerDocument.defaultView;
      this.#keyTarget?.addEventListener('keydown', this.#onWindowKeydown, true);
    }
    this.#focusItem(focus);
  }

  close(restoreFocus: boolean): void {
    if (!this.isOpen) return;
    this.menuEl.hidden = true;
    this.buttonEl.setAttribute('aria-expanded', 'false');
    this.anchorEl.ownerDocument.removeEventListener('pointerdown', this.#onDocumentPointerDown, true);
    this.#keyTarget?.removeEventListener('keydown', this.#onWindowKeydown, true);
    this.#keyTarget = null;
    this.#options.group?.release(this);
    this.#lastFocusedKey = null;
    if (restoreFocus) this.buttonEl.focus();
  }

  /** Returns keyboard focus to the same choice after the open menu's items are rebuilt. */
  restoreFocus(): void {
    if (!this.isOpen) return;
    const ownerDocument = this.anchorEl.ownerDocument;
    const activeEl = ownerDocument.activeElement;
    if (activeEl && activeEl !== ownerDocument.body && activeEl.isConnected) return;
    const sameItem = this.#items().find(item => item.dataset.menuKey === this.#lastFocusedKey);
    if (sameItem) {
      sameItem.focus();
      return;
    }
    this.#focusItem('checked');
  }

  #items(scopeEl: Element = this.menuEl): HTMLElement[] {
    return Array.from(scopeEl.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR))
      .filter(item => !(item as HTMLButtonElement).disabled && !item.closest('.claudian-hidden'));
  }

  #focusItem(target: MenuFocusTarget): void {
    const items = this.#items();
    // The current choice: a selected option, or a checked menu item (a switch is a setting, not a choice).
    const checked = target === 'checked'
      ? items.find(item => item.getAttribute('aria-selected') === 'true'
        || (item.getAttribute('role')?.startsWith('menuitem') && item.getAttribute('aria-checked') === 'true'))
      : undefined;
    const item = target === 'last' ? items[items.length - 1] : checked ?? items[0];
    (item ?? this.menuEl).focus();
  }

  /** Up and Down step through every control; a focused slider keeps its own value keys. */
  #moveFocus(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement;
    if (target.matches(RANGE_SELECTOR) && RANGE_VALUE_KEYS.has(event.key)) return false;
    const items = this.#items();
    const current = items.indexOf(target);
    if (current < 0) return false;

    switch (event.key) {
      case 'ArrowDown':
        items[(current + 1) % items.length].focus();
        return true;
      case 'ArrowUp':
        items[(current - 1 + items.length) % items.length].focus();
        return true;
      case 'Home':
      case 'End': {
        // In the model list these jump within the list, not to the popover's other controls.
        const scoped = this.#items(target.closest('[role="listbox"]') ?? this.menuEl);
        scoped[event.key === 'Home' ? 0 : scoped.length - 1].focus();
        return true;
      }
      default:
        return false;
    }
  }

  readonly #onButtonClick = (): void => {
    if (this.isOpen) {
      this.close(true);
      return;
    }
    this.open('checked');
  };

  readonly #onButtonKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    this.open(event.key === 'ArrowUp' ? 'last' : 'checked');
  };

  readonly #onMenuKeydown = (event: KeyboardEvent): void => {
    // A dialog's controls are separate tab stops, so Tab only closes a menu.
    if (event.key === 'Tab' && this.#popupRole === 'menu') {
      // Tab continues from the button, so focus moves on to the neighbouring control.
      this.buttonEl.focus();
      this.close(false);
      return;
    }
    if (this.#moveFocus(event)) event.preventDefault();
  };

  readonly #onMenuFocusIn = (event: FocusEvent): void => {
    const key = (event.target as HTMLElement | null)?.dataset?.menuKey;
    if (key) this.#lastFocusedKey = key;
  };

  readonly #onWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.isOpen) return;
    event.preventDefault();
    event.stopPropagation();
    this.close(true);
  };

  readonly #onAnchorFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && !this.anchorEl.contains(next)) this.close(false);
  };

  readonly #onDocumentPointerDown = (event: Event): void => {
    if (!this.anchorEl.contains(event.target as Node | null)) this.close(false);
  };
}

/** A section of the model menu plus a matching detail on the model button. */
interface ModelMenuPart {
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

export class ContextUsageMeter {
  private container: HTMLElement;
  private fillPath: SVGPathElement | null = null;
  private percentEl: HTMLElement | null = null;
  private circumference: number = 0;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-context-meter' });
    this.container.setAttribute('role', 'progressbar');
    this.container.setAttribute('aria-label', 'Context usage');
    this.container.setAttribute('aria-valuemin', '0');
    this.container.setAttribute('aria-valuemax', '100');
    this.render();
    // Initially hidden
    this.container.addClass('claudian-hidden');
  }

  setVisible(visible: boolean): void {
    this.container.toggleClass('claudian-hidden', !visible);
  }

  private render() {
    const size = 16;
    const strokeWidth = 2;
    const radius = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;

    // 240° arc: from 150° to 390° (upper-left through bottom to upper-right)
    const startAngle = 150;
    const endAngle = 390;
    const arcDegrees = endAngle - startAngle;
    const arcRadians = (arcDegrees * Math.PI) / 180;
    this.circumference = radius * arcRadians;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(startRad);
    const y1 = cy + radius * Math.sin(startRad);
    const x2 = cx + radius * Math.cos(endRad);
    const y2 = cy + radius * Math.sin(endRad);

    const gaugeEl = this.container.createDiv({ cls: 'claudian-context-meter-gauge' });
    const svg = gaugeEl.createSvg('svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

    const pathData = `M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}`;
    const backgroundPath = svg.createSvg('path');
    backgroundPath.classList.add('claudian-meter-bg');
    backgroundPath.setAttribute('d', pathData);
    backgroundPath.setAttribute('fill', 'none');
    backgroundPath.setAttribute('stroke-width', String(strokeWidth));
    backgroundPath.setAttribute('stroke-linecap', 'round');

    const fillPath = svg.createSvg('path');
    fillPath.classList.add('claudian-meter-fill');
    fillPath.setAttribute('d', pathData);
    fillPath.setAttribute('fill', 'none');
    fillPath.setAttribute('stroke-width', String(strokeWidth));
    fillPath.setAttribute('stroke-linecap', 'round');
    fillPath.setAttribute('stroke-dasharray', String(this.circumference));
    fillPath.setAttribute('stroke-dashoffset', String(this.circumference));

    svg.appendChild(backgroundPath);
    svg.appendChild(fillPath);
    gaugeEl.appendChild(svg);
    this.fillPath = fillPath;

    this.percentEl = this.container.createSpan({ cls: 'claudian-context-meter-percent' });
  }

  update(usage: UsageInfo | null): void {
    if (!usage || usage.contextTokens <= 0) {
      this.container.addClass('claudian-hidden');
      return;
    }
    this.container.removeClass('claudian-hidden');
    const fillLength = (usage.percentage / 100) * this.circumference;
    if (this.fillPath) {
      this.fillPath.setAttribute('stroke-dashoffset', String(this.circumference - fillLength));
    }

    if (this.percentEl) {
      this.percentEl.setText(`${usage.percentage}%`);
    }

    this.container.toggleClass('warning', usage.percentage > 80);

    // Set tooltip with detailed usage
    const usageText = `${this.#formatTokens(usage.contextTokens)} / ${this.#formatTokens(usage.contextWindow)}`;
    // The percentage leads because zen shows the gauge without its number.
    let tooltip = `${usage.percentage}% · ${usageText}`;
    if (usage.percentage > 80) {
      tooltip += ' (Approaching limit, run `/compact` to continue)';
    }
    this.container.setAttribute('aria-label', `Context usage: ${tooltip}`);
    this.container.setAttribute('aria-valuenow', String(usage.percentage));
    this.container.setAttribute('aria-valuetext', usageText);
  }

  #formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}

export function createInputToolbar(
  parentEl: HTMLElement,
  callbacks: ToolbarCallbacks,
): {
  modelSelector: ModelSelector;
  modeSelector: ModeSelector;
  effortSelector: EffortSelector;
  contextUsageMeter: ContextUsageMeter;
  menus: ToolbarMenus;
  permissionToggle: PermissionToggle;
  serviceTierToggle: ServiceTierToggle;
} {
  const menuGroup = new ToolbarMenuGroup();
  const modelSelector = new ModelSelector(parentEl, callbacks, menuGroup);
  // The read-only context gauge sits right after the model picker.
  const contextUsageMeter = new ContextUsageMeter(parentEl);
  const effortSelector = new EffortSelector(modelSelector, callbacks);
  const serviceTierToggle = new ServiceTierToggle(modelSelector, callbacks);
  const modeSelector = new ModeSelector(parentEl, callbacks, menuGroup);
  // Permission is the last control; CSS pushes it to the toolbar's far end.
  const permissionToggle = new PermissionToggle(parentEl, callbacks, menuGroup);

  return {
    modelSelector,
    modeSelector,
    effortSelector,
    serviceTierToggle,
    contextUsageMeter,
    menus: menuGroup,
    permissionToggle,
  };
}
