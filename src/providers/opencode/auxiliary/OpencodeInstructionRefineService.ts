import type {
  InstructionRefineService,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';

export class OpencodeInstructionRefineService implements InstructionRefineService {
  private plugin: ClaudianPlugin;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
  }

  async refineInstruction(
    _rawInstruction: string,
    _existingInstructions: string,
    _onProgress?: (update: InstructionRefineResult) => void,
  ): Promise<InstructionRefineResult> {
    return { success: false, error: 'OpenCode instruction refinement not yet implemented' };
  }

  async continueConversation(
    _message: string,
    _onProgress?: (update: InstructionRefineResult) => void,
  ): Promise<InstructionRefineResult> {
    return { success: false, error: 'OpenCode instruction refinement not yet implemented' };
  }

  cancel(): void {
  }
}
