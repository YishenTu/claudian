import { appendContextFiles } from '../../utils/context';
import {
  buildInlineEditPrompt,
  getInlineEditSystemPrompt,
  parseInlineEditResponse,
} from '../prompt/inlineEdit';
import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService as InlineEditServiceContract,
} from '../providers/types';
import type { AuxQueryRunner } from './AuxQueryRunner';

export class InlineEditService implements InlineEditServiceContract {
  private abortController: AbortController | null = null;
  private hasConversation = false;
  private modelOverride: string | undefined;

  constructor(private readonly runner: AuxQueryRunner) {}

  setModelOverride(model?: string): void {
    const trimmed = model?.trim();
    this.modelOverride = trimmed ? trimmed : undefined;
  }

  resetConversation(): void {
    this.runner.reset();
    this.hasConversation = false;
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.resetConversation();
    return this.sendMessage(buildInlineEditPrompt(request));
  }

  async continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult> {
    if (!this.hasConversation || this.runner.canContinue?.() === false) {
      return { success: false, error: 'No active conversation to continue' };
    }

    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = appendContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt);
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    this.abortController = new AbortController();

    try {
      const text = await this.runner.query({
        abortController: this.abortController,
        model: this.modelOverride,
        systemPrompt: getInlineEditSystemPrompt(),
      }, prompt);
      this.hasConversation = this.runner.canContinue?.() ?? true;
      return parseInlineEditResponse(text);
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
