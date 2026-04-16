import type { InlineEditService, InlineEditResult } from '../../../core/providers/types';
import ClaudianPlugin from '../../../main';

/**
 * ACP inline edit service (stub for MVP).
 */
export class AcpInlineEditService implements InlineEditService {
  constructor(private readonly plugin: ClaudianPlugin) {}

  resetConversation(): void {
    // No-op in MVP
  }

  async editText(_request: {
    mode: 'selection' | 'cursor';
    instruction: string;
    notePath: string;
    selectedText?: string;
    cursorContext?: unknown;
    contextFiles?: string[];
  }): Promise<InlineEditResult> {
    // For MVP, indicate that inline edit is not supported
    return {
      success: false,
      error: 'ACP inline edit is not yet supported',
    };
  }

  async continueConversation(
    _message: string,
    _contextFiles?: string[],
  ): Promise<InlineEditResult> {
    return {
      success: false,
      error: 'ACP inline edit is not yet supported',
    };
  }

  cancel(): void {
    // No-op in MVP
  }
}
