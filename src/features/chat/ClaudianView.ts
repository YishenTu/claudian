/**
 * Claudian - Sidebar chat view
 *
 * Thin shell that coordinates TabManager for multi-tab support.
 * All per-conversation state is managed by individual tabs.
 */

import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, setIcon } from 'obsidian';

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

  // Header elements
  private historyDropdown: HTMLElement | null = null;

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];


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
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('claudian-container');

    // Build header (includes tab bar)
    const header = container.createDiv({ cls: 'claudian-header' });
    this.buildHeader(header);

    // Tab content container (TabManager will populate this)
    this.tabContentEl = container.createDiv({ cls: 'claudian-tab-content-container' });

    // Initialize TabManager
    this.tabManager = new TabManager(
      this.plugin,
      this.plugin.mcpService.getManager(),
      this.tabContentEl,
      this,
      {
        onTabCreated: () => this.updateTabBar(),
        onTabSwitched: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
        },
        onTabClosed: () => this.updateTabBar(),
        onTabStreamingChanged: () => this.updateTabBar(),
        onTabTitleChanged: () => this.updateTabBar(),
        onTabAttentionChanged: () => this.updateTabBar(),
      }
    );

    // Wire up view-level event handlers
    this.wireEventHandlers();

    // Restore tabs from persisted state or create default tab
    await this.restoreOrCreateTabs();

    // Update tab bar visibility
    this.updateTabBarVisibility();
  }

  async onClose() {
    // Cleanup event refs
    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    // Persist tab state before cleanup
    await this.persistTabState();

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
    // Left section: Logo, title, and tab badges
    const leftSection = header.createDiv({ cls: 'claudian-header-left' });

    // Logo and title
    const titleContainer = leftSection.createDiv({ cls: 'claudian-title' });
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

    // Tab badges (hidden when only 1 tab)
    this.tabBarContainerEl = leftSection.createDiv({ cls: 'claudian-tab-bar-container' });
    this.tabBar = new TabBar(this.tabBarContainerEl, {
      onTabClick: (tabId) => this.handleTabClick(tabId),
      onTabClose: (tabId) => this.handleTabClose(tabId),
      onNewTab: () => this.handleNewTab(),
    });

    // Right section: Header actions (fixed)
    const headerActions = header.createDiv({ cls: 'claudian-header-actions' });

    // New tab button (plus icon)
    const newTabBtn = headerActions.createDiv({ cls: 'claudian-header-btn' });
    setIcon(newTabBtn, 'plus');
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
  }

  // ============================================
  // Tab Management
  // ============================================

  private handleTabClick(tabId: TabId): void {
    this.tabManager?.switchToTab(tabId);
  }

  private async handleTabClose(tabId: TabId): Promise<void> {
    const tab = this.tabManager?.getTab(tabId);
    if (tab?.state.isStreaming) {
      // TODO: Show confirmation dialog for closing streaming tab
      return;
    }
    await this.tabManager?.closeTab(tabId);
    this.updateTabBarVisibility();
  }

  private async handleNewTab(): Promise<void> {
    await this.tabManager?.createTab();
    this.updateTabBarVisibility();
  }

  private updateTabBar(): void {
    if (!this.tabManager || !this.tabBar) return;
    const items = this.tabManager.getTabBarItems();
    this.tabBar.update(items);
    this.updateTabBarVisibility();
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
          // Check if conversation is already open in another tab
          const existingTab = this.findTabWithConversation(conversationId);
          if (existingTab) {
            // Switch to existing tab instead of opening in current tab
            await this.tabManager?.switchToTab(existingTab.id);
          } else {
            // Open in current tab
            await this.tabManager?.openConversation(conversationId);
          }
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
    } else {
      // No persisted state - create a tab with the active conversation
      const activeConvId = this.plugin.getActiveConversation()?.id;
      await this.tabManager.createTab(activeConvId);
    }
  }

  private async persistTabState(): Promise<void> {
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
