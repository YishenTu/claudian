import {
  buildRefineSystemPrompt,
  parseInstructionRefineResponse,
} from '../prompt/instructionRefine';
import type {
  InstructionRefineService as InstructionRefineServiceContract,
  RefineProgressCallback,
} from '../providers/types';
import type { InstructionRefineResult } from '../types';
import type { AuxiliaryExecutionContext } from './AuxiliaryExecutionContext';
import { AuxiliarySessionController } from './AuxiliarySessionController';

const CONTINUITY_RESET_MESSAGE =
  'The provider environment changed. Start a new instruction refinement.';

export class InstructionRefineService
implements InstructionRefineServiceContract {
  private readonly controller: AuxiliarySessionController;
  private existingInstructions = '';
  private hasConversation = false;
  private modelOverride: string | undefined;

  constructor(context: AuxiliaryExecutionContext) {
    this.controller = new AuxiliarySessionController(
      context,
      'instruction',
      { kind: 'passive' },
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

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    this.hasConversation = false;
    this.existingInstructions = existingInstructions;
    try {
      await this.controller.startRoot();
    } catch (error) {
      return toFailure(error);
    }
    return this.sendMessage(
      `Please refine this instruction: "${rawInstruction}"`,
      onProgress,
    );
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
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
    return this.sendMessage(message, onProgress);
  }

  cancel(): void {
    this.hasConversation = false;
    this.controller.cancel();
  }

  private async sendMessage(
    prompt: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    try {
      const text = await this.controller.execute({
        model: this.modelOverride,
        onProgress: onProgress
          ? accumulated => onProgress(
            parseInstructionRefineResponse(accumulated),
          )
          : undefined,
        prompt,
        systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
      });
      this.hasConversation = true;
      return parseInstructionRefineResponse(text);
    } catch (error) {
      this.hasConversation = false;
      await this.controller.dispose();
      return toFailure(error);
    }
  }
}

function toFailure(error: unknown): InstructionRefineResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
  };
}
