import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class OctoAgentInlineEditService implements InlineEditService {
  constructor(_plugin: ClaudianPlugin) {}

  setModelOverride(): void {}
  resetConversation(): void {}

  async editText(_request: InlineEditRequest): Promise<InlineEditResult> {
    return {
      clarification: 'Inline editing is not yet supported by Octo Agent.',
      success: false,
    };
  }

  async continueConversation(
    _message: string,
    _contextFiles?: string[],
  ): Promise<InlineEditResult> {
    return {
      clarification: 'Inline editing is not yet supported by Octo Agent.',
      success: false,
    };
  }

  cancel(): void {}
}
