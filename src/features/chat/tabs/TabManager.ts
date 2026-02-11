import { Notice } from 'obsidian';

import type { ClaudianService } from '../../../core/agent';
import type { McpServerManager } from '../../../core/mcp';
import type { SlashCommand } from '../../../core/types';
import { t } from '../../../i18n';
import type ClaudianPlugin from '../../../main';
import { chooseForkTarget } from '../../../shared/modals/ForkTargetModal';
import {
  activateTab,
  createTab,
  deactivateTab,
  destroyTab,
  type ForkContext,
  getTabTitle,
  initializeTabControllers,
  initializeTabService,
  initializeTabUI,
  setupServiceCallbacks,
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

    // Initialize UI components with shared SDK commands callback
    initializeTabUI(tab, this.plugin, {
      getSdkCommands: () => this.getSdkCommands(),
      getSdkModels: () => this.getSdkModels(),
    });

    // Initialize controllers (pass mcpManager for lazy service initialization)
    initializeTabControllers(
      tab,
      this.plugin,
      this.view,
      this.mcpManager,
      (forkContext) => this.handleForkRequest(forkContext),
      (conversationId) => this.openConversation(conversationId),
    );

    // Wire input event handlers
    wireTabInputEvents(tab, this.plugin);

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
        if (conversation) {
          const hasMessages = conversation.messages.length > 0;
          const externalContextPaths = hasMessages
            ? conversation.externalContextPaths || []
            : (this.plugin.settings.persistentExternalContextPaths || []);

          const resolvedSessionId = tab.service.applyForkState(conversation);
          tab.service.setSessionId(resolvedSessionId, externalContextPaths);
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

    // Capture tab order BEFORE deletion for fallback calculation
    const tabIdsBefore = Array.from(this.tabs.keys());
    const closingIndex = tabIdsBefore.indexOf(tabId);

    // Destroy tab resources (async for proper cleanup)
    await destroyTab(tab);
    this.tabs.delete(tabId);
    this.callbacks.onTabClosed?.(tabId);

    // If we closed the active tab, switch to another
    if (this.activeTabId === tabId) {
      this.activeTabId = null;

      if (this.tabs.size > 0) {
        // Fallback strategy: prefer previous tab, except for first tab (go to next)
        const fallbackTabId = closingIndex === 0
          ? tabIdsBefore[1]  // First tab: go to next
          : tabIdsBefore[closingIndex - 1];  // Others: go to previous

        if (fallbackTabId && this.tabs.has(fallbackTabId)) {
          await this.switchToTab(fallbackTabId);

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
  // Fork
  // ============================================

  private async handleForkRequest(context: ForkContext): Promise<void> {
    const target = await chooseForkTarget(this.plugin.app);
    if (!target) return;

    if (target === 'new-tab') {
      const tab = await this.forkToNewTab(context);
      if (!tab) {
        const maxTabs = this.getMaxTabs();
        new Notice(t('chat.fork.maxTabsReached', { count: String(maxTabs) }));
        return;
      }
      new Notice(t('chat.fork.notice'));
    } else {
      const success = await this.forkInCurrentTab(context);
      if (!success) {
        new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoActiveTab') }));
        return;
      }
      new Notice(t('chat.fork.noticeCurrentTab'));
    }
  }

  async forkToNewTab(context: ForkContext): Promise<TabData | null> {
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size >= maxTabs) {
      return null;
    }

    const conversationId = await this.createForkConversation(context);
    try {
      return await this.createTab(conversationId);
    } catch (error) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      throw error;
    }
  }

  async forkInCurrentTab(context: ForkContext): Promise<boolean> {
    const activeTab = this.getActiveTab();
    if (!activeTab?.controllers.conversationController) return false;

    const conversationId = await this.createForkConversation(context);
    try {
      await activeTab.controllers.conversationController.switchTo(conversationId);
    } catch (error) {
      await this.plugin.deleteConversation(conversationId).catch(() => {});
      throw error;
    }
    return true;
  }

  private async createForkConversation(context: ForkContext): Promise<string> {
    const conversation = await this.plugin.createConversation();

    const title = context.sourceTitle
      ? this.buildForkTitle(context.sourceTitle, context.forkAtUserMessage)
      : undefined;

    await this.plugin.updateConversation(conversation.id, {
      messages: context.messages,
      forkSource: { sessionId: context.sourceSessionId, resumeAt: context.resumeAt },
      // Prevent immediate SDK message load from merging duplicates with the copied messages.
      // This is in-memory only (not persisted in metadata).
      sdkMessagesLoaded: true,
      ...(title && { title }),
      ...(context.currentNote && { currentNote: context.currentNote }),
    });

    return conversation.id;
  }

  private buildForkTitle(sourceTitle: string, forkAtUserMessage?: number): string {
    const MAX_TITLE_LENGTH = 50;
    const forkSuffix = forkAtUserMessage ? ` (#${forkAtUserMessage})` : '';
    const forkPrefix = 'Fork: ';
    const maxSourceLength = MAX_TITLE_LENGTH - forkPrefix.length - forkSuffix.length;
    const truncatedSource = sourceTitle.length > maxSourceLength
      ? sourceTitle.slice(0, maxSourceLength - 1) + '…'
      : sourceTitle;
    let title = forkPrefix + truncatedSource + forkSuffix;

    const existingTitles = new Set(this.plugin.getConversationList().map(c => c.title));
    if (existingTitles.has(title)) {
      let n = 2;
      while (existingTitles.has(`${title} ${n}`)) n++;
      title = `${title} ${n}`;
    }

    return title;
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
      // initializeTabService() handles session ID resolution from tab.conversationId
      await initializeTabService(activeTab, this.plugin, this.mcpManager);
      setupServiceCallbacks(activeTab, this.plugin);
    } catch {
      // Non-fatal - service will be initialized on first query
    }
  }

  // ============================================
  // SDK Commands (Shared)
  // ============================================

  /**
   * Gets SDK supported commands from any ready service.
   * The command list is the same for all tabs, so we just need one ready service.
   * @returns Array of SDK commands, or empty array if no service is ready.
   */
  async getSdkCommands(): Promise<SlashCommand[]> {
    // Find any tab with a ready service
    for (const tab of this.tabs.values()) {
      if (tab.service?.isReady()) {
        return tab.service.getSupportedCommands();
      }
    }
    return [];
  }

  async getSdkModels(): Promise<{ value: string; label: string; description: string }[]> {
    for (const tab of this.tabs.values()) {
      if (tab.service?.isReady()) {
        return tab.service.getSupportedModels();
      }
    }
    return [];
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
