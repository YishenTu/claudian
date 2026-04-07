import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../../core/prompt/titleGeneration';
import type {
  TitleGenerationCallback,
  TitleGenerationResult,
  TitleGenerationService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { CodexAuxQueryRunner } from '../runtime/CodexAuxQueryRunner';

export class CodexTitleGenerationService implements TitleGenerationService {
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

    const truncated = userMessage.length > 500
      ? userMessage.substring(0, 500) + '...'
      : userMessage;
    const prompt = `User's request:\n"""\n${truncated}\n"""\n\nGenerate a title for this conversation:`;

    const runner = new CodexAuxQueryRunner(this.plugin);

    try {
      const text = await runner.query({
        systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
        model: this.resolveTitleModel(),
        abortController,
      }, prompt);

      const title = this.parseTitle(text);
      if (title) {
        await this.safeCallback(callback, conversationId, { success: true, title });
      } else {
        await this.safeCallback(callback, conversationId, {
          success: false,
          error: 'Failed to parse title from response',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await this.safeCallback(callback, conversationId, { success: false, error: msg });
    } finally {
      runner.reset();
      this.activeGenerations.delete(conversationId);
    }
  }

  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  private resolveTitleModel(): string | undefined {
    return this.plugin.settings.titleGenerationModel || undefined;
  }

  private parseTitle(responseText: string): string | null {
    const trimmed = responseText.trim();
    if (!trimmed) return null;

    let title = trimmed;
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1);
    }

    title = title.replace(/[.!?:;,]+$/, '');

    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title || null;
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
