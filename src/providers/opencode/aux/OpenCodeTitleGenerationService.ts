import type { TitleGenerationService} from '../../../core/providers/types';
import { type TitleGenerationCallback } from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class OpenCodeTitleGenerationService implements TitleGenerationService {
  constructor(private plugin: ClaudianPlugin) {}

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void> {
    try {
      // Simple title generation based on user message
      // In the future, this could call OpenCode's LLM API
      const title = userMessage.substring(0, 50).trim() || 'New conversation';
      
      await callback(conversationId, {
        success: true,
        title,
      });
    } catch (error) {
      await callback(conversationId, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  cancel(): void {
    // No cancellation needed for simple title generation
  }
}
