/**
 * Claudian - Obsidian plugin entry point
 *
 * Registers the sidebar chat view, settings tab, and commands.
 * Manages conversation persistence and environment variable configuration.
 */

import type { Editor, MarkdownView } from 'obsidian';
import { Notice, Plugin } from 'obsidian';

import { clearDiffState } from './core/hooks';
import { McpServerManager } from './core/mcp';
import { McpService } from './core/mcp/McpService';
import { loadPluginCommands, PluginManager, PluginStorage } from './core/plugins';
import { StorageService } from './core/storage';
import type {
  ChatMessage,
  ClaudianSettings,
  Conversation,
  ConversationMeta
} from './core/types';
import {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_SETTINGS,
  getCliPlatformKey,
  getHostnameKey,
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import { ClaudianView } from './features/chat/ClaudianView';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n';
import { ClaudeCliResolver } from './utils/claudeCli';
import { buildCursorContext } from './utils/editor';
import { getCurrentModelFromEnvironment, getModelsFromEnvironment, parseEnvironmentVariables } from './utils/env';
import { getVaultPath } from './utils/path';
import { loadSDKSessionMessages, sdkSessionExists, type SDKSessionLoadResult } from './utils/sdkSession';

/**
 * Main plugin class for Claudian.
 * Handles plugin lifecycle, settings persistence, and conversation management.
 */
export default class ClaudianPlugin extends Plugin {
  settings: ClaudianSettings;
  mcpService: McpService;
  pluginManager: PluginManager;
  storage: StorageService;
  cliResolver: ClaudeCliResolver;
  private conversations: Conversation[] = [];
  private runtimeEnvironmentVariables = '';
  private hasNotifiedEnvChange = false;

  async onload() {
    await this.loadSettings();

    this.cliResolver = new ClaudeCliResolver();

    // Initialize MCP service first (shared manager for agent + UI)
    const mcpManager = new McpServerManager(this.storage.mcp);
    this.mcpService = new McpService(mcpManager);
    await this.mcpService.loadServers();

    // Initialize plugin manager
    const vaultPath = (this.app.vault.adapter as any).basePath;
    const pluginStorage = new PluginStorage(vaultPath);
    this.pluginManager = new PluginManager(pluginStorage);
    this.pluginManager.setEnabledPluginIds(this.settings.enabledPlugins);
    await this.pluginManager.loadPlugins();

    // Clean up unavailable plugins from settings and notify user
    const unavailablePlugins = this.pluginManager.getUnavailableEnabledPlugins();
    if (unavailablePlugins.length > 0) {
      this.settings.enabledPlugins = this.settings.enabledPlugins
        .filter(id => !unavailablePlugins.includes(id));
      await this.saveSettings();

      const count = unavailablePlugins.length;
      new Notice(`${count} plugin${count > 1 ? 's' : ''} became unavailable and ${count > 1 ? 'were' : 'was'} disabled`);
    }

    // Load slash commands from enabled plugins and merge with vault commands
    this.loadPluginSlashCommands();

    this.registerView(
      VIEW_TYPE_CLAUDIAN,
      (leaf) => new ClaudianView(leaf, this)
    );

    this.addRibbonIcon('bot', 'Open Claudian', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-view',
      name: 'Open chat view',
      callback: () => {
        this.activateView();
      },
    });

    this.addCommand({
      id: 'inline-edit',
      name: 'Inline edit',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const selectedText = editor.getSelection();
        const notePath = view.file?.path || 'unknown';

        let editContext: InlineEditContext;
        if (selectedText.trim()) {
          // Selection mode
          editContext = { mode: 'selection', selectedText };
        } else {
          // Cursor mode - build cursor context
          const cursor = editor.getCursor();
          const cursorContext = buildCursorContext(
            (line) => editor.getLine(line),
            editor.lineCount(),
            cursor.line,
            cursor.ch
          );
          editContext = { mode: 'cursor', cursorContext };
        }

        const modal = new InlineEditModal(this.app, this, editContext, notePath);
        const result = await modal.openAndWait();

        if (result.decision === 'accept' && result.editedText !== undefined) {
          new Notice(editContext.mode === 'cursor' ? 'Inserted' : 'Edit applied');
        }
      },
    });

    this.addCommand({
      id: 'new-tab',
      name: 'New tab',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as ClaudianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        // Only enable command when we can create more tabs
        if (!tabManager.canCreateTab()) return false;

        if (!checking) {
          tabManager.createTab();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'new-session',
      name: 'New session (in current tab)',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as ClaudianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        const activeTab = tabManager.getActiveTab();
        if (!activeTab) return false;

        // Don't allow new session while streaming
        if (activeTab.state.isStreaming) return false;

        if (!checking) {
          tabManager.createNewConversation();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'close-current-tab',
      name: 'Close current tab',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as ClaudianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        if (!checking) {
          const activeTabId = tabManager.getActiveTabId();
          if (activeTabId) {
            // When closing the last tab, TabManager will create a new empty one
            tabManager.closeTab(activeTabId);
          }
        }
        return true;
      },
    });

    this.addSettingTab(new ClaudianSettingTab(this.app, this));
  }

  async onunload() {
    // Persist tab state for all views before unloading
    // This ensures state is saved even if Obsidian quits without calling onClose()
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const state = tabManager.getPersistedState();
        await this.storage.setTabManagerState(state);
      }
    }
  }

  /** Opens the Claudian sidebar view, creating it if necessary. */
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /** Loads settings and conversations from persistent storage. */
  async loadSettings() {
    // Initialize storage service (handles migration if needed)
    this.storage = new StorageService(this);
    const { claudian } = await this.storage.initialize();

    // Load slash commands from files
    const slashCommands = await this.storage.commands.loadAll();

    // Merge settings with defaults and slashCommands
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...claudian,
      slashCommands,
    };

    // Initialize and migrate legacy CLI paths to hostname-based paths
    this.settings.claudeCliPathsByHost ??= {};
    const hostname = getHostnameKey();
    let didMigrateCliPath = false;

    if (!this.settings.claudeCliPathsByHost[hostname]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const platformPaths = (this.settings as any).claudeCliPaths as Record<string, string> | undefined;
      const migratedPath = platformPaths?.[getCliPlatformKey()]?.trim() || this.settings.claudeCliPath?.trim();

      if (migratedPath) {
        this.settings.claudeCliPathsByHost[hostname] = migratedPath;
        this.settings.claudeCliPath = '';
        didMigrateCliPath = true;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (this.settings as any).claudeCliPaths;

    // Load all conversations from session files (legacy JSONL + native metadata)
    const { conversations: legacyConversations, failedCount } = await this.storage.sessions.loadAllConversations();
    const legacyIds = new Set(legacyConversations.map(c => c.id));

    // Overlay native metadata onto legacy conversations if present
    for (const conversation of legacyConversations) {
      const meta = await this.storage.sessions.loadMetadata(conversation.id);
      if (!meta) continue;

      conversation.isNative = true;
      conversation.title = meta.title ?? conversation.title;
      conversation.titleGenerationStatus = meta.titleGenerationStatus ?? conversation.titleGenerationStatus;
      conversation.createdAt = meta.createdAt ?? conversation.createdAt;
      conversation.updatedAt = meta.updatedAt ?? conversation.updatedAt;
      conversation.lastResponseAt = meta.lastResponseAt ?? conversation.lastResponseAt;
      if (meta.sessionId !== undefined) {
        conversation.sessionId = meta.sessionId;
      }
      conversation.currentNote = meta.currentNote ?? conversation.currentNote;
      conversation.externalContextPaths = meta.externalContextPaths ?? conversation.externalContextPaths;
      conversation.enabledMcpServers = meta.enabledMcpServers ?? conversation.enabledMcpServers;
      conversation.usage = meta.usage ?? conversation.usage;
      if (meta.sdkSessionId !== undefined) {
        conversation.sdkSessionId = meta.sdkSessionId;
      } else if (conversation.sdkSessionId === undefined && conversation.sessionId) {
        conversation.sdkSessionId = conversation.sessionId;
      }
      conversation.legacyCutoffAt = meta.legacyCutoffAt ?? conversation.legacyCutoffAt;
    }

    // Also load native session metadata (no legacy JSONL)
    const nativeMetadata = await this.storage.sessions.listNativeMetadata();
    const nativeConversations: Conversation[] = nativeMetadata
      .filter(meta => !legacyIds.has(meta.id))
      .map(meta => {
        const resumeSessionId = meta.sessionId !== undefined ? meta.sessionId : meta.id;
        const sdkSessionId = meta.sdkSessionId !== undefined
          ? meta.sdkSessionId
          : (resumeSessionId ?? undefined);

        return {
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          lastResponseAt: meta.lastResponseAt,
          sessionId: resumeSessionId,
          sdkSessionId,
          messages: [], // Messages are in SDK storage, loaded on demand
          currentNote: meta.currentNote,
          externalContextPaths: meta.externalContextPaths,
          enabledMcpServers: meta.enabledMcpServers,
          usage: meta.usage,
          titleGenerationStatus: meta.titleGenerationStatus,
          legacyCutoffAt: meta.legacyCutoffAt,
          isNative: true,
        };
      });

    // Merge and sort by lastResponseAt/updatedAt
    this.conversations = [...legacyConversations, ...nativeConversations].sort(
      (a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt)
    );

    if (failedCount > 0) {
      new Notice(`Failed to load ${failedCount} conversation${failedCount > 1 ? 's' : ''}`);
    }
    // Initialize i18n with saved locale
    setLocale(this.settings.locale);

    const backfilledConversations = this.backfillConversationResponseTimestamps();

    this.runtimeEnvironmentVariables = this.settings.environmentVariables || '';
    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(this.runtimeEnvironmentVariables);

    if (changed || didMigrateCliPath) {
      await this.saveSettings();
    }

    // Persist backfilled and invalidated conversations to their session files
    const conversationsToSave = new Set([...backfilledConversations, ...invalidatedConversations]);
    for (const conv of conversationsToSave) {
      if (conv.isNative) {
        // Native session: save metadata only
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conv)
        );
      } else {
        // Legacy session: save full JSONL
        await this.storage.sessions.saveConversation(conv);
      }
    }
  }

  private backfillConversationResponseTimestamps(): Conversation[] {
    const updated: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.lastResponseAt != null) continue;
      if (!conv.messages || conv.messages.length === 0) continue;

      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg.role === 'assistant') {
          conv.lastResponseAt = msg.timestamp;
          updated.push(conv);
          break;
        }
      }
    }
    return updated;
  }

  /** Persists settings to storage. */
  async saveSettings() {
    // Save settings (excluding slashCommands which are stored separately)
    const {
      slashCommands: _,
      ...settingsToSave
    } = this.settings;

    await this.storage.saveClaudianSettings(settingsToSave);
  }

  /**
   * Loads slash commands from enabled plugins and merges them with vault commands.
   * Plugin commands are namespaced with the plugin name (e.g., "plugin-name:command").
   */
  loadPluginSlashCommands(): void {
    // Get vault commands (already loaded in settings)
    const vaultCommands = this.settings.slashCommands.filter(
      cmd => !cmd.id.startsWith('plugin-')
    );

    // Load commands from enabled plugins
    const pluginPaths = this.pluginManager.getPluginCommandPaths();
    const pluginCommands = pluginPaths.flatMap(
      ({ pluginName, commandsPath }) => loadPluginCommands(commandsPath, pluginName)
    );

    // Merge vault commands with plugin commands
    this.settings.slashCommands = [...vaultCommands, ...pluginCommands];
  }

  /** Updates and persists environment variables, notifying if restart is needed. */
  async applyEnvironmentVariables(envText: string): Promise<void> {
    this.settings.environmentVariables = envText;
    await this.saveSettings();

    if (envText !== this.runtimeEnvironmentVariables) {
      if (!this.hasNotifiedEnvChange) {
        new Notice('Environment variables changed. Restart the plugin for changes to take effect.');
        this.hasNotifiedEnvChange = true;
      }
    } else {
      this.hasNotifiedEnvChange = false;
    }
  }

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(): string {
    return this.runtimeEnvironmentVariables;
  }

  getResolvedClaudeCliPath(): string | null {
    return this.cliResolver.resolve(
      this.settings.claudeCliPathsByHost,  // Per-device paths (preferred)
      this.settings.claudeCliPath,          // Legacy path (fallback)
      this.getActiveEnvironmentVariables()
    );
  }

  private getDefaultModelValues(): string[] {
    return DEFAULT_CLAUDE_MODELS.map((m) => m.value);
  }

  private getPreferredCustomModel(envVars: Record<string, string>, customModels: { value: string }[]): string {
    const envPreferred = getCurrentModelFromEnvironment(envVars);
    if (envPreferred && customModels.some((m) => m.value === envPreferred)) {
      return envPreferred;
    }
    return customModels[0].value;
  }

  /** Computes a hash of model and provider base URL environment variables for change detection. */
  private computeEnvHash(envText: string): string {
    const envVars = parseEnvironmentVariables(envText || '');
    const modelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ];
    const providerKeys = [
      'ANTHROPIC_BASE_URL',
    ];
    const allKeys = [...modelKeys, ...providerKeys];
    const relevantPairs = allKeys
      .filter(key => envVars[key])
      .map(key => `${key}=${envVars[key]}`)
      .sort()
      .join('|');
    return relevantPairs;
  }

  /**
   * Reconciles model with environment.
   * Returns { changed, invalidatedConversations } where changed indicates if
   * settings were modified (requiring save), and invalidatedConversations lists
   * conversations that had their sessionId cleared (also requiring save).
   */
  private reconcileModelWithEnvironment(envText: string): {
    changed: boolean;
    invalidatedConversations: Conversation[];
  } {
    const currentHash = this.computeEnvHash(envText);
    const savedHash = this.settings.lastEnvHash || '';

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    // Hash changed - model or provider may have changed.
    // Session invalidation is now handled per-tab by TabManager.
    clearDiffState(); // Clear UI diff state (not SDK-related)

    // Clear resume sessionId from all conversations since they belong to the old provider.
    // Sessions are provider-specific (contain signed thinking blocks, etc.).
    // NOTE: sdkSessionId is retained for loading SDK-stored history.
    const invalidatedConversations: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.sessionId) {
        conv.sessionId = null;
        invalidatedConversations.push(conv);
      }
    }

    const envVars = parseEnvironmentVariables(envText || '');
    const customModels = getModelsFromEnvironment(envVars);

    if (customModels.length > 0) {
      this.settings.model = this.getPreferredCustomModel(envVars, customModels);
    } else {
      this.settings.model = DEFAULT_CLAUDE_MODELS[0].value;
    }

    this.settings.lastEnvHash = currentHash;
    return { changed: true, invalidatedConversations };
  }

  private generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private getConversationPreview(conv: Conversation): string {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) {
      // For native sessions without loaded messages, indicate it's a persisted session
      // rather than "New conversation" which implies no content exists
      return conv.isNative ? 'SDK session' : 'New conversation';
    }
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  private async loadSdkMessagesForConversation(conversation: Conversation): Promise<void> {
    if (!conversation.isNative || conversation.sdkMessagesLoaded) return;

    const vaultPath = getVaultPath(this.app);
    const sdkSessionToLoad = conversation.sdkSessionId ?? conversation.sessionId;
    if (!vaultPath || !sdkSessionToLoad) return;

    if (!sdkSessionExists(vaultPath, sdkSessionToLoad)) return;

    const result: SDKSessionLoadResult = await loadSDKSessionMessages(vaultPath, sdkSessionToLoad);

    // Notify user of issues
    if (result.error) {
      new Notice(`Failed to load conversation history: ${result.error}`);
      return;
    }
    if (result.skippedLines > 0) {
      new Notice(`Some messages could not be loaded (${result.skippedLines} corrupted)`);
    }

    const filteredSdkMessages = conversation.legacyCutoffAt != null
      ? result.messages.filter(msg => msg.timestamp > conversation.legacyCutoffAt!)
      : result.messages;
    const merged = this.dedupeMessages([
      ...conversation.messages,
      ...filteredSdkMessages,
    ]).sort((a, b) => a.timestamp - b.timestamp);

    conversation.messages = merged;
    conversation.sdkMessagesLoaded = true;
  }

  private dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
    const seen = new Set<string>();
    const result: ChatMessage[] = [];

    for (const message of messages) {
      // Use message.id as primary key - more reliable than content-based deduplication
      // especially for tool-only messages or messages with identical content
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      result.push(message);
    }

    return result;
  }

  /**
   * Creates a new conversation and sets it as active.
   *
   * New conversations always use SDK-native storage.
   * The session ID may be captured after the first SDK response.
   */
  async createConversation(sessionId?: string): Promise<Conversation> {
    const conversationId = sessionId ?? this.generateConversationId();
    const conversation: Conversation = {
      id: conversationId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      sdkSessionId: sessionId ?? undefined,
      messages: [],
      isNative: true,
    };

    this.conversations.unshift(conversation);
    // Session management is now per-tab in TabManager
    clearDiffState(); // Clear UI diff state (not SDK-related)

    // Save new conversation (metadata only - SDK handles messages)
    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );

    return conversation;
  }

  /**
   * Switches to an existing conversation by ID.
   *
   * For native sessions, loads messages from SDK storage if not already loaded.
   */
  async switchConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return null;

    await this.loadSdkMessagesForConversation(conversation);

    // Session management is now per-tab in TabManager
    clearDiffState(); // Clear UI diff state when switching conversations

    return conversation;
  }

  /**
   * Deletes a conversation and resets any tabs using it.
   *
   * For native sessions, deletes the metadata file.
   * For legacy sessions, deletes the JSONL file.
   * Note: SDK-stored messages in ~/.claude/projects/ are not deleted.
   */
  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.conversations.splice(index, 1);

    // Delete the appropriate storage file
    if (conversation.isNative) {
      // Native session: delete metadata file only
      // SDK messages in ~/.claude/projects/ are intentionally kept
      await this.storage.sessions.deleteMetadata(id);
    } else {
      // Legacy session: delete JSONL file
      await this.storage.sessions.deleteConversation(id);
    }

    // Notify all views/tabs that have this conversation open
    // They need to reset to a new conversation
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
          // Reset this tab to a new conversation
          tab.controllers.inputController?.cancelStreaming();
          await tab.controllers.conversationController?.createNew({ force: true });
        }
      }
    }
  }

  /** Renames a conversation. */
  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();

    if (conversation.isNative) {
      // Native session: save metadata only
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conversation)
      );
    } else {
      // Legacy session: save full JSONL
      await this.storage.sessions.saveConversation(conversation);
    }
  }

  /**
   * Updates conversation properties.
   *
   * For native sessions, saves metadata only (SDK handles messages including images).
   * For legacy sessions, saves full JSONL.
   *
   * Image data is cleared from memory after save (SDK/JSONL has persisted it).
   */
  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    Object.assign(conversation, updates, { updatedAt: Date.now() });

    if (conversation.isNative) {
      // Native session: save metadata only (SDK handles messages including images)
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conversation)
      );
    } else {
      // Legacy session: save full JSONL
      await this.storage.sessions.saveConversation(conversation);
    }

    // Clear image data from memory after save (data is persisted by SDK or JSONL)
    for (const msg of conversation.messages) {
      if (msg.images) {
        for (const img of msg.images) {
          img.data = '';
        }
      }
    }
  }

  /**
   * Gets a conversation by ID from the in-memory cache.
   *
   * For native sessions, loads messages from SDK storage if not already loaded.
   */
  async getConversationById(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id) || null;

    if (conversation) {
      await this.loadSdkMessagesForConversation(conversation);
    }

    return conversation;
  }

  /**
   * Gets a conversation by ID without loading SDK messages.
   * Use this for UI code that only needs metadata (title, etc.).
   */
  getConversationSync(id: string): Conversation | null {
    return this.conversations.find(c => c.id === id) || null;
  }

  /** Finds an existing empty conversation (no messages). */
  findEmptyConversation(): Conversation | null {
    return this.conversations.find(c => c.messages.length === 0) || null;
  }

  /** Returns conversation metadata list for the history dropdown. */
  getConversationList(): ConversationMeta[] {
    return this.conversations.map(c => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastResponseAt: c.lastResponseAt,
      messageCount: c.messages.length,
      preview: this.getConversationPreview(c),
      titleGenerationStatus: c.titleGenerationStatus,
      isNative: c.isNative,
    }));
  }

  /** Returns the active Claudian view from workspace, if open. */
  getView(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    if (leaves.length > 0) {
      return leaves[0].view as ClaudianView;
    }
    return null;
  }

  /** Returns all open Claudian views in the workspace. */
  getAllViews(): ClaudianView[] {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view as ClaudianView);
  }

  /**
   * Checks if a conversation is open in any Claudian view.
   * Returns the view and tab if found, null otherwise.
   */
  findConversationAcrossViews(conversationId: string): { view: ClaudianView; tabId: string } | null {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      const tabs = tabManager.getAllTabs();
      for (const tab of tabs) {
        if (tab.conversationId === conversationId) {
          return { view, tabId: tab.id };
        }
      }
    }
    return null;
  }
}
