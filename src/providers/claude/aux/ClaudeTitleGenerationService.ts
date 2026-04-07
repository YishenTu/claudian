import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../../core/prompt/titleGeneration';
import type {
  TitleGenerationCallback,
  TitleGenerationResult,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { parseEnvironmentVariables } from '../../../utils/env';
import { runColdStartQuery } from '../runtime/claudeColdStartQuery';

export type { TitleGenerationResult };

export class TitleGenerationService {
  private plugin: ClaudianPlugin;
  private activeGenerations: Map<string, AbortController> = new Map();

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void> {
    // Cancel any existing generation for this conversation
    const existingController = this.activeGenerations.get(conversationId);
    if (existingController) {
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeGenerations.set(conversationId, abortController);

    const truncatedUser = this.truncateText(userMessage, 500);
    const prompt = `User's request:\n"""\n${truncatedUser}\n"""\n\nGenerate a title for this conversation:`;

    try {
      const result = await runColdStartQuery({
        plugin: this.plugin,
        systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
        tools: [],
        model: this.resolveTitleModel(),
        thinking: { disabled: true },
        persistSession: false,
        abortController,
      }, prompt);

      const title = this.parseTitle(result.text);
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
      this.activeGenerations.delete(conversationId);
    }
  }

  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  private resolveTitleModel(): string {
    const envVars = parseEnvironmentVariables(
      this.plugin.getActiveEnvironmentVariables('claude')
    );
    return (
      this.plugin.settings.titleGenerationModel ||
      envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
      'claude-haiku-4-5'
    );
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
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
    result: TitleGenerationResult
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Silently ignore callback errors
    }
  }
}
