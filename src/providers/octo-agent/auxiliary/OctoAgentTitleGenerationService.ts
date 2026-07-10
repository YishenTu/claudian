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

    if (result.success) {
      await this.syncTitleToOctoAgent(conversationId, result.title);
    }

    await callback(conversationId, result);
  }

  private async syncTitleToOctoAgent(conversationId: string, title: string): Promise<void> {
    try {
      const conversation = await this.plugin.getConversationById(conversationId);
      if (!conversation || conversation.providerId !== 'octo-agent' || !conversation.sessionId) {
        return;
      }

      const settings = getOctoAgentProviderSettings(this.plugin.settings as unknown as Record<string, unknown>);
      const client = new OctoAgentClient({
        baseUrl: `http://${settings.host}:${settings.port}`,
        accessKey: settings.accessKey || undefined,
      });
      await client.renameSession(conversation.sessionId, title);
    } catch (error) {
      console.error('Failed to sync title to octo-agent:', error);
    }
  }

  cancel(): void {
    // No-op.
  }
}
