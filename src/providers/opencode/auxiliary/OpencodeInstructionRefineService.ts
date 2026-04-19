import type {
  InstructionRefineService,
  RefineProgressCallback,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';

const UNSUPPORTED_RESULT: InstructionRefineResult = {
  error: 'Instruction refine is not supported by the OpenCode MVP.',
  success: false,
};

export class OpencodeInstructionRefineService implements InstructionRefineService {
  resetConversation(): void {}

  async refineInstruction(
    _rawInstruction: string,
    _existingInstructions: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return UNSUPPORTED_RESULT;
  }

  async continueConversation(
    _message: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return UNSUPPORTED_RESULT;
  }

  cancel(): void {}
}
