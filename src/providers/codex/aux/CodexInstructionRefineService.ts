import type {
  InstructionRefineService,
  RefineProgressCallback,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';

export class CodexInstructionRefineService implements InstructionRefineService {
  resetConversation(): void {
    // No-op
  }

  async refineInstruction(
    _rawInstruction: string,
    _existingInstructions: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return {
      success: false,
      error: 'Codex does not support instruction refinement',
    };
  }

  async continueConversation(
    _message: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return {
      success: false,
      error: 'Codex does not support instruction refinement',
    };
  }

  cancel(): void {
    // No-op
  }
}
