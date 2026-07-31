import {
  buildTitleGenerationPrompt,
  buildTitleGenerationSystemPrompt,
  parseTitleGenerationResponse,
} from '../prompt/titleGeneration';
import type {
  TitleGenerationBackend,
  TitleGenerationCallback,
  TitleGenerationResult,
  TitleGenerationService as TitleGenerationServiceContract,
} from '../providers/types';

interface ActiveGeneration {
  abortController: AbortController;
  backend: TitleGenerationBackend;
  disposed: boolean;
}

export interface TitleGenerationServiceOptions {
  createBackend: () => TitleGenerationBackend;
  resolveLocale?: () => string | undefined;
}

export class TitleGenerationService implements TitleGenerationServiceContract {
  private readonly activeGenerations = new Map<string, ActiveGeneration>();

  constructor(private readonly options: TitleGenerationServiceOptions) {}

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const existing = this.activeGenerations.get(conversationId);
    if (existing) {
      existing.abortController.abort();
      this.disposeGeneration(existing);
    }

    const abortController = new AbortController();
    const backend = this.options.createBackend();
    const generation = { abortController, backend, disposed: false };
    this.activeGenerations.set(conversationId, generation);

    try {
      const text = await backend.query({
        abortController,
        systemPrompt: buildTitleGenerationSystemPrompt(this.options.resolveLocale?.()),
        userPrompt: buildTitleGenerationPrompt(userMessage),
      });
      const title = parseTitleGenerationResponse(text);
      await this.safeCallback(
        callback,
        conversationId,
        title
          ? { success: true, title }
          : { success: false, error: 'Failed to parse title from response' },
      );
    } catch (error) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.disposeGeneration(generation);
      if (this.activeGenerations.get(conversationId) === generation) {
        this.activeGenerations.delete(conversationId);
      }
    }
  }

  cancel(): void {
    for (const active of this.activeGenerations.values()) {
      active.abortController.abort();
      this.disposeGeneration(active);
    }
    this.activeGenerations.clear();
  }

  private disposeGeneration(generation: ActiveGeneration): void {
    if (generation.disposed) {
      return;
    }
    generation.disposed = true;
    generation.backend.dispose();
  }

  private async safeCallback(
    callback: TitleGenerationCallback,
    conversationId: string,
    result: TitleGenerationResult,
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Ignore callback failures to match existing service behavior.
    }
  }
}
