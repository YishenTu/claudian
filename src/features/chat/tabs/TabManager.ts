/**
 * TabManager - Manages multiple chat tabs.
 *
 * Handles tab lifecycle (create, switch, close), persistence,
 * and coordination between tabs.
 */

import type { ClaudianService } from '../../../core/agent';
import type { McpServerManager } from '../../../core/mcp';
import type ClaudianPlugin from '../../../main';
import {
  activateTab,
  createTab,
  deactivateTab,
  destroyTab,
  getTabTitle,
  initializeTabControllers,
  initializeTabService,
  initializeTabUI,
  setupApprovalCallback,
  wireTabInputEvents,
} from './Tab';
import {
  DEFAULT_MAX_TABS,
  MAX_TABS,
  MIN_TABS,
  type PersistedTabManagerState,
  type PersistedTabState,
  type TabBarItem,
  type TabData,
  type TabId,
  type TabManagerCallbacks,
  type TabManagerInterface,
  type TabManagerViewHost,
} from './types';

/**
 * TabManager coordinates multiple chat tabs.
 */
export class TabManager implements TabManagerInterface {
  private plugin: ClaudianPlugin;
  private mcpManager: McpServerManager;
  private containerEl: HTMLElement;
  private view: TabManagerViewHost;

  private tabs: Map<TabId, TabData> = new Map();
  private activeTabId: TabId | null = null;
  private callbacks: TabManagerCallbacks;

  /** Guard to prevent concurrent tab switches. */
  private isSwitchingTab = false;

  /**
   * Gets the current max tabs limit from settings.
   * Clamps to MIN_TABS and MAX_TABS bounds.
   */
  private getMaxTabs(): number {
    const settingsValue = this.plugin.settings.maxTabs ?? DEFAULT_MAX_TABS;
    return Math.max(MIN_TABS, Math.min(MAX_TABS, settingsValue));
  }

