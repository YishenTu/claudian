import { appendContextFiles } from '@/core/prompt/promptContext';

import {
  buildInlineEditPrompt,
  getInlineEditSystemPrompt,
  type InlineEditRequest,
  type InlineEditResult,
  parseInlineEditResponse,
} from '../prompt/inlineEdit';
import type { AuxiliaryExecutionContext } from './AuxiliaryExecutionContext';
import { AuxiliarySessionController } from './AuxiliarySessionController';

const CONTINUITY_RESET_MESSAGE =
  'The provider environment changed. Start a new inline edit.';

/**
 * One inline edit's read-only provider conversation. It alone decides whether a request opens the
 * conversation with its editor context or continues a clarification with just the instruction.
 */
export class InlineEditService {
  private readonly controller: AuxiliarySessionController;
  private readonly vaultWorkingDirectory: string;
  private conversing = false;

  constructor(context: AuxiliaryExecutionContext, private readonly model?: string) {
    this.vaultWorkingDirectory = context.vaultWorkingDirectory;
    this.controller = new AuxiliarySessionController(
      context,
      'inline-edit',
      { kind: 'read-only' },
    );
  }

  /** Whether the next request continues a clarification instead of starting from the editor context. */
  get isConversing(): boolean {
    return this.conversing;
  }

  async send(request: InlineEditRequest): Promise<InlineEditResult> {
    if (this.conversing && this.controller.requiresReset) {
      this.end();
      return { success: false, error: CONTINUITY_RESET_MESSAGE };
    }
    if (this.conversing && this.controller.hasSession) {
      return this.sendMessage(request.contextFiles?.length
        ? appendContextFiles(request.instruction, request.contextFiles)
        : request.instruction);
    }
    this.conversing = false;
    try {
      await this.controller.startRoot();
    } catch (error) {
      return toFailure(error);
    }
    return this.sendMessage(buildInlineEditPrompt(request));
  }

  /** Cancels work in flight and forgets the conversation; the next request starts a new one. */
  end(): void {
    this.conversing = false;
    this.controller.reset();
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    try {
      const text = await this.controller.execute({
        model: this.model,
        prompt,
        systemPrompt: getInlineEditSystemPrompt(this.vaultWorkingDirectory),
      });
      const result = parseInlineEditResponse(text);
      // A clarification opens the conversation; an empty reply leaves it as it was.
      this.conversing = result.clarification !== undefined || (this.conversing && !result.success);
      return result;
    } catch (error) {
      this.conversing = false;
      await this.controller.dispose();
      return toFailure(error);
    }
  }
}

function toFailure(error: unknown): InlineEditResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
  };
}
