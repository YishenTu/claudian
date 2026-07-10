import type {
  TitleGenerationCallback,
  TitleGenerationResult,
  TitleGenerationService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { OctoAgentClient } from '../runtime/OctoAgentClient';
import { getOctoAgentProviderSettings } from '../settings';

export class OctoAgentTitleGenerationService implements TitleGenerationService {
  constructor(private readonly plugin: ClaudianPlugin) {}

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const trimmed = userMessage.trim();
    const title = trimmed.length > 40 ? `${trimmed.slice(0, 37).trimEnd()}...` : trimmed;
    const result: TitleGenerationResult = title
      ? { success: true, title }
      : { success: false, error: 'Empty user message' };

    await callback(conversationId, result);

    // Sync after the callback has applied the title locally. At this point the
    // octo-agent session id has been persisted by the runtime's buildSessionUpdates.
    if (result.success) {
      await this.syncTitleToOctoAgent(conversationId, result.title);
    }
  }

  private async syncTitleToOctoAgent(conversationId: string, title: string): Promise<void> {
    try {
      const conversation = await this.plugin.getConversationById(conversationId);
      if (!conversation || conversation.providerId !== 'octo-agent') {
        return;
      }

      // Only sync if the generated title was actually applied locally. If the
      // user manually renamed the conversation in the meantime, leave octo
      // with whatever the local title will be (the manual rename path is
      // responsible for syncing that change).
      if (conversation.title !== title) {
        return;
      }

      const sessionId =
        conversation.sessionId
        ?? ((conversation.providerState as Record<string, unknown> | undefined)?.sessionId as string | undefined);
      if (!sessionId) {
        return;
      }

      const settings = getOctoAgentProviderSettings(this.plugin.settings as unknown as Record<string, unknown>);
      const client = new OctoAgentClient({
        baseUrl: `http://${settings.host}:${settings.port}`,
        accessKey: settings.accessKey || undefined,
      });
      await client.renameSession(sessionId, title);
    } catch (error) {
      console.error('Failed to sync title to octo-agent:', error);
    }
  }

  cancel(): void {
    // No-op.
  }
}
