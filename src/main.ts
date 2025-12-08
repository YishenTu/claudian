import { Plugin, Notice } from 'obsidian';
import { ClaudianView } from './ClaudianView';
import { ClaudianService } from './ClaudianService';
import { ClaudianSettingTab } from './ClaudianSettings';
import {
  ClaudianSettings,
  DEFAULT_SETTINGS,
  VIEW_TYPE_CLAUDIAN,
  Conversation,
  ConversationMeta,
  DEFAULT_CLAUDE_MODELS,
} from './types';
import { getCurrentModelFromEnvironment, getModelsFromEnvironment, parseEnvironmentVariables } from './utils';
import { deleteCachedImages } from './imageCache';

export default class ClaudianPlugin extends Plugin {
  settings: ClaudianSettings;
  agentService: ClaudianService;
  private conversations: Conversation[] = [];
  private activeConversationId: string | null = null;
  // Runtime snapshot of env vars; only refreshed on plugin load (restart)
  private runtimeEnvironmentVariables = '';
  // Track if we've already notified about env var changes (to avoid spam)
  private hasNotifiedEnvChange = false;

  async onload() {
    await this.loadSettings();

    // Initialize agent service
    this.agentService = new ClaudianService(this);

    // Register the sidebar view
    this.registerView(
      VIEW_TYPE_CLAUDIAN,
      (leaf) => new ClaudianView(leaf, this)
    );

    // Add ribbon icon to open the view
    this.addRibbonIcon('bot', 'Open Claudian', () => {
      this.activateView();
    });

    // Add command to open view
    this.addCommand({
      id: 'open-claudian',
      name: 'Open Claudian',
      callback: () => {
        this.activateView();
      },
    });

    // Add settings tab
    this.addSettingTab(new ClaudianSettingTab(this.app, this));
  }

  onunload() {
    this.agentService.cleanup();
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      // Get the right leaf (sidebar)
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

  async loadSettings() {
    const data = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.conversations = data.conversations || [];
    this.activeConversationId = data.activeConversationId || null;

    // Validate active conversation still exists
    if (this.activeConversationId &&
        !this.conversations.find(c => c.id === this.activeConversationId)) {
      this.activeConversationId = null;
    }

    // Runtime env snapshot is fixed until plugin restart
    this.runtimeEnvironmentVariables = this.settings.environmentVariables || '';
    this.reconcileModelWithEnvironment(this.runtimeEnvironmentVariables);
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      conversations: this.conversations,
      activeConversationId: this.activeConversationId,
    });
  }

  async applyEnvironmentVariables(envText: string): Promise<void> {
    this.settings.environmentVariables = envText;
    await this.saveSettings();

    // Notify user if env vars changed from runtime snapshot (only once per change)
    if (envText !== this.runtimeEnvironmentVariables) {
      if (!this.hasNotifiedEnvChange) {
        new Notice('Environment variables changed. Restart the plugin for changes to take effect.');
        this.hasNotifiedEnvChange = true;
      }
    } else {
      // Reset notification flag when value matches runtime (no restart needed)
      this.hasNotifiedEnvChange = false;
    }
  }

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

  private reconcileModelWithEnvironment(envText: string): void {
    const envVars = parseEnvironmentVariables(envText || '');
    const customModels = getModelsFromEnvironment(envVars);

    if (customModels.length > 0) {
      // When switching to custom env: reset to priority order (ANTHROPIC_MODEL > opus > sonnet > haiku)
      this.settings.model = this.getPreferredCustomModel(envVars, customModels);
    } else {
      // When clearing env vars: reset to default haiku
      this.settings.model = DEFAULT_CLAUDE_MODELS[0].value;
    }
  }

  /**
   * Remove cached images associated with a conversation
   */
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

    // Skip files still referenced by other conversations
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

  /**
   * Generate a unique conversation ID
   */
  private generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Generate a default title with timestamp
   */
  private generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Get preview text from a conversation
   */
  private getConversationPreview(conv: Conversation): string {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return 'New conversation';
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  /**
   * Create a new conversation and set it as active
   */
  async createConversation(): Promise<Conversation> {
    const conversation: Conversation = {
      id: this.generateConversationId(),
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: null,
      messages: [],
    };

    // Add to front of list
    this.conversations.unshift(conversation);
    this.activeConversationId = conversation.id;

    // Reset agent service session
    this.agentService.resetSession();

    await this.saveSettings();
    return conversation;
  }

  /**
   * Switch to an existing conversation
   */
  async switchConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return null;

    this.activeConversationId = id;

    // Restore session ID to agent service
    this.agentService.setSessionId(conversation.sessionId);

    await this.saveSettings();
    return conversation;
  }

  /**
   * Delete a conversation
   */
  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.cleanupConversationImages(conversation);
    this.conversations.splice(index, 1);

    // If deleted active conversation, switch to newest or create new
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

  /**
   * Rename a conversation
   */
  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();
    await this.saveSettings();
  }

  /**
   * Update conversation (messages, sessionId, etc.)
   */
  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    Object.assign(conversation, updates, { updatedAt: Date.now() });
    await this.saveSettings();
  }

  /**
   * Get current active conversation
   */
  getActiveConversation(): Conversation | null {
    return this.conversations.find(c => c.id === this.activeConversationId) || null;
  }

  /**
   * Get conversation metadata list for dropdown
   */
  getConversationList(): ConversationMeta[] {
    return this.conversations.map(c => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      preview: this.getConversationPreview(c),
    }));
  }

  /**
   * Get the active Claudian view from workspace
   */
  getView(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    if (leaves.length > 0) {
      return leaves[0].view as ClaudianView;
    }
    return null;
  }
}
