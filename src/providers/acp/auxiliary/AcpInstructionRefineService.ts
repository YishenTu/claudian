import type { InstructionRefineService } from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import ClaudianPlugin from '../../../main';

/**
 * ACP instruction refine service (stub for MVP).
 */
export class AcpInstructionRefineService implements InstructionRefineService {
  constructor(private readonly plugin: ClaudianPlugin) {}

  resetConversation(): void {
    // No-op in MVP
  }

  async refineInstruction(
    rawInstruction: string,
    _existingInstructions: string,
    _onProgress?: (update: InstructionRefineResult) => void,
  ): Promise<InstructionRefineResult> {
    // For MVP, just return the raw instruction
    return { success: true, refinedInstruction: rawInstruction };
  }

  async continueConversation(
    _message: string,
    _onProgress?: (update: InstructionRefineResult) => void,
  ): Promise<InstructionRefineResult> {
    return { success: true, refinedInstruction: '' };
  }

  cancel(): void {
    // No-op in MVP
  }
}
