import { setIcon } from 'obsidian';

import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { buildProjectsHeaderActions, getProjectSort } from '@/features/chat/session-manager/ProjectsHeaderActions';
import { SessionGroupCollapse } from '@/features/chat/session-manager/SessionGroupCollapse';
import {
  archiveScopeOptions,
  beginInlineRenameNextFrame,
  type SessionSurfaceNavigation,
  type SessionSurfaceShared,
} from '@/features/chat/session-manager/SessionSurfaceShared';

const VIEW_HEIGHT_SHARE = 0.6;

export interface HistoryDropdownDeps {
  plugin: ChatFeatureHost;
  navigation: Pick<SessionSurfaceNavigation, 'getConversationStatus' | 'openConversation' | 'startProjectConversation'>;
  shared: SessionSurfaceShared;
}

/**
 * The compact layout's history button and drop-up session menu: tab-aware open
 * states, open-in-new-tab, close-on-select, in-list archive navigation, and the
 * same projects section as the sidebar.
 */
export class HistoryDropdown {
  private containerEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private renderAbortController: AbortController | null = null;
  private dirty = true;
  private readonly collapse = new SessionGroupCollapse();

  constructor(private readonly deps: HistoryDropdownDeps) {}

  /** Builds the history button and its drop-up menu inside `parentEl`. */
  mount(parentEl: HTMLElement): void {
    const historyContainer = parentEl.createDiv({
      cls: 'claudian-history-container claudian-nav-dropup-container',
    });
    this.containerEl = historyContainer;
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
      this.fitToView(this.menuEl);
      this.menuEl.addClass('visible');
      this.render();
    }
  }

  /** Caps the drop-up at 60% of the chat view's height, measured as it opens. */
  private fitToView(menuEl: HTMLElement): void {
    const viewEl = menuEl.closest<HTMLElement>('.claudian-container');
    const height = viewEl?.clientHeight ?? 0;
    // An unmeasured view keeps the stylesheet's fallback cap.
    menuEl.setCssProps({
      '--claudian-history-menu-max-height': height > 0 ? `${Math.round(height * VIEW_HEIGHT_SHARE)}px` : '',
    });
  }

  /** Hides the menu and abandons its in-flight render. */
  close(): void {
    this.menuEl?.removeClass('visible');
    this.cancelRendering();
  }

  /**
   * Hides the menu for a click outside it, keeping its rendered list. The click's dispatch path decides, since a
   * toggle inside the menu may already be detached by the rerender it caused.
   */
  dismissFor(event: Event): void {
    if (this.containerEl && event.composedPath().includes(this.containerEl)) return;
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
      // The archive lists no projects; its members stay among the archived sessions.
      showProjectsSection: true,
      projectSort: getProjectSort(plugin),
      isGroupCollapsed: groupKey => this.collapse.isCollapsed(groupKey),
      onGroupCollapseChange: (groupKey, collapsed) => this.collapse.setCollapsed(groupKey, collapsed),
      onStartProjectConversation: async (projectId: string) => {
        shared.setArchiveView(false);
        await navigation.startProjectConversation(projectId);
        this.close();
      },
      signal,
    });
    if (!signal.aborted) buildProjectsHeaderActions(container, plugin);
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
