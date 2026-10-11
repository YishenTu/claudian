import { setIcon } from 'obsidian';

import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import {
  archiveScopeOptions,
  beginInlineRenameNextFrame,
  type SessionSurfaceNavigation,
  type SessionSurfaceShared,
} from '@/features/chat/session-manager/SessionSurfaceShared';

export interface HistoryDropdownDeps {
  plugin: ChatFeatureHost;
  navigation: Pick<SessionSurfaceNavigation, 'getConversationStatus' | 'openConversation'>;
  shared: SessionSurfaceShared;
}

/**
 * The compact layout's history button and drop-up session menu: tab-aware open
 * states, open-in-new-tab, close-on-select, and in-list archive navigation.
 */
export class HistoryDropdown {
  private menuEl: HTMLElement | null = null;
  private renderAbortController: AbortController | null = null;
  private dirty = true;

  constructor(private readonly deps: HistoryDropdownDeps) {}

  /** Builds the history button and its drop-up menu inside `parentEl`. */
  mount(parentEl: HTMLElement): void {
    const historyContainer = parentEl.createDiv({
      cls: 'claudian-history-container claudian-nav-dropup-container',
    });
    const historyBtn = historyContainer.createEl('button', {
      cls: 'claudian-input-nav-btn',
      attr: { type: 'button' },
    });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');

    this.menuEl = historyContainer.createDiv({
      cls: 'claudian-history-menu claudian-nav-dropup-menu',
    });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Renders a stale list only while the menu is open; a hidden menu renders when opened. */
  renderIfVisible(): void {
    if (this.menuEl?.hasClass('visible')) this.render();
  }

  toggle(): void {
    if (!this.menuEl) return;

    if (this.menuEl.hasClass('visible')) {
      this.close();
    } else {
      this.menuEl.addClass('visible');
      this.render();
    }
  }

  /** Hides the menu and abandons its in-flight render. */
  close(): void {
    this.menuEl?.removeClass('visible');
    this.cancelRendering();
  }

  /** Hides the menu for an outside click, keeping its rendered list. */
  dismiss(): void {
    this.menuEl?.removeClass('visible');
  }

  dispose(): void {
    this.cancelRendering();
  }

  private render(): void {
    const menuEl = this.menuEl;
    if (!menuEl || !this.dirty) return;

    this.cancelRendering();
    const abortController = new AbortController();
    this.renderAbortController = abortController;

    this.deps.shared.profileListRender(() => {
      this.renderList(menuEl, abortController.signal);
      this.dirty = false;
    });
  }

  private renderList(container: HTMLElement, signal: AbortSignal): void {
    const { navigation, plugin, shared } = this.deps;
    const isArchiveView = shared.isArchiveView();
    shared.browser.renderHistoryDropdown(container, {
      onSelectConversation: (id) => this.openConversation(id),
      // Archived sessions cannot be opened, so only active rows offer a new tab.
      ...(isArchiveView
        ? {}
        : {
            onOpenConversationInNewTab: (id: string, activate = true) =>
              this.openConversation(id, { preferNewTab: true, activate }),
          }),
      getConversationStatus: (id) => navigation.getConversationStatus(id),
      onRerender: () => shared.invalidate(),
      showOpenStateLabels: true,
      showOpenStateActions: !isArchiveView,
      preserveListState: true,
      showInlinePinAction: false,
      onRequestInlineRename: (request) => beginInlineRenameNextFrame(container, request, {
        isCurrent: () => !signal.aborted && this.menuEl === container,
        // Rename can start from a context menu after an outside click hid the menu.
        reveal: () => container.addClass('visible'),
      }),
      ...archiveScopeOptions(isArchiveView),
      onAssignConversationToDevice: async (id: string) => {
        await plugin.assignConversationToCurrentDevice(id);
      },
      onBeforeRestoreListState: (target: HTMLElement) => this.buildArchiveNavigation(target),
      signal,
    });
  }

  private async openConversation(
    conversationId: string,
    options?: { preferNewTab: true; activate: boolean },
  ): Promise<void> {
    await this.deps.navigation.openConversation(conversationId, options);
    this.close();
  }

  private buildArchiveNavigation(container: HTMLElement): void {
    const list = container.querySelector<HTMLElement>('.claudian-history-list');
    if (!list) return;

    const { shared } = this.deps;
    const isArchiveView = shared.isArchiveView();
    const label = isArchiveView ? 'Sessions' : 'Archive';
    const control = list.createDiv({ cls: 'claudian-history-archive-control' });
    control.setAttribute('role', 'button');
    control.setAttribute('tabindex', '0');
    control.setAttribute('aria-label', label);
    const icon = control.createSpan({ cls: 'claudian-session-nav-icon' });
    setIcon(icon, isArchiveView ? 'arrow-left' : 'archive');
    control.createSpan({ cls: 'claudian-session-nav-label', text: label });
    const toggleArchiveView = (): void => shared.setArchiveView(!shared.isArchiveView());
    control.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleArchiveView();
    });
    control.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggleArchiveView();
    });
    list.insertBefore(control, list.firstChild);
  }

  private cancelRendering(): void {
    this.renderAbortController?.abort();
    this.renderAbortController = null;
    this.dirty = true;
  }
}
