import { type Menu, Notice, setIcon } from 'obsidian';

import type { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import { scheduleAnimationFrame } from '@/features/chat/utils/animationFrame';

/** The session-opening policy the session manager presentations delegate to. */
export interface SessionSurfaceNavigation {
  getConversationStatus(conversationId: string): HistoryConversationStatus;
  openConversation(
    conversationId: string,
    options?: { preferNewTab: true; activate: boolean },
  ): Promise<void>;
  openSessionConversation(conversationId: string): Promise<void>;
  startLinkedContentConversation(contentPath: string): Promise<void>;
  /** Starts a draft that joins the project when it becomes a session. */
  startProjectConversation(projectId: string): Promise<void>;
  contentExists(contentPath: string): boolean;
}

/**
 * What the history dropdown and the session sidebar share: one session browser
 * (selection, inline rename, metadata popover), the archive view, coalesced
 * invalidation, and first-render profiling. `SessionManagerSurface` owns it.
 */
export interface SessionSurfaceShared {
  readonly browser: SessionBrowser;
  isArchiveView(): boolean;
  /** Switches both presentations between active and archived sessions. */
  setArchiveView(isArchiveView: boolean): void;
  /** Marks both presentations stale and re-renders whichever is showing. */
  invalidate(): void;
  /** Runs a list render, profiling it when it is the first in either presentation. */
  profileListRender(render: () => void): void;
}

export interface InlineRenameRequest {
  beginRename: (item: HTMLElement) => void;
  conversationId: string;
}

/** Runs a session or project action, reporting any failure once as a notice. */
export function runSessionAction(action: () => unknown, failureMessage: string): void {
  void (async () => {
    try {
      await action();
    } catch {
      new Notice(failureMessage);
    }
  })();
}

/**
 * Opens a menu at the pointer, or under `anchorEl` for keyboard use, in the window that shows the anchor so a
 * popped-out view's menu stays there. A keyboard-chosen menu item's target is the closing menu, so the anchor is
 * the element the follow-up acts on.
 */
export function showMenuAt(menu: Menu, anchorEl: HTMLElement, event?: MouseEvent | KeyboardEvent): void {
  if (event && 'clientX' in event) {
    menu.showAtMouseEvent(event);
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchorEl.ownerDocument);
}

/** A section header's icon button; keyboard activation passes no event, so its menu opens under the button. */
export function createSessionHeaderAction(
  parent: HTMLElement,
  icon: string | ((container: HTMLElement) => void),
  label: string,
  action: (event?: MouseEvent) => void,
): HTMLElement {
  const control = createSessionHeaderButton(parent, icon, label);
  // Keyboard activation clicks with zero coordinates; anchor its menu to the button instead.
  control.addEventListener('click', (event) => action(event.detail === 0 ? undefined : event));
  return control;
}

/** A section header's icon button that opens the menu `show` returns, and closes it when pressed again. */
export function createSessionHeaderMenuAction(
  parent: HTMLElement,
  icon: string,
  label: string,
  show: (anchorEl: HTMLElement, event?: MouseEvent) => Menu,
): HTMLElement {
  const control = createSessionHeaderButton(parent, icon, label);
  control.setAttribute('aria-haspopup', 'menu');
  bindMenuToggle(control, event => show(control, event));
  return control;
}

function createSessionHeaderButton(
  parent: HTMLElement,
  icon: string | ((container: HTMLElement) => void),
  label: string,
): HTMLElement {
  const control = parent.createEl('button', {
    cls: 'claudian-session-header-btn',
    attr: { type: 'button', 'aria-label': label },
  });
  const iconEl = control.createDiv({ cls: 'claudian-session-header-icon' });
  if (typeof icon === 'string') {
    setIcon(iconEl, icon);
  } else {
    icon(iconEl);
  }
  return control;
}

/**
 * Makes `button` open the menu `show` returns and close it when pressed while that menu is open. Obsidian hides
 * an open menu on any press outside it before the click arrives, so the press that hid this button's menu does
 * not reopen it. Keyboard activation passes no event, so the menu opens under the button.
 */
export function bindMenuToggle(button: HTMLElement, show: (event?: MouseEvent) => Menu): void {
  let open: Menu | null = null;
  // The press on this button that hid its open menu; the click that ends it must not reopen the menu.
  let closingPress: Event | null = null;
  button.addEventListener('pointerdown', (event) => {
    if (event !== closingPress) closingPress = null;
  });
  button.addEventListener('click', (event) => {
    if (closingPress) {
      closingPress = null;
      return;
    }
    if (open) {
      open.hide();
      closingPress = null;
      return;
    }
    const menu = show(event.detail === 0 ? undefined : event);
    open = menu;
    button.setAttribute('aria-expanded', 'true');
    const win = button.ownerDocument.defaultView ?? window;
    let press: Event | null = null;
    // A window capture listener sees the press before Obsidian's own handlers hide the menu for it.
    const watchPress = (pressEvent: Event): void => {
      press = button.contains(pressEvent.target as Node) ? pressEvent : null;
    };
    win.addEventListener('pointerdown', watchPress, true);
    menu.onHide(() => {
      win.removeEventListener('pointerdown', watchPress, true);
      if (open !== menu) return;
      open = null;
      closingPress = press;
      button.removeAttribute('aria-expanded');
    });
  });
}

/** Shows or hides a New control while keeping it out of the accessibility tree when hidden. */
export function setControlAvailability(button: HTMLElement | null, isAvailable: boolean): void {
  if (!button) return;

  button.toggleClass('claudian-hidden', !isAvailable);
  if (isAvailable) {
    button.removeAttribute('aria-disabled');
    button.removeAttribute('aria-hidden');
    return;
  }

  button.setAttribute('aria-disabled', 'true');
  button.setAttribute('aria-hidden', 'true');
}

/** List options that follow the archive view in both presentations. */
export function archiveScopeOptions(isArchiveView: boolean) {
  return {
    sessionScope: isArchiveView ? 'archived' : 'active',
    sessionActionMode: isArchiveView ? 'archived' : 'active',
    historyHeaderLabel: isArchiveView ? 'Archived' : 'Sessions',
    allowConversationSelection: !isArchiveView,
  } as const;
}

/**
 * Begins inline rename on the next frame, after the re-render the request
 * triggered, against the row that render produced for the conversation.
 */
export function beginInlineRenameNextFrame(
  container: HTMLElement,
  { beginRename, conversationId }: InlineRenameRequest,
  options: { isCurrent?: () => boolean; reveal?: () => void } = {},
): void {
  scheduleAnimationFrame(() => {
    if (options.isCurrent && !options.isCurrent()) return;
    const targetItem = Array.from(
      container.querySelectorAll<HTMLElement>('.claudian-history-item'),
    ).find(item => item.getAttribute('data-conversation-id') === conversationId);
    if (!targetItem) return;

    options.reveal?.();
    beginRename(targetItem);
  }, container.ownerDocument.defaultView);
}
