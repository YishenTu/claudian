import { Notice, setIcon } from 'obsidian';

import type { ProviderIconSvg } from '@/core/providers/types';
import { createProviderIconSvg } from '@/shared/icons';

export function runToolbarAction(action: () => Promise<void>, failureMessage: string): void {
  void action().catch(() => {
    new Notice(failureMessage);
  });
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

export function nextToolbarId(prefix: string): string {
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
export class ToolbarMenuGroup implements ToolbarMenus {
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
export class ToolbarMenu {
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
