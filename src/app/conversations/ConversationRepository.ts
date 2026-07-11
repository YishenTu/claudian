import { normalizeProviderModelSelection, resolveConversationModel } from '../../core/providers/conversationModel';
import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { AppSessionStorage } from '../../core/providers/types';
import { DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '../../core/providers/types';
import type { Conversation, ConversationMeta } from '../../core/types';
import { extractUserDisplayContent } from '../../utils/context';

export interface ConversationRepositoryDeps {
  getSettings: () => Record<string, unknown>;
  getVaultPath: () => string | null;
  sessions: AppSessionStorage;
  onConversationDeleted: (conversationId: string) => Promise<void>;
}

export class ConversationRepository {
  private conversations: Conversation[] = [];

  constructor(private readonly deps: ConversationRepositoryDeps) {}

  replaceAll(conversations: Conversation[]): void {
    this.conversations = conversations;
  }

  getAll(): Conversation[] {
    return this.conversations;
  }

  backfillResponseTimestamps(): Conversation[] {
    const updated: Conversation[] = [];
    for (const conversation of this.conversations) {
      if (conversation.lastResponseAt != null || conversation.messages.length === 0) {
        continue;
      }

      for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
        const message = conversation.messages[index];
        if (message.role === 'assistant') {
          conversation.lastResponseAt = message.timestamp;
          updated.push(conversation);
          break;
        }
      }
    }
    return updated;
  }

  async create(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
  }): Promise<Conversation> {
    const settings = this.deps.getSettings();
    const providerId = options?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    const sessionId = options?.sessionId;
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, providerId);
    const selectedModel = normalizeProviderModelSelection(
      providerId,
      settings,
      options?.selectedModel ?? providerSettings.model,
    ) ?? undefined;
    const conversation: Conversation = {
      id: sessionId ?? this.generateId(),
      providerId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      selectedModel,
      messages: [],
    };

    this.conversations.unshift(conversation);
    await this.save(conversation);
    return conversation;
  }

  async switchTo(id: string): Promise<Conversation | null> {
    const conversation = this.getSync(id);
    if (!conversation) return null;

    await this.reconcileProviderSession(conversation);
    await this.ensureSelectedModel(conversation);
    await this.hydrate(conversation);
    return conversation;
  }

  async delete(
    id: string,
    options: { deleteProviderSession?: boolean } = {},
  ): Promise<void> {
    const index = this.conversations.findIndex(conversation => conversation.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.conversations.splice(index, 1);

    if (options.deleteProviderSession !== false) {
      await ProviderRegistry
        .getConversationHistoryService(conversation.providerId)
        .deleteConversationSession(conversation, this.deps.getVaultPath());
    }

    await this.deps.sessions.deleteMetadata(id);
    await this.deps.onConversationDeleted(id);
  }

  async handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'> {
    const conversation = this.getSync(id);
    if (!conversation) return 'not_found';

    const historyService = ProviderRegistry.getConversationHistoryService(conversation.providerId);
    if (!historyService.resolveMissingConversationSession) return 'preserved';

    const previousSessionId = conversation.sessionId;
    const previousProviderState = conversation.providerState;
    const previousResumeAtMessageId = conversation.resumeAtMessageId;
    try {
      const resolution = await historyService.resolveMissingConversationSession(
        conversation,
        this.deps.getVaultPath(),
        missingProviderSessionId,
      );
      if (resolution === 'delete') {
        await this.delete(id, { deleteProviderSession: false });
        return 'deleted';
      }
      if (resolution === 'reset') {
        await this.save(conversation);
        return 'reset';
      }
      return 'preserved';
    } catch {
      conversation.sessionId = previousSessionId;
      conversation.providerState = previousProviderState;
      conversation.resumeAtMessageId = previousResumeAtMessageId;
      return 'preserved';
    }
  }

  async rename(id: string, title: string): Promise<void> {
    const conversation = this.getSync(id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();
    await this.save(conversation);
  }

  async update(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.getSync(id);
    if (!conversation) return;

    const safeUpdates = { ...updates };
    delete safeUpdates.providerId;
    if ('selectedModel' in safeUpdates) {
      const selectedModel = normalizeProviderModelSelection(
        conversation.providerId,
        this.deps.getSettings(),
        safeUpdates.selectedModel,
      );
      if (selectedModel) {
        safeUpdates.selectedModel = selectedModel;
      } else {
        delete safeUpdates.selectedModel;
      }
    }
    Object.assign(conversation, safeUpdates, { updatedAt: Date.now() });
    await this.save(conversation);
  }

  async getById(id: string): Promise<Conversation | null> {
    const conversation = this.getSync(id);
    if (conversation) {
      await this.reconcileProviderSession(conversation);
      await this.ensureSelectedModel(conversation);
      await this.hydrate(conversation);
    }
    return conversation;
  }

  getSync(id: string): Conversation | null {
    return this.conversations.find(conversation => conversation.id === id) ?? null;
  }

  findEmpty(): Conversation | null {
    return this.conversations.find(conversation => conversation.messages.length === 0) ?? null;
  }

  list(): ConversationMeta[] {
    return this.conversations.map(conversation => ({
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      messageCount: conversation.messages.length,
      preview: this.getPreview(conversation),
      titleGenerationStatus: conversation.titleGenerationStatus,
    }));
  }

  private async reconcileProviderSession(conversation: Conversation): Promise<void> {
    const historyService = ProviderRegistry.getConversationHistoryService(conversation.providerId);
    if (!historyService.getConversationSessionAvailability) return;

    let availability;
    try {
      availability = await historyService.getConversationSessionAvailability(
        conversation,
        this.deps.getVaultPath(),
      );
    } catch {
      return;
    }
    if (availability !== 'relocated' || !historyService.prepareRelocatedConversationSession) return;

    const previousSessionId = conversation.sessionId;
    const previousProviderState = conversation.providerState;
    const previousResumeAtMessageId = conversation.resumeAtMessageId;
    try {
      if (await historyService.prepareRelocatedConversationSession(conversation, this.deps.getVaultPath())) {
        await this.save(conversation);
      }
    } catch {
      conversation.sessionId = previousSessionId;
      conversation.providerState = previousProviderState;
      conversation.resumeAtMessageId = previousResumeAtMessageId;
    }
  }

  private async ensureSelectedModel(conversation: Conversation): Promise<void> {
    const resolved = resolveConversationModel(
      this.deps.getSettings(),
      conversation.providerId,
      conversation,
    );
    if (!resolved.shouldPersist || !resolved.model || conversation.selectedModel === resolved.model) return;

    conversation.selectedModel = resolved.model;
    await this.save(conversation);
  }

  private async hydrate(conversation: Conversation): Promise<void> {
    const settings = this.deps.getSettings();
    await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .hydrateConversationHistory(conversation, this.deps.getVaultPath(), {
        environment: {
          ...process.env,
          ...getRuntimeEnvironmentVariables(settings, conversation.providerId),
        },
      });
  }

  private save(conversation: Conversation): Promise<void> {
    return this.deps.sessions.saveMetadata(this.deps.sessions.toSessionMetadata(conversation));
  }

  private generateId(): string {
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

  private getPreview(conversation: Conversation): string {
    const firstUserMessage = conversation.messages.find(message => message.role === 'user');
    if (!firstUserMessage) return 'New conversation';

    const previewText = firstUserMessage.displayContent
      ?? extractUserDisplayContent(firstUserMessage.content)
      ?? firstUserMessage.content;
    return previewText.substring(0, 50) + (previewText.length > 50 ? '...' : '');
  }
}
