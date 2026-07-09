import { buildInlineEditPrompt, getInlineEditSystemPrompt, parseInlineEditResponse } from '../../../core/prompt/inlineEdit';
import type { InlineEditRequest, InlineEditResult, InlineEditService } from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { appendContextFiles } from '../../../utils/context';
import { runOctoAgentAuxQuery } from '../runtime/OctoAgentAuxQueryRunner';

export class OctoAgentInlineEditService implements InlineEditService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private modelOverride: string | undefined;
  private sessionId: string | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  setModelOverride(model?: string): void {
    const trimmed = model?.trim();
    this.modelOverride = trimmed ? trimmed : undefined;
  }

  resetConversation(): void {
    this.sessionId = null;
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.sessionId = null;
    const prompt = buildInlineEditPrompt(request);
    return this.sendMessage(prompt);
  }

  async continueConversation(
    message: string,
    contextFiles?: string[],
  ): Promise<InlineEditResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = appendContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt, this.sessionId);
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async sendMessage(
    prompt: string,
    resumeSessionId?: string,
  ): Promise<InlineEditResult> {
    this.abortController = new AbortController();

    try {
      const result = await runOctoAgentAuxQuery(
        this.plugin,
        {
          abortController: this.abortController,
          model: this.modelOverride,
          permissionMode: 'interactive',
          resumeSessionId,
          source: 'claudian-inline-edit',
          systemPrompt: getInlineEditSystemPrompt(),
        },
        prompt,
      );
      this.sessionId = result.sessionId;
      return parseInlineEditResponse(result.text);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.abortController = null;
    }
  }
}
