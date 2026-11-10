import type { ProviderSessionReference } from '@/core/execution/ProviderExecutionRequest';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { findComposerSessionMentions } from '@/features/chat/composer/composerSessionMentions';

/** Mentions become id references; the agent reads the session itself with the read-session tool. */
export async function resolveSessionMentions(
  host: ChatFeatureHost,
  text: string,
  signal: AbortSignal,
): Promise<{ text: string; references: ProviderSessionReference[] }> {
  const mentions = findComposerSessionMentions(text);
  const references = new Map<string, ProviderSessionReference>();
  for (const mention of mentions) {
    if (references.has(mention.conversationId)) continue;
    try {
      signal.throwIfAborted();
      const conversation = await host.getConversationById(mention.conversationId);
      signal.throwIfAborted();
      if (!conversation || !conversation.messages.length) throw new Error('History is unavailable');
      references.set(conversation.id, {
        id: conversation.id, title: conversation.title, providerId: conversation.providerId,
        updatedAt: new Date(conversation.lastActivityAt).toISOString(),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Could not mention session "${mention.title}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  let rewritten = text;
  for (const mention of [...mentions].reverse()) {
    const title = references.get(mention.conversationId)!.title;
    rewritten = rewritten.slice(0, mention.index) + `@"${title}"` + rewritten.slice(mention.index + mention.fullMatch.length);
  }
  return { text: rewritten, references: [...references.values()] };
}
