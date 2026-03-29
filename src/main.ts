/**
 * Claudian - Obsidian plugin entry point
 *
 * Registers the sidebar chat view, settings tab, and commands.
 * Manages conversation persistence and environment variable configuration.
 */

// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import type { Editor, MarkdownView } from 'obsidian';
import { Notice, Plugin } from 'obsidian';

import { DEFAULT_CLAUDIAN_SETTINGS } from './core/bootstrap/defaultSettings';
import type { SharedAppStorage } from './core/bootstrap/storage';
import { ProviderRegistry } from './core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from './core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from './core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from './core/providers/types';
import { DEFAULT_CHAT_PROVIDER_ID } from './core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
} from './core/types';
import {
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import { ClaudianView } from './features/chat/ClaudianView';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n/i18n';
import type { Locale } from './i18n/types';
import {
  type ClaudeStorageService,
  createClaudeStorage,
  maybeGetClaudeWorkspaceServices,
} from './providers/claude/app/ClaudeWorkspaceServices';
import { resolveCodexCliPath } from './providers/codex/runtime/CodexBinaryLocator';
import { buildCursorContext } from './utils/editor';
import { getHostnameKey } from './utils/env';
import { getVaultPath } from './utils/path';

/**
 * Main plugin class for Claudian.
 * Handles plugin lifecycle, settings persistence, and conversation management.
 */
export default class ClaudianPlugin extends Plugin {
  settings: ClaudianSettings;
  storage: SharedAppStorage;
  claudeStorage: ClaudeStorageService;
  private conversations: Conversation[] = [];
  private runtimeEnvironmentVariables = '';

  async onload() {
    await this.loadSettings();
    await ProviderWorkspaceRegistry.initializeAll(this);

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
          editContext = { mode: 'selection', selectedText };
        } else {
          const cursor = editor.getCursor();
          const cursorContext = buildCursorContext(
            (line) => editor.getLine(line),
            editor.lineCount(),
            cursor.line,
            cursor.ch
          );
          editContext = { mode: 'cursor', cursorContext };
        }

        const modal = new InlineEditModal(
          this.app,
          this,
          editor,
          view,
          editContext,
          notePath,
          () => this.getView()?.getActiveTab()?.ui.externalContextSelector?.getExternalContexts() ?? []
        );
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
    // Ensures state is saved even if Obsidian quits without calling onClose()
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const state = tabManager.getPersistedState();
        await this.storage.setTabManagerState(state);
      }
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      const newLeaf = this.settings.openInMainTab
        ? workspace.getLeaf('tab')
        : workspace.getRightLeaf(false);
      if (newLeaf) {
        await newLeaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
        leaf = newLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /** Loads settings and conversations from persistent storage. */
  async loadSettings() {
    // Initialize Claude storage
    this.claudeStorage = createClaudeStorage(this);
    // The shared app storage is backed by the same StorageService instance
    this.storage = this.claudeStorage;

    const { claudian } = await this.storage.initialize();

    this.settings = {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      ...claudian,
    } as ClaudianSettings;

    // Plan mode is ephemeral — normalize back to normal on load so the app
    // doesn't start stuck in plan mode after a restart (prePlanPermissionMode is lost)
    if (this.settings.permissionMode === 'plan') {
      this.settings.permissionMode = 'normal';
    }

    const didNormalizeProviderSelection = ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings as unknown as Record<string, unknown>,
    );
    const didNormalizeModelVariants = this.normalizeModelVariantSettings();

    // Load all conversations from session metadata
    const allMetadata = await this.storage.sessions.listMetadata();
    this.conversations = allMetadata.map(meta => {
      const resumeSessionId = meta.sessionId !== undefined ? meta.sessionId : meta.id;

      return {
        id: meta.id,
        providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lastResponseAt: meta.lastResponseAt,
        sessionId: resumeSessionId,
        providerState: meta.providerState,
        messages: [], // Messages are in SDK storage, loaded on demand
        currentNote: meta.currentNote,
        externalContextPaths: meta.externalContextPaths,
        enabledMcpServers: meta.enabledMcpServers,
        usage: meta.usage,
        titleGenerationStatus: meta.titleGenerationStatus,
        resumeAtMessageId: meta.resumeAtMessageId,
      };
    }).sort(
      (a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt)
    );
    setLocale(this.settings.locale as Locale);

    const backfilledConversations = this.backfillConversationResponseTimestamps();

    this.runtimeEnvironmentVariables = this.settings.environmentVariables || '';
    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(this.runtimeEnvironmentVariables);

    // Project the active provider's saved model/effort/budget into top-level fields.
    // Runs unconditionally — it's a no-op when savedProvider* maps are empty.
    ProviderSettingsCoordinator.projectActiveProviderState(
      this.settings as unknown as Record<string, unknown>,
    );

    if (changed || didNormalizeModelVariants || didNormalizeProviderSelection) {
      await this.saveSettings();
    }

    // Persist backfilled and invalidated conversations
    const conversationsToSave = new Set([...backfilledConversations, ...invalidatedConversations]);
    for (const conv of conversationsToSave) {
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conv)
      );
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

  normalizeModelVariantSettings(): boolean {
    return ProviderSettingsCoordinator.normalizeAllModelVariants(
      this.settings as unknown as Record<string, unknown>,
    );
  }

  /** Persists settings to storage. */
  async saveSettings() {
    ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings as unknown as Record<string, unknown>,
    );
    ProviderSettingsCoordinator.persistProjectedProviderState(
      this.settings as unknown as Record<string, unknown>,
    );

    await this.storage.saveClaudianSettings(this.settings);
  }

  /** Updates and persists environment variables, restarting processes to apply changes. */
  async applyEnvironmentVariables(envText: string): Promise<void> {
    const envChanged = envText !== this.runtimeEnvironmentVariables;

    this.settings.environmentVariables = envText;

    if (!envChanged) {
      await this.saveSettings();
      return;
    }

    // Update runtime env vars so new processes use them
    this.runtimeEnvironmentVariables = envText;

    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(envText);
    await this.saveSettings();

    if (invalidatedConversations.length > 0) {
      for (const conv of invalidatedConversations) {
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conv)
        );
      }
    }

    const view = this.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      for (const tab of tabManager.getAllTabs()) {
        if (tab.state.isStreaming) {
          tab.controllers.inputController?.cancelStreaming();
        }
      }

      let failedTabs = 0;
      if (changed) {
        for (const tab of tabManager.getAllTabs()) {
          if (!tab.service || !tab.serviceInitialized) {
            continue;
          }
          try {
            const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts() ?? [];
            tab.service.resetSession();
            await tab.service.ensureReady({ externalContextPaths });
          } catch {
            failedTabs++;
          }
        }
      } else {
        // Restart initialized tabs to pick up env changes
        try {
          await tabManager.broadcastToAllTabs(
            async (service) => { await service.ensureReady({ force: true }); }
          );
        } catch {
          failedTabs++;
        }
      }
      if (failedTabs > 0) {
        new Notice(`Environment changes applied, but ${failedTabs} tab(s) failed to restart.`);
      }
    }

    view?.refreshModelSelector();

    const noticeText = changed
      ? 'Environment variables applied. Sessions will be rebuilt on next message.'
      : 'Environment variables applied.';
    new Notice(noticeText);
  }

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(): string {
    return this.runtimeEnvironmentVariables;
  }

  getResolvedClaudeCliPath(): string | null {
    const cliResolver = maybeGetClaudeWorkspaceServices()?.cliResolver;
    if (!cliResolver) {
      return null;
    }

    return cliResolver.resolve(
      this.settings.claudeCliPathsByHost,  // Per-device paths (preferred)
      this.settings.claudeCliPath,          // Legacy path (fallback)
      this.getActiveEnvironmentVariables()
    );
  }

  getResolvedCodexCliPath(): string | null {
    const hostname = getHostnameKey();
    return resolveCodexCliPath(
      this.settings.codexCliPathsByHost?.[hostname],
      this.settings.codexCliPath,
      this.getActiveEnvironmentVariables(),
    );
  }

  private reconcileModelWithEnvironment(envText: string): {
    changed: boolean;
    invalidatedConversations: Conversation[];
  } {
    return ProviderSettingsCoordinator.reconcileAllProviders(
      this.settings as unknown as Record<string, unknown>,
      this.conversations,
      envText,
    );
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
      return 'New conversation';
    }
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  private async loadSdkMessagesForConversation(conversation: Conversation): Promise<void> {
    await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .hydrateConversationHistory(conversation, getVaultPath(this.app));
  }

  /**
   * Creates a new conversation and sets it as active.
   *
   * New conversations always use SDK-native storage.
   * The session ID may be captured after the first SDK response.
   */
  async createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
  }): Promise<Conversation> {
    const providerId = options?.providerId ?? 'claude' as ProviderId;
    const sessionId = options?.sessionId;
    const conversationId = sessionId ?? this.generateConversationId();
    const conversation: Conversation = {
      id: conversationId,
      providerId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      messages: [],
    };

    this.conversations.unshift(conversation);
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

    return conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.conversations.splice(index, 1);

    await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .deleteConversationSession(conversation, getVaultPath(this.app));

    await this.storage.sessions.deleteMetadata(id);

    // Notify all views/tabs that have this conversation open
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
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

    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    // providerId is immutable — strip it from updates to prevent accidental mutation
    const { providerId: _, ...safeUpdates } = updates;
    Object.assign(conversation, safeUpdates, { updatedAt: Date.now() });

    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );

    // Clear image data from memory after save (data is persisted by SDK).
    // Skip for pending forks: their deep-cloned images aren't in SDK storage yet.
    if (!ProviderRegistry.getConversationHistoryService(conversation.providerId).isPendingForkConversation(conversation)) {
      for (const msg of conversation.messages) {
        if (msg.images) {
          for (const img of msg.images) {
            img.data = '';
          }
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
      providerId: c.providerId,
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