  constructor(
    plugin: ClaudianPlugin,
    mcpManager: McpServerManager,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks: TabManagerCallbacks = {}
  ) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
    this.containerEl = containerEl;
    this.view = view;
    this.callbacks = callbacks;
  }

  // ============================================
  // Tab Lifecycle
  // ============================================

  /**
   * Creates a new tab.
   * @param conversationId Optional conversation to load into the tab.
   * @param tabId Optional tab ID (for restoration).
   * @returns The created tab, or null if max tabs reached.
   */
  async createTab(conversationId?: string | null, tabId?: TabId): Promise<TabData | null> {
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size >= maxTabs) {
      return null;
    }

    const conversation = conversationId
      ? await this.plugin.getConversationById(conversationId)
      : undefined;

    const tab = createTab({
      plugin: this.plugin,
      mcpManager: this.mcpManager,
      containerEl: this.containerEl,
      conversation: conversation ?? undefined,
      tabId,
      onStreamingChanged: (isStreaming) => {
        this.callbacks.onTabStreamingChanged?.(tab.id, isStreaming);
      },
      onTitleChanged: (title) => {
        this.callbacks.onTabTitleChanged?.(tab.id, title);
      },
      onAttentionChanged: (needsAttention) => {
        this.callbacks.onTabAttentionChanged?.(tab.id, needsAttention);
      },
      onConversationIdChanged: (conversationId) => {
        // Sync tab.conversationId when conversation is lazily created
        tab.conversationId = conversationId;
        this.callbacks.onTabConversationChanged?.(tab.id, conversationId);
      },
    });

    // Initialize UI components
    initializeTabUI(tab, this.plugin);

    // Initialize controllers (pass mcpManager for lazy service initialization)
    initializeTabControllers(tab, this.plugin, this.view, this.mcpManager);

    // Wire input event handlers
    wireTabInputEvents(tab);

    this.tabs.set(tab.id, tab);
    this.callbacks.onTabCreated?.(tab);

    // Auto-switch to the newly created tab
    await this.switchToTab(tab.id);

    return tab;
  }

  /**
   * Switches to a different tab.
   * @param tabId The tab to switch to.
   */
  async switchToTab(tabId: TabId): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }

    // Guard against concurrent tab switches
    if (this.isSwitchingTab) {
      return;
    }

    this.isSwitchingTab = true;
    const previousTabId = this.activeTabId;

    try {
      // Deactivate current tab
      if (previousTabId && previousTabId !== tabId) {
        const currentTab = this.tabs.get(previousTabId);
        if (currentTab) {
          deactivateTab(currentTab);
        }
      }

      // Activate new tab
      this.activeTabId = tabId;
      activateTab(tab);

      // Service initialization is now truly lazy - happens on first query via
      // ensureServiceInitialized() in InputController.sendMessage()

      // Load conversation if not already loaded
      if (tab.conversationId && tab.state.messages.length === 0) {
        await tab.controllers.conversationController?.switchTo(tab.conversationId);
      } else if (tab.conversationId && tab.state.messages.length > 0 && tab.service) {
        // Tab already has messages loaded - sync service session to conversation
        // This handles the case where user switches between tabs with different sessions
        const conversation = await this.plugin.getConversationById(tab.conversationId);
        if (conversation && conversation.sessionId !== tab.service.getSessionId()) {
          tab.service.setSessionId(conversation.sessionId ?? null);
        }
      } else if (!tab.conversationId && tab.state.messages.length === 0) {
        // New tab with no conversation - initialize welcome greeting
        tab.controllers.conversationController?.initializeWelcome();
      }

      this.callbacks.onTabSwitched?.(previousTabId, tabId);
    } finally {
      this.isSwitchingTab = false;
    }
  }

  /**
   * Closes a tab.
   * @param tabId The tab to close.
   * @param force If true, close even if streaming.
   * @returns True if the tab was closed.
   */
  async closeTab(tabId: TabId, force = false): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }

    // Don't close if streaming unless forced
    if (tab.state.isStreaming && !force) {
      return false;
    }

    // If this is the last tab and it's already empty (no conversation),
    // don't close it - it's already a fresh session with a warm service.
    // Closing and recreating would waste the pre-warmed connection.
    if (this.tabs.size === 1 && !tab.conversationId && tab.state.messages.length === 0) {
      return false;
    }

    // Save conversation before closing
    await tab.controllers.conversationController?.save();

    // Destroy tab resources (async for proper cleanup)
    await destroyTab(tab);
    this.tabs.delete(tabId);
    this.callbacks.onTabClosed?.(tabId);

    // If we closed the active tab, switch to another
    if (this.activeTabId === tabId) {
      this.activeTabId = null;

      // Switch to the first remaining tab, or create a new one
      if (this.tabs.size > 0) {
        // Use Array.from for safer type narrowing instead of iterator.next()
        const remainingTabIds = Array.from(this.tabs.keys());
        const nextTabId = remainingTabIds[0];
        if (nextTabId) {
          await this.switchToTab(nextTabId);

          // If this is now the only tab and it's not warm, pre-warm immediately
          // User expects the active tab to be ready for chat
          if (this.tabs.size === 1) {
            await this.initializeActiveTabService();
          }
        }
      } else {
        // Create a new empty tab and pre-warm immediately
        // This is the only tab, so it should be ready for chat
        await this.createTab();
        await this.initializeActiveTabService();
      }
    }

    return true;
  }

  // ============================================
  // Tab Queries
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  /** Gets the active tab ID. */
  getActiveTabId(): TabId | null {
    return this.activeTabId;
  }

  /** Gets a tab by ID. */
  getTab(tabId: TabId): TabData | null {
    return this.tabs.get(tabId) ?? null;
  }

  /** Gets all tabs. */
  getAllTabs(): TabData[] {
    return Array.from(this.tabs.values());
  }

  /** Gets the number of tabs. */
  getTabCount(): number {
    return this.tabs.size;
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return this.tabs.size < this.getMaxTabs();
  }

  // ============================================
  // Tab Bar Data
  // ============================================

  /** Gets data for rendering the tab bar. */
  getTabBarItems(): TabBarItem[] {
    const items: TabBarItem[] = [];
    let index = 1;

    for (const tab of this.tabs.values()) {
      items.push({
        id: tab.id,
        index: index++,
        title: getTabTitle(tab, this.plugin),
        isActive: tab.id === this.activeTabId,
        isStreaming: tab.state.isStreaming,
        needsAttention: tab.state.needsAttention,
        canClose: this.tabs.size > 1 || !tab.state.isStreaming,
      });
    }

    return items;
  }

  // ============================================
  // Conversation Management
  // ============================================

  /**
   * Opens a conversation in a new tab or existing tab.
   * @param conversationId The conversation to open.
   * @param preferNewTab If true, prefer opening in a new tab.
   */
  async openConversation(conversationId: string, preferNewTab = false): Promise<void> {
    // Check if conversation is already open in this view's tabs
    for (const tab of this.tabs.values()) {
      if (tab.conversationId === conversationId) {
        await this.switchToTab(tab.id);
        return;
      }
    }

    // Check if conversation is open in another view (split workspace scenario)
    // Compare view references directly (more robust than leaf comparison)
    const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
    const isSameView = crossViewResult?.view === this.view;
    if (crossViewResult && !isSameView) {
      // Focus the other view and switch to its tab instead of opening duplicate
      this.plugin.app.workspace.revealLeaf(crossViewResult.view.leaf);
      await crossViewResult.view.getTabManager()?.switchToTab(crossViewResult.tabId);
      return;
    }

    // Open in current tab or new tab
    if (preferNewTab && this.canCreateTab()) {
      await this.createTab(conversationId);
    } else {
      // Open in current tab
      // Note: Don't set tab.conversationId here - the onConversationIdChanged callback
      // will sync it after successful switch. Setting it before switchTo() would cause
      // incorrect tab metadata if switchTo() returns early (streaming/switching/creating).
      const activeTab = this.getActiveTab();
      if (activeTab) {
        await activeTab.controllers.conversationController?.switchTo(conversationId);
      }
    }
  }

  /**
   * Creates a new conversation in the active tab.
   */
  async createNewConversation(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (activeTab) {
      await activeTab.controllers.conversationController?.createNew();
      // Sync tab.conversationId with the newly created conversation
      activeTab.conversationId = activeTab.state.currentConversationId;
    }
  }

  // ============================================
  // Persistence
  // ============================================

  /** Gets the state to persist. */
  getPersistedState(): PersistedTabManagerState {
    const openTabs: PersistedTabState[] = [];

    for (const tab of this.tabs.values()) {
      openTabs.push({
        tabId: tab.id,
        conversationId: tab.conversationId,
      });
    }

    return {
      openTabs,
      activeTabId: this.activeTabId,
    };
  }

  /** Restores state from persisted data. */
  async restoreState(state: PersistedTabManagerState): Promise<void> {
    // Create tabs from persisted state with error handling
    for (const tabState of state.openTabs) {
      try {
        await this.createTab(tabState.conversationId, tabState.tabId);
      } catch {
        // Continue restoring other tabs
      }
    }

    // Switch to the previously active tab
    if (state.activeTabId && this.tabs.has(state.activeTabId)) {
      try {
        await this.switchToTab(state.activeTabId);
      } catch {
        // Ignore switch errors
      }
    }

    // If no tabs were restored, create a default one
    if (this.tabs.size === 0) {
      await this.createTab();
    }

    // Pre-initialize the active tab's service so it's ready immediately
    // Other tabs stay lazy until first query
    await this.initializeActiveTabService();
  }

  /**
   * Initializes the active tab's service if not already done.
   * Called after restore to ensure the visible tab is ready immediately.
   */
  private async initializeActiveTabService(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (!activeTab || activeTab.serviceInitialized) {
      return;
    }

    try {
      await initializeTabService(activeTab, this.plugin, this.mcpManager);
      setupApprovalCallback(activeTab);
    } catch {
      // Non-fatal - service will be initialized on first query
    }
  }

  // ============================================
  // Broadcast
  // ============================================

  /**
   * Broadcasts a function call to all tabs' ClaudianService instances.
   * Used by settings managers to apply configuration changes to all tabs.
   * @param fn Function to call on each service.
   */
  async broadcastToAllTabs(fn: (service: ClaudianService) => Promise<void>): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const tab of this.tabs.values()) {
      if (tab.service && tab.serviceInitialized) {
        promises.push(
          fn(tab.service).catch(() => {
            // Silently ignore broadcast errors
          })
        );
      }
    }

    await Promise.all(promises);
  }

  // ============================================
  // Cleanup
  // ============================================

  /** Destroys all tabs and cleans up resources. */
  async destroy(): Promise<void> {
    // Save all conversations
    for (const tab of this.tabs.values()) {
      await tab.controllers.conversationController?.save();
    }

    // Destroy all tabs (async for proper cleanup)
    for (const tab of this.tabs.values()) {
      await destroyTab(tab);
    }

    this.tabs.clear();
    this.activeTabId = null;
  }
}
