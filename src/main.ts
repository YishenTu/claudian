/**
 * Claudian - Obsidian plugin entry point
 *
 * Registers the sidebar chat view, settings tab, and commands.
 * Manages conversation persistence and environment variable configuration.
 */

import type { Editor,MarkdownView } from 'obsidian';
import { Notice,Plugin } from 'obsidian';

import { ClaudianService } from './core/agent';
import { clearDiffState } from './core/hooks';
import { deleteCachedImages } from './core/images/imageCache';
import { McpServerManager } from './core/mcp';
import { McpService } from './core/mcp/McpService';
import { StorageService } from './core/storage';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta} from './core/types';
import {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_SETTINGS,
  getCliPlatformKey,
  getDefaultCliPaths,
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import { ClaudianView } from './features/chat/ClaudianView';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n';
import { ClaudeCliResolver } from './utils/claudeCli';
import { buildCursorContext } from './utils/editor';
import { getCurrentModelFromEnvironment, getModelsFromEnvironment, parseEnvironmentVariables } from './utils/env';

/**
 * Main plugin class for Claudian.
 * Handles plugin lifecycle, settings persistence, and conversation management.
 */
export default class ClaudianPlugin extends Plugin {
  settings: ClaudianSettings;
  agentService: ClaudianService;
  mcpService: McpService;
  storage: StorageService;
  cliResolver: ClaudeCliResolver;
  private conversations: Conversation[] = [];
  private activeConversationId: string | null = null;
  private runtimeEnvironmentVariables = '';
  private hasNotifiedEnvChange = false;

  async onload() {
    await this.loadSettings();

    this.cliResolver = new ClaudeCliResolver();

    // Initialize MCP service first (shared manager for agent + UI)
    const mcpManager = new McpServerManager(this.storage.mcp);
    this.mcpService = new McpService(mcpManager);
    await this.mcpService.loadServers();

    // Initialize agent service with the MCP manager
    this.agentService = new ClaudianService(this, mcpManager);

    // Load CC permissions into the agent service
    await this.agentService.loadCCPermissions();

    // Pre-warm the persistent query with the active conversation's session ID (Phase 5)
    const activeConv = this.getActiveConversation();
    const sessionId = activeConv?.sessionId;
    this.agentService.preWarm(sessionId ?? undefined).catch((error) => {
      console.warn('[Claudian] Pre-warm failed, first query will use cold-start:',
        error instanceof Error ? error.message : String(error));
    });

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

    this.addSettingTab(new ClaudianSettingTab(this.app, this));
  }

  onunload() {
    this.agentService.cleanup();
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
    // Note: claudian already contains state fields (activeConversationId, lastEnvHash, etc.)
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...claudian,
      slashCommands,
    };

    this.settings.claudeCliPaths = {
      ...getDefaultCliPaths(),
      ...(this.settings.claudeCliPaths ?? {}),
    };

    // Migrate legacy claudeCliPath to platform-specific claudeCliPaths
    let didMigrateCliPath = false;
    if (this.settings.claudeCliPath && !this.hasAnyPlatformCliPath()) {
      const currentPlatformKey = getCliPlatformKey();
      this.settings.claudeCliPaths[currentPlatformKey] = this.settings.claudeCliPath.trim();
      // Keep legacy field as fallback for downgrade compatibility
      didMigrateCliPath = true;
    }

    // Load all conversations from session files
    this.conversations = await this.storage.sessions.loadAllConversations();
    this.activeConversationId = claudian.activeConversationId;

    // Validate active conversation exists
    if (this.activeConversationId &&
        !this.conversations.find(c => c.id === this.activeConversationId)) {
      this.activeConversationId = null;
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
      await this.storage.sessions.saveConversation(conv);
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

    // Update activeConversationId from plugin state
    settingsToSave.activeConversationId = this.activeConversationId;

    await this.storage.saveClaudianSettings(settingsToSave);
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
      this.settings.claudeCliPaths,
      this.settings.claudeCliPath,  // Legacy fallback
      this.getActiveEnvironmentVariables()
    );
  }

  private hasAnyPlatformCliPath(): boolean {
    const paths = this.settings.claudeCliPaths;
    return !!(paths?.macos || paths?.linux || paths?.windows);
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
    // Invalidate session so next query rebuilds full context from history.
    // Note: agentService may not exist yet during initial plugin load.
    this.agentService?.resetSession();
    clearDiffState(); // Clear UI diff state (not SDK-related)

    // Clear sessionId from all conversations since they belong to the old provider.
    // Sessions are provider-specific (contain signed thinking blocks, etc.).
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

  /** Removes cached images associated with a conversation if not used elsewhere. */
  private cleanupConversationImages(conversation: Conversation): void {
    const cachePaths = new Set<string>();

    for (const message of conversation.messages || []) {
      if (!message.images) continue;
      for (const img of message.images) {
        if (img.cachePath) {
          cachePaths.add(img.cachePath);
        }
      }
    }

    if (cachePaths.size === 0) return;

    const inUseElsewhere = new Set<string>();
    for (const conv of this.conversations) {
      if (conv.id === conversation.id) continue;
      for (const msg of conv.messages || []) {
        if (!msg.images) continue;
        for (const img of msg.images) {
          if (img.cachePath && cachePaths.has(img.cachePath)) {
            inUseElsewhere.add(img.cachePath);
          }
        }
      }
    }

    const deletable = Array.from(cachePaths).filter(p => !inUseElsewhere.has(p));
    if (deletable.length > 0) {
      deleteCachedImages(this.app, deletable);
    }
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
    if (!firstUserMsg) return 'New conversation';
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  /** Creates a new conversation and sets it as active. */
  async createConversation(): Promise<Conversation> {
    const conversation: Conversation = {
      id: this.generateConversationId(),
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: null,
      messages: [],
    };

    this.conversations.unshift(conversation);
    this.activeConversationId = conversation.id;
    this.agentService.resetSession();
    clearDiffState(); // Clear UI diff state (not SDK-related)

    // Save new conversation to session file
    await this.storage.sessions.saveConversation(conversation);
    await this.storage.setActiveConversationId(this.activeConversationId);

    return conversation;
  }

  /** Switches to an existing conversation by ID. */
  async switchConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return null;

    this.activeConversationId = id;
    this.agentService.setSessionId(conversation.sessionId);
    clearDiffState(); // Clear UI diff state when switching conversations

    await this.storage.setActiveConversationId(this.activeConversationId);
    return conversation;
  }

  /** Deletes a conversation and switches to another if necessary. */
  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.cleanupConversationImages(conversation);
    this.conversations.splice(index, 1);

    // Delete the session file
    await this.storage.sessions.deleteConversation(id);

    if (this.activeConversationId === id) {
      if (this.conversations.length > 0) {
        await this.switchConversation(this.conversations[0].id);
      } else {
        await this.createConversation();
      }
    }
  }

  /** Renames a conversation. */
  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();
    await this.storage.sessions.saveConversation(conversation);
  }

  /** Updates conversation properties (messages, sessionId, etc.). */
  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    Object.assign(conversation, updates, { updatedAt: Date.now() });
    await this.storage.sessions.saveConversation(conversation);
  }

  /** Returns the current active conversation. */
  getActiveConversation(): Conversation | null {
    return this.conversations.find(c => c.id === this.activeConversationId) || null;
  }

  /** Gets a conversation by ID from the in-memory cache. */
  getConversationById(id: string): Conversation | null {
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
}
