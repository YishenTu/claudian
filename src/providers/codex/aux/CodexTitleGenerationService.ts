import type {
  TitleGenerationCallback,
  TitleGenerationService,
} from '../../../core/providers/types';

export class CodexTitleGenerationService implements TitleGenerationService {
  async generateTitle(
    conversationId: string,
    _userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    await callback(conversationId, {
      success: false,
      error: 'Codex does not support title generation',
    });
  }

  cancel(): void {
    // No-op
  }
}
