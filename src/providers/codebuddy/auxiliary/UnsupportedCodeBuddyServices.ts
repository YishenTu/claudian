import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
  InstructionRefineService,
  RefineProgressCallback,
  TitleGenerationCallback,
  TitleGenerationService,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';

const UNSUPPORTED_MESSAGE = 'CodeBuddy auxiliary actions are not supported yet.';

export class CodeBuddyTitleGenerationService implements TitleGenerationService {
  async generateTitle(
    conversationId: string,
    _userMessage: string,
    callback: TitleGenerationCallback,
  ): Promise<void> {
    await callback(conversationId, { success: false, error: UNSUPPORTED_MESSAGE });
  }

  cancel(): void {}
}

export class CodeBuddyInstructionRefineService implements InstructionRefineService {
  setModelOverride(_model?: string): void {}

  resetConversation(): void {}

  async refineInstruction(
    _rawInstruction: string,
    _existingInstructions: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return { success: false, error: UNSUPPORTED_MESSAGE };
  }

  async continueConversation(
    _message: string,
    _onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    return { success: false, error: UNSUPPORTED_MESSAGE };
  }

  cancel(): void {}
}

export class CodeBuddyInlineEditService implements InlineEditService {
  setModelOverride(_model?: string): void {}

  resetConversation(): void {}

  async editText(_request: InlineEditRequest): Promise<InlineEditResult> {
    return { success: false, error: UNSUPPORTED_MESSAGE };
  }

  async continueConversation(_message: string, _contextFiles?: string[]): Promise<InlineEditResult> {
    return { success: false, error: UNSUPPORTED_MESSAGE };
  }

  cancel(): void {}
}
