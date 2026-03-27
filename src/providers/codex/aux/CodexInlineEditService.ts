import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
} from '../../../core/providers/types';

export class CodexInlineEditService implements InlineEditService {
  resetConversation(): void {
    // No-op
  }

  async editText(_request: InlineEditRequest): Promise<InlineEditResult> {
    return {
      success: false,
      error: 'Codex does not support inline edit',
    };
  }

  async continueConversation(
    _message: string,
    _contextFiles?: string[],
  ): Promise<InlineEditResult> {
    return {
      success: false,
      error: 'Codex does not support inline edit',
    };
  }

  cancel(): void {
    // No-op
  }
}
