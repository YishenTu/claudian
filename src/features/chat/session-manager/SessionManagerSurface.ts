import { StartupProfiler } from '@/core/performance/StartupProfiler';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { HistoryDropdown } from '@/features/chat/session-manager/HistoryDropdown';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionSidebar } from '@/features/chat/session-manager/SessionSidebar';
import type { SessionSurfaceNavigation } from '@/features/chat/session-manager/SessionSurfaceShared';
import type { ChatTab } from '@/features/chat/tabs/ChatTab';

export { setControlAvailability } from '@/features/chat/session-manager/SessionSurfaceShared';

export interface SessionManagerSurfaceDeps {
  plugin: ChatFeatureHost;
  navigation: SessionSurfaceNavigation;
  getActiveTab(): ChatTab | null;
  isWide(): boolean;
  /** Whether another tab fits; null while the view has no tabs. */
  canCreateTab(): boolean | null;
  requestNew(): void;
  /** Session presentation settings changed; other views must re-render their lists. */
  notifyOtherViews(): void;
}

/**
 * The view's session manager: the compact history dropdown and the wide
 * session sidebar over one shared session browser. It owns what both share —
 * the browser, the archive view, invalidation, and Escape — and routes the
 * layout's lifecycle to the presentation that is showing.
 */
export class SessionManagerSurface {
  private readonly browser: SessionBrowser;
  private readonly dropdown: HistoryDropdown;
  private readonly sidebar: SessionSidebar;

  /**
   * One archive view serves both presentations: archive chosen in the sidebar
   * is still showing when the dropdown next opens after leaving wide, and vice
   * versa. Leaving it requires the presentation's own Sessions/New control.
   */
  private isArchiveView = false;
  private hasRenderedList = false;

  constructor(private readonly deps: SessionManagerSurfaceDeps) {
    this.browser = new SessionBrowser({
      plugin: deps.plugin,
      getCurrentConversationId: () => deps.getActiveTab()?.conversationId ?? null,
      getTitleGenerationService: () => deps.getActiveTab()?.services.titleGenerationService ?? null,
      onListChanged: () => this.invalidate(),
    });
    const shared = {
      browser: this.browser,
      isArchiveView: () => this.isArchiveView,
      setArchiveView: (isArchiveView: boolean) => this.setArchiveView(isArchiveView),
      invalidate: () => this.invalidate(),
      profileListRender: (render: () => void) => this.profileListRender(render),
    };
    this.dropdown = new HistoryDropdown({
      plugin: deps.plugin,
      navigation: deps.navigation,
      shared,
    });
    this.sidebar = new SessionSidebar({
      plugin: deps.plugin,
      navigation: deps.navigation,
      shared,
      isWide: () => deps.isWide(),
      canCreateTab: () => deps.canCreateTab(),
      requestNew: () => deps.requestNew(),
      notifyOtherViews: () => deps.notifyOtherViews(),
    });
  }

  /** True while session search is composing IME input; Escape belongs to the composition. */
  get isComposing(): boolean {
    return this.sidebar.isComposing;
  }

  /** Builds the dual-pane sidebar surface inside `sidebarEl`. */
  mountSidebar(sidebarEl: HTMLElement): void {
    this.sidebar.mount(sidebarEl);
  }

  /** Builds the single-pane history button and its drop-up menu inside `parentEl`. */
  mountHistoryControl(parentEl: HTMLElement): void {
    this.dropdown.mount(parentEl);
  }

  /** Marks both surfaces stale and re-renders whichever is showing. */
  invalidate(): void {
    this.dropdown.markDirty();
    this.sidebar.markDirty();
    this.dropdown.renderIfVisible();
    if (this.deps.isWide()) this.sidebar.render();
  }

  /** Hides the dropdown for an outside click, keeping its rendered list. */
  dismissDropdown(): void {
    this.dropdown.dismiss();
  }

  /** The wide layout replaces the dropdown with the sidebar. */
  enterWide(): void {
    this.dropdown.close();
  }

  /** Leaving the wide layout ends sidebar search and rendering. */
  leaveWide(): void {
    this.sidebar.leave();
  }

  renderSidebar(): void {
    this.sidebar.render();
  }

  /** Handles Escape for inline rename and search; returns whether it was consumed. */
  handleEscape(): boolean {
    if (this.browser.cancelInlineRename()) return true;
    return this.sidebar.dismissSearch();
  }

  /** Shows New only while another tab can be created. */
  refreshNewAvailability(): void {
    this.sidebar.refreshNewAvailability();
  }

  dispose(): void {
    this.browser.dispose();
    this.sidebar.dispose();
    this.dropdown.dispose();
  }

  /** Switches between active and archived sessions; the switch always ends search. */
  private setArchiveView(isArchiveView: boolean): void {
    if (this.isArchiveView === isArchiveView) return;
    this.sidebar.discardSearch();
    this.isArchiveView = isArchiveView;
    this.dropdown.markDirty();
    this.sidebar.markDirty();
    if (this.deps.isWide()) {
      this.sidebar.render();
    } else {
      this.dropdown.renderIfVisible();
    }
  }

  private profileListRender(render: () => void): void {
    const span = this.hasRenderedList ? null : StartupProfiler.start('history-list-render');
    this.hasRenderedList = true;
    try {
      render();
    } finally {
      if (span) StartupProfiler.finish(span);
    }
  }
}
