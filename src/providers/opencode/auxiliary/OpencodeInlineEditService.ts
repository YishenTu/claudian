import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';

export class OpencodeInlineEditService implements InlineEditService {
  private plugin: ClaudianPlugin;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
  }

  async editText(_request: InlineEditRequest): Promise<InlineEditResult> {
    return { success: false, error: 'OpenCode inline edit not yet implemented' };
  }

  async continueConversation(_message: string, _contextFiles?: string[]): Promise<InlineEditResult> {
    return { success: false, error: 'OpenCode inline edit not yet implemented' };
  }

  cancel(): void {
  }
}
