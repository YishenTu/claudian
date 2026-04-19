import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
} from '../../../core/providers/types';

const UNSUPPORTED_RESULT: InlineEditResult = {
  error: 'Inline edit is not supported by the OpenCode MVP.',
  success: false,
};

export class OpencodeInlineEditService implements InlineEditService {
  resetConversation(): void {}

  async editText(_request: InlineEditRequest): Promise<InlineEditResult> {
    return UNSUPPORTED_RESULT;
  }

  async continueConversation(
    _message: string,
    _contextFiles?: string[],
  ): Promise<InlineEditResult> {
    return UNSUPPORTED_RESULT;
  }

  cancel(): void {}
}
