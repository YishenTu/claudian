import type {
  TitleGenerationCallback,
  TitleGenerationResult,
  TitleGenerationService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class OctoAgentTitleGenerationService implements TitleGenerationService {
  constructor(_plugin: ClaudianPlugin) {}

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
  }

  cancel(): void {
    // No-op.
  }
}
