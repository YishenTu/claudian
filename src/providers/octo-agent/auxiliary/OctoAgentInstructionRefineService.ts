import { buildRefineSystemPrompt } from '../../../core/prompt/instructionRefine';
import type {
  InstructionRefineService,
  RefineProgressCallback,
} from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import {
  runOctoAgentAuxQuery,
} from '../runtime/OctoAgentAuxQueryRunner';

export class OctoAgentInstructionRefineService implements InstructionRefineService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;
  private existingInstructions = '';

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.sessionId = null;
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    this.sessionId = null;
    this.existingInstructions = existingInstructions;
    const prompt = `Please refine this instruction: "${rawInstruction}"`;
    return this.sendMessage(prompt, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback,
  ): Promise<InstructionRefineResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message, onProgress, this.sessionId);
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
    resumeSessionId?: string,
  ): Promise<InstructionRefineResult> {
    this.abortController = new AbortController();

    try {
      const result = await runOctoAgentAuxQuery(
        this.plugin,
        {
          abortController: this.abortController,
          permissionMode: 'interactive',
          resumeSessionId,
          source: 'claudian-instruction-refine',
          systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
        },
        prompt,
      );
      this.sessionId = result.sessionId;
      const parsed = this.parseResponse(result.text);
      onProgress?.(parsed);
      return parsed;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.abortController = null;
    }
  }

  private parseResponse(responseText: string): InstructionRefineResult {
    const instructionMatch = responseText.match(/\u003cinstruction\u003e([\s\S]*?)\u003c\/instruction\u003e/);
    if (instructionMatch) {
      return { success: true, refinedInstruction: instructionMatch[1].trim() };
    }

    const trimmed = responseText.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }
}
