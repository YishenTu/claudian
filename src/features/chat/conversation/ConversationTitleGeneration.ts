import { Notice } from 'obsidian';

import { getUserDisplayText } from '@/core/prompt/promptContext';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { TitleGenerationService } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { t } from '@/i18n/i18n';

export interface ConversationTitleGenerationDeps {
  host: Pick<ChatFeatureHost,
    'settings' | 'getConversationById' | 'renameConversation' | 'updateConversation' | 'completeConversationTitleGeneration'>;
  getService: () => TitleGenerationService | null;
  /** Observes stored title status changes, such as a session list that renders them. */
  onChanged?: () => void;
}

/** The first sentence of the first message, kept when generation is off or fails. */
export function fallbackConversationTitle(firstMessage: string): string {
  const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
  const autoTitle = firstSentence.substring(0, 50);
  const suffix = firstSentence.length > 50 ? '...' : '';
  return `${autoTitle}${suffix}`;
}

/**
 * Chat-owned title policy shared by a new Conversation's first turn and explicit regeneration.
 * Generation uses the global title-model selection, independently of chat execution.
 */
export class ConversationTitleGeneration {
  constructor(private readonly deps: ConversationTitleGenerationDeps) {}

  /** Names a new Conversation from its first user message, then generates a title in the background. */
  async titleFirstTurn(conversationId: string, firstUserMessage: ChatMessage): Promise<void> {
    const { host } = this.deps;
    const userContent = getUserDisplayText(firstUserMessage);
    const fallbackTitle = fallbackConversationTitle(userContent);
    await host.renameConversation(conversationId, fallbackTitle);

    if (!host.settings.enableAutoTitleGeneration
      || !ProviderRegistry.resolveTitleGenerationSelection(host.settings)) {
      return;
    }
    const service = this.deps.getService();
    if (!service) return;

    await this.#markPending(conversationId);
    // The turn does not wait for its title; a failed generation keeps the fallback.
    void this.#generate(service, conversationId, userContent, fallbackTitle).catch(() => undefined);
  }

  /** Regenerates a stored Conversation's title from its first user message. */
  async regenerate(conversationId: string): Promise<void> {
    const { host } = this.deps;
    if (!host.settings.enableAutoTitleGeneration) return;
    if (!ProviderRegistry.resolveTitleGenerationSelection(host.settings)) {
      new Notice(t('chat.selectAvailableTitleModel'));
      return;
    }

    const conversation = await host.getConversationById(conversationId);
    if (!conversation || conversation.messages.length < 1) return;
    const service = this.deps.getService();
    if (!service) return;
    const firstUserMessage = conversation.messages.find(message => message.role === 'user');
    if (!firstUserMessage) return;

    await this.#markPending(conversationId);
    await this.#generate(service, conversationId, getUserDisplayText(firstUserMessage), conversation.title);
  }

  async #markPending(conversationId: string): Promise<void> {
    await this.deps.host.updateConversation(conversationId, { titleGenerationStatus: 'pending' });
    this.deps.onChanged?.();
  }

  #generate(
    service: TitleGenerationService,
    conversationId: string,
    userContent: string,
    expectedTitle: string,
  ): Promise<void> {
    const { host } = this.deps;
    return service.generateTitle(conversationId, userContent, async (id, result) => {
      await host.completeConversationTitleGeneration(id, expectedTitle, result.success ? result.title : null);
      this.deps.onChanged?.();
    });
  }
}
