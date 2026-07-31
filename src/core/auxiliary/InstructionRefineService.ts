import { buildRefineSystemPrompt, parseInstructionRefineResponse } from '../prompt/instructionRefine';
import type {
  InstructionRefineService as InstructionRefineServiceContract,
  RefineProgressCallback,
} from '../providers/types';
import type { InstructionRefineResult } from '../types';
import type { AuxQueryRunner } from './AuxQueryRunner';

export class InstructionRefineService implements InstructionRefineServiceContract {
  private abortController: AbortController | null = null;
  private existingInstructions = '';
  private hasConversation = false;
  private modelOverride: string | undefined;

  constructor(private readonly runner: AuxQueryRunner) {}

  setModelOverride(model?: string): void {
    const trimmed = model?.trim();
    this.modelOverride = trimmed ? trimmed : undefined;
  }

  resetConversation(): void {
    this.runner.reset();
    this.hasConversation = false;
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    this.resetConversation();
    this.existingInstructions = existingInstructions;
    return this.sendMessage(`Please refine this instruction: "${rawInstruction}"`, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    if (!this.hasConversation || this.runner.canContinue?.() === false) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message, onProgress);
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async sendMessage(
    prompt: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    this.abortController = new AbortController();

    try {
      const text = await this.runner.query({
        abortController: this.abortController,
        model: this.modelOverride,
        onTextChunk: onProgress
          ? (accumulatedText: string) => onProgress(parseInstructionRefineResponse(accumulatedText))
          : undefined,
        systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
      }, prompt);
      this.hasConversation = this.runner.canContinue?.() ?? true;
      return parseInstructionRefineResponse(text);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.abortController = null;
    }
  }
}
