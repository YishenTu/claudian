import type {
  TitleGenerationCallback,
  TitleGenerationResult,
  TitleGenerationService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class OpencodeTitleGenerationService implements TitleGenerationService {
  private plugin: ClaudianPlugin;
  private activeGenerations = new Map<string, AbortController>();

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const existing = this.activeGenerations.get(conversationId);
    if (existing) existing.abort();

    const abortController = new AbortController();
    this.activeGenerations.set(conversationId, abortController);

    try {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: 'OpenCode title generation not yet implemented',
      });
    } finally {
      this.activeGenerations.delete(conversationId);
    }
  }

  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  private async safeCallback(
    callback: TitleGenerationCallback,
    conversationId: string,
    result: TitleGenerationResult,
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Silently ignore callback errors
    }
  }
}
