/**
 * Claudian - Sidebar chat view
 *
 * Thin shell that coordinates TabManager for multi-tab support.
 * All per-conversation state is managed by individual tabs.
 */

import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice, setIcon } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { LOGO_SVG } from './constants';
import { TabBar, TabManager } from './tabs';
import type { TabData, TabId } from './tabs/types';

/** Main sidebar chat view for interacting with Claude. */
export class ClaudianView extends ItemView {
  private plugin: ClaudianPlugin;

  // Tab management
  private tabManager: TabManager | null = null;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private navRowContent: HTMLElement | null = null;

  // DOM Elements
  private viewContainerEl: HTMLElement | null = null;

  // Header elements
  private historyDropdown: HTMLElement | null = null;

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: number | null = null;

  // Debouncing for tab state persistence
  private pendingPersist: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN;
  }

  getDisplayText(): string {
    return 'Claudian';
  }

  getIcon(): string {
    return 'bot';
  }

  /** Refreshes the model selector display (used after env var changes). */
  refreshModelSelector(): void {
    const activeTab = this.tabManager?.getActiveTab();
    activeTab?.ui.modelSelector?.updateDisplay();
    activeTab?.ui.modelSelector?.renderOptions();
  }

  async onOpen() {
    this.viewContainerEl = this.containerEl.children[1] as HTMLElement;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('claudian-container');

    // Build header (logo only, tab bar and actions moved to nav row)
    const header = this.viewContainerEl.createDiv({ cls: 'claudian-header' });
    this.buildHeader(header);

    // Build nav row content (tab badges + header actions)
    this.navRowContent = this.buildNavRowContent();

    // Tab content container (TabManager will populate this)
    this.tabContentEl = this.viewContainerEl.createDiv({ cls: 'claudian-tab-content-container' });

    // Initialize TabManager
    this.tabManager = new TabManager(
      this.plugin,
      this.plugin.mcpService.getManager(),
      this.tabContentEl,
      this,
      {
        onTabCreated: () => {
          this.updateTabBar();
          this.updateNavRowLocation();
          this.persistTabState();
        },
        onTabSwitched: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateNavRowLocation();
          this.persistTabState();
        },
        onTabClosed: () => {
          this.updateTabBar();
          this.persistTabState();
        },
        onTabStreamingChanged: () => this.updateTabBar(),
        onTabTitleChanged: () => this.updateTabBar(),
        onTabAttentionChanged: () => this.updateTabBar(),
        onTabConversationChanged: () => {
          this.persistTabState();
        },
      }
    );

    // Wire up view-level event handlers
    this.wireEventHandlers();

    // Restore tabs from persisted state or create default tab
    await this.restoreOrCreateTabs();

    // Update tab bar visibility and nav row location
    this.updateTabBarVisibility();
    this.updateNavRowLocation();
  }

  async onClose() {
    // Cancel any pending tab bar update
    if (this.pendingTabBarUpdate !== null) {
      cancelAnimationFrame(this.pendingTabBarUpdate);
      this.pendingTabBarUpdate = null;
    }

    // Cleanup event refs
    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    // Persist tab state before cleanup (immediate, not debounced)
    await this.persistTabStateImmediate();

    // Destroy tab manager and all tabs
    await this.tabManager?.destroy();
    this.tabManager = null;

    // Cleanup tab bar
    this.tabBar?.destroy();
    this.tabBar = null;
  }

  // ============================================
  // UI Building
  // ============================================

  private buildHeader(header: HTMLElement) {
    // Header only contains logo and title now
    // Tab badges and header actions are in nav row (above input)
    const titleContainer = header.createDiv({ cls: 'claudian-title' });
    const logoEl = titleContainer.createSpan({ cls: 'claudian-logo' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', LOGO_SVG.viewBox);
    svg.setAttribute('width', LOGO_SVG.width);
    svg.setAttribute('height', LOGO_SVG.height);
    svg.setAttribute('fill', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', LOGO_SVG.path);
    path.setAttribute('fill', LOGO_SVG.fill);
    svg.appendChild(path);
    logoEl.appendChild(svg);
    titleContainer.createEl('h4', { text: 'Claudian' });
  }

  /**
   * Builds the nav row content (tab badges + header actions).
   * This is called once and the content is moved between tabs.
   */
  private buildNavRowContent(): HTMLElement {
    // Create a fragment to hold nav row content
    const fragment = document.createDocumentFragment();

    // Tab badges (left side)
    this.tabBarContainerEl = document.createElement('div');
    this.tabBarContainerEl.className = 'claudian-tab-bar-container';
    this.tabBar = new TabBar(this.tabBarContainerEl, {
      onTabClick: (tabId) => this.handleTabClick(tabId),
      onTabClose: (tabId) => this.handleTabClose(tabId),
      onNewTab: () => this.handleNewTab(),
    });
    fragment.appendChild(this.tabBarContainerEl);

    // Header actions (right side)
    const headerActions = document.createElement('div');
    headerActions.className = 'claudian-header-actions';

    // New tab button (plus icon)
    const newTabBtn = headerActions.createDiv({ cls: 'claudian-header-btn claudian-new-tab-btn' });
    setIcon(newTabBtn, 'square-plus');
    newTabBtn.setAttribute('aria-label', 'New tab');
    newTabBtn.addEventListener('click', async () => {
      await this.handleNewTab();
    });

    // New conversation button (square-pen icon - new conversation in current tab)
    const newBtn = headerActions.createDiv({ cls: 'claudian-header-btn' });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', async () => {
      await this.tabManager?.createNewConversation();
      this.updateHistoryDropdown();
    });

    // History dropdown
    const historyContainer = headerActions.createDiv({ cls: 'claudian-history-container' });
    const historyBtn = historyContainer.createDiv({ cls: 'claudian-header-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    fragment.appendChild(headerActions);

    // Create a wrapper div to hold the fragment
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    wrapper.appendChild(fragment);
    return wrapper;
  }

  /**
   * Moves nav row content to the active tab's nav row.
   */
  private updateNavRowLocation(): void {
    const activeTab = this.tabManager?.getActiveTab();
    if (!activeTab || !this.navRowContent) return;

    // Move nav row content to active tab's navRowEl
    activeTab.dom.navRowEl.appendChild(this.navRowContent);
  }

  // ============================================
  // Tab Management
  // ============================================

  private handleTabClick(tabId: TabId): void {
    this.tabManager?.switchToTab(tabId);
  }

  private async handleTabClose(tabId: TabId): Promise<void> {
    const tab = this.tabManager?.getTab(tabId);
    // If streaming, treat close like user interrupt (force close cancels the stream)
    const force = tab?.state.isStreaming ?? false;
    await this.tabManager?.closeTab(tabId, force);
    this.updateTabBarVisibility();
  }

  private async handleNewTab(): Promise<void> {
    const tab = await this.tabManager?.createTab();
    if (!tab) {
      const maxTabs = this.plugin.settings.maxTabs ?? 3;
      new Notice(`Maximum ${maxTabs} tabs allowed`);
      return;
    }
    this.updateTabBarVisibility();
  }

  private updateTabBar(): void {
    if (!this.tabManager || !this.tabBar) return;

    // Debounce tab bar updates using requestAnimationFrame
    if (this.pendingTabBarUpdate !== null) {
      cancelAnimationFrame(this.pendingTabBarUpdate);
    }

    this.pendingTabBarUpdate = requestAnimationFrame(() => {
      this.pendingTabBarUpdate = null;
      if (!this.tabManager || !this.tabBar) return;

      const items = this.tabManager.getTabBarItems();
      this.tabBar.update(items);
      this.updateTabBarVisibility();
    });
  }

  private updateTabBarVisibility(): void {
    if (!this.tabBarContainerEl || !this.tabManager) return;

    // Hide tab badges when only 1 tab, show when 2+
    const tabCount = this.tabManager.getTabCount();
    const showTabBar = tabCount >= 2;
    this.tabBarContainerEl.style.display = showTabBar ? 'flex' : 'none';
  }

  // ============================================
  // History Dropdown
  // ============================================

  private toggleHistoryDropdown(): void {
    if (!this.historyDropdown) return;

    const isVisible = this.historyDropdown.hasClass('visible');
    if (isVisible) {
      this.historyDropdown.removeClass('visible');
    } else {
      this.updateHistoryDropdown();
      this.historyDropdown.addClass('visible');
    }
  }

  private updateHistoryDropdown(): void {
    if (!this.historyDropdown) return;
    this.historyDropdown.empty();

    const activeTab = this.tabManager?.getActiveTab();
    const conversationController = activeTab?.controllers.conversationController;

    if (conversationController) {
      conversationController.renderHistoryDropdown(this.historyDropdown, {
        onSelectConversation: async (conversationId) => {
          // Check if conversation is already open in this view's tabs
          const existingTab = this.findTabWithConversation(conversationId);
          if (existingTab) {
            // Switch to existing tab instead of opening in current tab
            await this.tabManager?.switchToTab(existingTab.id);
            this.historyDropdown?.removeClass('visible');
            return;
          }

          // Check if conversation is open in another view (split workspace scenario)
          const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
          if (crossViewResult && crossViewResult.view !== this) {
            // Focus the other view's leaf and switch to the tab
            this.plugin.app.workspace.revealLeaf(crossViewResult.view.leaf);
            await crossViewResult.view.getTabManager()?.switchToTab(crossViewResult.tabId);
            this.historyDropdown?.removeClass('visible');
            return;
          }

          // Open in current tab
          await this.tabManager?.openConversation(conversationId);
          this.historyDropdown?.removeClass('visible');
        },
      });
    }
  }

  private findTabWithConversation(conversationId: string): TabData | null {
    const tabs = this.tabManager?.getAllTabs() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    // Document-level click to close dropdowns
    this.registerDomEvent(document, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    // Document-level escape to cancel streaming
    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        const activeTab = this.tabManager?.getActiveTab();
        if (activeTab?.state.isStreaming) {
          e.preventDefault();
          activeTab.controllers.inputController?.cancelStreaming();
        }
      }
    });

    // Vault events - forward to active tab's file context manager
    const createRef = this.plugin.app.vault.on('create', () => {
      this.tabManager?.getActiveTab()?.ui.fileContextManager?.markFilesCacheDirty();
    });
    this.eventRefs.push(createRef);

    const deleteRef = this.plugin.app.vault.on('delete', () => {
      this.tabManager?.getActiveTab()?.ui.fileContextManager?.markFilesCacheDirty();
    });
    this.eventRefs.push(deleteRef);

    const renameRef = this.plugin.app.vault.on('rename', () => {
      this.tabManager?.getActiveTab()?.ui.fileContextManager?.markFilesCacheDirty();
    });
    this.eventRefs.push(renameRef);

    const modifyRef = this.plugin.app.vault.on('modify', () => {
      this.tabManager?.getActiveTab()?.ui.fileContextManager?.markFilesCacheDirty();
    });
    this.eventRefs.push(modifyRef);

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.tabManager?.getActiveTab()?.ui.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    // Click outside to close mention dropdown
    this.registerDomEvent(document, 'click', (e) => {
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab) {
        const fcm = activeTab.ui.fileContextManager;
        if (fcm && !fcm.containsElement(e.target as Node) && e.target !== activeTab.dom.inputEl) {
          fcm.hideMentionDropdown();
        }
      }
    });
  }

  // ============================================
  // Persistence
  // ============================================

  private async restoreOrCreateTabs(): Promise<void> {
    if (!this.tabManager) return;

    // Try to restore from persisted state
    const persistedState = await this.plugin.storage.getTabManagerState();
    if (persistedState && persistedState.openTabs.length > 0) {
      await this.tabManager.restoreState(persistedState);
      await this.plugin.storage.clearLegacyActiveConversationId();
      return;
    }

    // No persisted state - migrate legacy activeConversationId if present
    const legacyActiveId = await this.plugin.storage.getLegacyActiveConversationId();
    if (legacyActiveId) {
      const conversation = await this.plugin.getConversationById(legacyActiveId);
      if (conversation) {
        await this.tabManager.createTab(conversation.id);
      } else {
        await this.tabManager.createTab();
      }
      await this.plugin.storage.clearLegacyActiveConversationId();
      return;
    }

    // Fallback: create a new empty tab
    await this.tabManager.createTab();
    await this.plugin.storage.clearLegacyActiveConversationId();
  }

  private persistTabState(): void {
    // Debounce persistence to avoid rapid writes (300ms delay)
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
    }
    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = null;
      if (!this.tabManager) return;
      const state = this.tabManager.getPersistedState();
      this.plugin.storage.setTabManagerState(state).catch(() => {
        // Silently ignore persistence errors
      });
    }, 300);
  }

  /** Force immediate persistence (for onClose/onunload). */
  private async persistTabStateImmediate(): Promise<void> {
    // Cancel any pending debounced persist
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
      this.pendingPersist = null;
    }
    if (!this.tabManager) return;
    const state = this.tabManager.getPersistedState();
    await this.plugin.storage.setTabManagerState(state);
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }
}
