/**
 * Claudian - Obsidian plugin entry point
 *
 * Registers the sidebar chat view, settings tab, and commands.
 * Manages conversation persistence and environment variable configuration.
 */

import type { Editor,MarkdownView } from 'obsidian';
import { Notice,Plugin } from 'obsidian';

import { ClaudianService } from './ClaudianService';
import { ClaudianSettingTab } from './ClaudianSettings';
import { ClaudianView } from './ClaudianView';
import { deleteCachedImages } from './images/imageCache';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta} from './types';
import {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_SETTINGS,
  VIEW_TYPE_CLAUDIAN,
} from './types';
import { type InlineEditContext,InlineEditModal } from './ui/InlineEditModal';
import { buildCursorContext } from './utils';
import { getCurrentModelFromEnvironment, getModelsFromEnvironment, parseEnvironmentVariables } from './utils';

/**
 * Main plugin class for Claudian.
 * Handles plugin lifecycle, settings persistence, and conversation management.
 */
export default class ClaudianPlugin extends Plugin {
  settings: ClaudianSettings;
  agentService: ClaudianService;
  private conversations: Conversation[] = [];
  private activeConversationId: string | null = null;
  private runtimeEnvironmentVariables = '';
  private hasNotifiedEnvChange = false;

  async onload() {
    await this.loadSettings();

    this.agentService = new ClaudianService(this);

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
    const data = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.conversations = data.conversations || [];
    this.activeConversationId = data.activeConversationId || null;

    if (this.activeConversationId &&
        !this.conversations.find(c => c.id === this.activeConversationId)) {
      this.activeConversationId = null;
    }

    const backfilled = this.backfillConversationResponseTimestamps();

    this.runtimeEnvironmentVariables = this.settings.environmentVariables || '';
    const modelReset = this.reconcileModelWithEnvironment(this.runtimeEnvironmentVariables);

    if (modelReset || backfilled) {
      await this.saveSettings();
    }
  }

  private backfillConversationResponseTimestamps(): boolean {
    let updated = false;
    for (const conv of this.conversations) {
      if (conv.lastResponseAt != null) continue;
      if (!conv.messages || conv.messages.length === 0) continue;

      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg.role === 'assistant') {
          conv.lastResponseAt = msg.timestamp;
          updated = true;
          break;
        }
      }
    }
    return updated;
  }

  /** Persists settings and conversations to storage. */
  async saveSettings() {
    await this.saveData({
      ...this.settings,
      conversations: this.conversations,
      activeConversationId: this.activeConversationId,
    });
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

  /** Computes a hash of model-related environment variables for change detection. */
  private computeEnvHash(envText: string): string {
    const envVars = parseEnvironmentVariables(envText || '');
    const modelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ];
    const relevantPairs = modelKeys
      .filter(key => envVars[key])
      .map(key => `${key}=${envVars[key]}`)
      .sort()
      .join('|');
    return relevantPairs;
  }

  /** Reconciles model with environment. Returns true if model was reset. */
  private reconcileModelWithEnvironment(envText: string): boolean {
    const currentHash = this.computeEnvHash(envText);
    const savedHash = this.settings.lastEnvHash || '';

    if (currentHash === savedHash) {
      return false;
    }

    const envVars = parseEnvironmentVariables(envText || '');
    const customModels = getModelsFromEnvironment(envVars);

    if (customModels.length > 0) {
      this.settings.model = this.getPreferredCustomModel(envVars, customModels);
    } else {
      this.settings.model = DEFAULT_CLAUDE_MODELS[0].value;
    }

    this.settings.lastEnvHash = currentHash;
    return true;
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

    await this.saveSettings();
    return conversation;
  }

  /** Switches to an existing conversation by ID. */
  async switchConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return null;

    this.activeConversationId = id;
    this.agentService.setSessionId(conversation.sessionId);

    await this.saveSettings();
    return conversation;
  }

  /** Deletes a conversation and switches to another if necessary. */
  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.cleanupConversationImages(conversation);
    this.conversations.splice(index, 1);

    if (this.activeConversationId === id) {
      if (this.conversations.length > 0) {
        await this.switchConversation(this.conversations[0].id);
      } else {
        await this.createConversation();
      }
    } else {
      await this.saveSettings();
    }
  }

  /** Renames a conversation. */
  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();
    await this.saveSettings();
  }

  /** Updates conversation properties (messages, sessionId, etc.). */
  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    Object.assign(conversation, updates, { updatedAt: Date.now() });
    await this.saveSettings();
  }

  /** Returns the current active conversation. */
  getActiveConversation(): Conversation | null {
    return this.conversations.find(c => c.id === this.activeConversationId) || null;
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
