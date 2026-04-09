import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class OpenCodeInlineEditService implements InlineEditService {
  constructor(private plugin: ClaudianPlugin) {}

  resetConversation(): void {
    // Reset internal state if needed
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    try {
      const instruction = request.instruction;
      const selectedText = request.mode === 'selection' ? request.selectedText : '';
      
      // Simple implementation - return the instruction as edited text
      // In the future, this would call OpenCode's editing API
      return {
        success: true,
        editedText: `[OpenCode Edit] ${instruction}\n${selectedText}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async continueConversation(
    message: string,
    _contextFiles?: string[]
  ): Promise<InlineEditResult> {
    return {
      success: true,
      editedText: message,
    };
  }

  cancel(): void {
    // No cancellation needed
  }
}
