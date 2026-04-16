import type { TitleGenerationService } from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

/**
 * ACP title generation service (stub for MVP).
 * In a full implementation, this would use a separate ACP agent process.
 */
export class AcpTitleGenerationService implements TitleGenerationService {
  constructor(private readonly plugin: ClaudianPlugin) {}

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: (conversationId: string, result: { success: true; title: string } | { success: false; error: string }) => Promise<void>,
  ): Promise<void> {
    // For MVP, just use the first N characters of the user message
    const title = userMessage.slice(0, 50).trim() + (userMessage.length > 50 ? '...' : '');
    await callback(conversationId, { success: true, title });
  }

  cancel(): void {
    // No-op in MVP
  }
}
