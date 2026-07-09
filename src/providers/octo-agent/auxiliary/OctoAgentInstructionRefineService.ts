import type { InstructionRefineService,RefineProgressCallback } from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';

export class OctoAgentInstructionRefineService implements InstructionRefineService {
  constructor(_plugin: ClaudianPlugin) {}

  setModelOverride(): void {}
  resetConversation(): void {}

  async refineInstruction(
    rawInstruction: string,
    _existingInstructions: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return {
      error: 'Instruction refinement is not yet supported by Octo Agent.',
      success: false,
    };
  }

  async continueConversation(
    _message: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return {
      error: 'Instruction refinement is not yet supported by Octo Agent.',
      success: false,
    };
  }

  cancel(): void {}
}
