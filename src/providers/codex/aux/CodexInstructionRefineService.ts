import { buildRefineSystemPrompt } from '../../../core/prompt/instructionRefine';
import type {
  InstructionRefineService,
  RefineProgressCallback,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { CodexAuxQueryRunner } from '../runtime/CodexAuxQueryRunner';

export class CodexInstructionRefineService implements InstructionRefineService {
  private runner: CodexAuxQueryRunner;
  private abortController: AbortController | null = null;
  private existingInstructions = '';
  private hasThread = false;

  constructor(plugin: ClaudianPlugin) {
    this.runner = new CodexAuxQueryRunner(plugin);
  }

  resetConversation(): void {
    this.runner.reset();
    this.hasThread = false;
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    this.resetConversation();
    this.existingInstructions = existingInstructions;
    const prompt = `Please refine this instruction: "${rawInstruction}"`;
    return this.sendMessage(prompt, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    if (!this.hasThread) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message, onProgress);
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async sendMessage(
    prompt: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    this.abortController = new AbortController();

    try {
      const text = await this.runner.query({
        systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
        abortController: this.abortController,
        onTextChunk: onProgress
          ? (accumulated: string) => onProgress(this.parseResponse(accumulated))
          : undefined,
      }, prompt);

      this.hasThread = true;
      return this.parseResponse(text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  private parseResponse(text: string): InstructionRefineResult {
    const match = text.match(/<instruction>([\s\S]*?)<\/instruction>/);
    if (match) {
      return { success: true, refinedInstruction: match[1].trim() };
    }

    const trimmed = text.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }
}
