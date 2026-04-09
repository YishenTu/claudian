import type {
  InstructionRefineService,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';

export class OpenCodeInstructionRefineService implements InstructionRefineService {
  constructor(private plugin: ClaudianPlugin) {}

  resetConversation(): void {
    // Reset internal state if needed
  }

  async refineInstruction(
    rawInstruction: string,
    _existingInstructions: string
  ): Promise<InstructionRefineResult> {
    // Simple instruction refinement - just return the original
    // Could be enhanced with LLM calls in the future
    return {
      success: true,
      refinedInstruction: rawInstruction,
    };
  }

  async continueConversation(
    message: string
  ): Promise<InstructionRefineResult> {
    return {
      success: true,
      refinedInstruction: message,
    };
  }

  cancel(): void {
    // No cancellation needed
  }
}
