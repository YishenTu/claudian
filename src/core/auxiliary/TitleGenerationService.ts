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

interface ActiveGeneration {
  readonly controller: AuxiliarySessionController;
}

export interface TitleGenerationServiceOptions
extends AuxiliaryExecutionContext {
  readonly resolveLocale?: () => string | undefined;
  readonly resolveModel?: () => string | undefined;
}

export class TitleGenerationService implements TitleGenerationServiceContract {
  private readonly activeGenerations = new Map<string, ActiveGeneration>();

  constructor(private readonly options: TitleGenerationServiceOptions) {}

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    const previous = this.activeGenerations.get(conversationId);
    previous?.controller.cancel();

    const controller = new AuxiliarySessionController(
      this.options,
      'title',
      { kind: 'passive' },
    );
    const generation = { controller };
    this.activeGenerations.set(conversationId, generation);

    try {
      await controller.startRoot();
      const text = await controller.execute({
        model: this.options.resolveModel?.(),
        prompt: buildTitleGenerationPrompt(userMessage),
        systemPrompt: buildTitleGenerationSystemPrompt(
          this.options.resolveLocale?.(),
        ),
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
      await controller.dispose();
      if (this.activeGenerations.get(conversationId) === generation) {
        this.activeGenerations.delete(conversationId);
      }
    }
  }

  cancel(): void {
    for (const active of this.activeGenerations.values()) {
      active.controller.cancel();
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
      // Callback failures cannot leak the one-shot execution lease.
    }
  }
}
