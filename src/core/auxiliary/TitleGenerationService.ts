import {
  buildTitleGenerationPrompt,
  buildTitleGenerationSystemPrompt,
  parseTitleGenerationResponse,
} from '../prompt/titleGeneration';
import type {
  TitleGenerationCallback,
  TitleGenerationResult,
  TitleGenerationService as TitleGenerationServiceContract,
} from '../providers/types';
import type { AuxiliaryExecutionContext } from './AuxiliaryExecutionContext';
import { AuxiliarySessionController } from './AuxiliarySessionController';

export interface TitleGenerationServiceOptions
extends AuxiliaryExecutionContext {
  readonly resolveLocale?: () => string | undefined;
  readonly resolveModel?: () => string | undefined;
}

/** One request's execution; the routed service owns concurrent requests and replacement. */
export class TitleGenerationService implements TitleGenerationServiceContract {
  private readonly controller: AuxiliarySessionController;

  constructor(private readonly options: TitleGenerationServiceOptions) {
    this.controller = new AuxiliarySessionController(options, 'title', { kind: 'passive' });
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const { controller } = this;

    try {
      await controller.startRoot();
      const text = await controller.execute({
        model: this.options.resolveModel?.(),
        reasoning: null,
        prompt: buildTitleGenerationPrompt(userMessage),
        systemPrompt: buildTitleGenerationSystemPrompt(
          this.options.resolveLocale?.(),
        ),
      });
      const title = parseTitleGenerationResponse(text);
      await this.#safeCallback(
        callback,
        conversationId,
        title
          ? { success: true, title }
          : { success: false, error: 'Failed to parse title from response' },
      );
    } catch (error) {
      await this.#safeCallback(callback, conversationId, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      await controller.dispose();
    }
  }

  cancel(): void {
    this.controller.cancel();
  }

  async #safeCallback(
    callback: TitleGenerationCallback,
    conversationId: string,
    result: TitleGenerationResult,
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Callback failures cannot leak the one-shot execution lease.
    }
  }
}
