import { appendContextFiles } from '../../utils/context';
import {
  buildInlineEditPrompt,
  getInlineEditSystemPrompt,
  parseInlineEditResponse,
} from '../prompt/inlineEdit';
import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService as InlineEditServiceContract,
} from '../providers/types';
import type { AuxiliaryExecutionContext } from './AuxiliaryExecutionContext';
import { AuxiliarySessionController } from './AuxiliarySessionController';

const CONTINUITY_RESET_MESSAGE =
  'The provider environment changed. Start a new inline edit.';

export class InlineEditService implements InlineEditServiceContract {
  private readonly controller: AuxiliarySessionController;
  private hasConversation = false;
  private modelOverride: string | undefined;

  constructor(context: AuxiliaryExecutionContext) {
    this.controller = new AuxiliarySessionController(
      context,
      'inline-edit',
      { kind: 'read-only' },
    );
  }

  setModelOverride(model?: string): void {
    const trimmed = model?.trim();
    this.modelOverride = trimmed ? trimmed : undefined;
  }

  resetConversation(): void {
    this.hasConversation = false;
    this.controller.reset();
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.hasConversation = false;
    try {
      await this.controller.startRoot();
    } catch (error) {
      return toFailure(error);
    }
    return this.sendMessage(buildInlineEditPrompt(request));
  }

  async continueConversation(
    message: string,
    contextFiles?: string[],
  ): Promise<InlineEditResult> {
    if (this.controller.requiresReset) {
      return {
        error: CONTINUITY_RESET_MESSAGE,
        resetRequired: true,
        success: false,
      };
    }
    if (!this.hasConversation || !this.controller.hasSession) {
      return { success: false, error: 'No active conversation to continue' };
    }
    const prompt = contextFiles?.length
      ? appendContextFiles(message, contextFiles)
      : message;
    return this.sendMessage(prompt);
  }

  cancel(): void {
    this.hasConversation = false;
    this.controller.cancel();
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    try {
      const text = await this.controller.execute({
        model: this.modelOverride,
        prompt,
        systemPrompt: getInlineEditSystemPrompt(),
      });
      this.hasConversation = true;
      return parseInlineEditResponse(text);
    } catch (error) {
      this.hasConversation = false;
      await this.controller.dispose();
      return toFailure(error);
    }
  }
}

function toFailure(error: unknown): InlineEditResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
  };
}
