import { buildRefineSystemPrompt } from '../../../core/prompt/instructionRefine';
import type {
  InstructionRefineService,
  RefineProgressCallback,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { CursorAuxCliRunner } from '../runtime/CursorAuxCliRunner';

export class CursorInstructionRefineService implements InstructionRefineService {
  private runner: CursorAuxCliRunner;
  private abortController: AbortController | null = null;
  private existingInstructions = '';
  private hasThread = false;

  constructor(plugin: ClaudianPlugin) {
    this.runner = new CursorAuxCliRunner(plugin);
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
      }, prompt);

      this.hasThread = true;
      const parsed = this.parseResponse(text);
      onProgress?.(parsed);
      return parsed;
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
