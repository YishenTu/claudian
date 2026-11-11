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

/** The model and effort a request runs with; null effort omits it, an omitted field follows the provider's saved selection. */
export interface InlineEditExecutionSelection {
  readonly model?: string;
  readonly reasoning?: string | null;
}

/**
 * One inline edit's read-only provider conversation. It alone decides whether a request opens the
 * conversation with its editor context or continues it with just the instruction, whether the last
 * reply was a clarification, an answer or a proposed edit the user is still reviewing.
 */
export class InlineEditService {
  private readonly controller: AuxiliarySessionController;
  private readonly workingDirectory: string;
  private conversing = false;

  constructor(private readonly context: AuxiliaryExecutionContext) {
    this.workingDirectory = context.workingDirectory;
    this.controller = new AuxiliarySessionController(
      context,
      'inline-edit',
      { kind: 'read-only' },
    );
  }

  /** Whether the next request continues the conversation instead of starting from the editor context. */
  get isConversing(): boolean {
    return this.conversing;
  }

  /** The selection applies to this request only; the caller owns it across the conversation. */
  async send(
    request: InlineEditRequest,
    selection: InlineEditExecutionSelection = {},
  ): Promise<InlineEditResult> {
    if (this.conversing && this.controller.requiresReset) {
      this.end();
      return { success: false, error: CONTINUITY_RESET_MESSAGE };
    }
    if (this.conversing && this.controller.hasSession) {
      return this.sendMessage(request.contextFiles?.length
        ? appendContextFiles(request.instruction, request.contextFiles)
        : request.instruction, selection);
    }
    this.conversing = false;
    try {
      await this.controller.startRoot();
    } catch (error) {
      return toFailure(error);
    }
    return this.sendMessage(buildInlineEditPrompt(request), selection);
  }

  /** Cancels work in flight and forgets the conversation; the next request starts a new one. */
  end(): void {
    this.conversing = false;
    this.controller.reset();
  }

  private async sendMessage(prompt: string, selection: InlineEditExecutionSelection): Promise<InlineEditResult> {
    try {
      const text = await this.controller.execute({
        model: selection.model,
        reasoning: selection.reasoning,
        prompt,
        systemPrompt: getInlineEditSystemPrompt(
          await this.context.resolveExecutionWorkingDirectory?.(this.workingDirectory) ?? this.workingDirectory,
        ),
      });
      const result = parseInlineEditResponse(text);
      // Any reply opens the conversation until the caller ends it; an empty reply leaves it as it was.
      this.conversing = result.success || this.conversing;
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
