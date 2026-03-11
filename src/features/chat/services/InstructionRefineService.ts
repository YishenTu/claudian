import * as readline from 'readline';

import { spawnGeminiCli } from '../../../core/agent/customSpawn';
import { QueryOptionsBuilder } from '../../../core/agent/QueryOptionsBuilder';
import { buildRefineSystemPrompt } from '../../../core/prompts/instructionRefine';
import { parseGeminiJsonLine } from '../../../core/sdk/transformSDKMessage';
import { type InstructionRefineResult } from '../../../core/types';
import type GeminianPlugin from '../../../main';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

export type RefineProgressCallback = (update: InstructionRefineResult) => void;

export class InstructionRefineService {
  private plugin: GeminianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;
  private existingInstructions: string = '';

  constructor(plugin: GeminianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.sessionId = null;
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    this.sessionId = null;
    this.existingInstructions = existingInstructions;
    const prompt = `Please refine this instruction: "${rawInstruction}"`;
    return this.sendMessage(prompt, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    if (!this.sessionId) {
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
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return { success: false, error: 'Could not determine vault path' };
    }

    const resolvedGeminiPath = this.plugin.getResolvedGeminiCliPath();
    if (!resolvedGeminiPath) {
      return { success: false, error: 'Gemini CLI not found. Please install Gemini CLI.' };
    }

    this.abortController = new AbortController();
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedGeminiPath);

    if (resolvedGeminiPath.endsWith('.js')) {
      const missingNodeError = getMissingNodeError(resolvedGeminiPath, enhancedPath);
      if (missingNodeError) {
        return { success: false, error: missingNodeError };
      }
    }

    const args: string[] = [
      '--output-format', 'stream-json',
      '--model', this.plugin.settings.model,
      '--approval-mode', 'yolo',
      '--prompt', prompt,
    ];

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    try {
      const promptPath = QueryOptionsBuilder.writeSystemPromptFile(
        vaultPath,
        buildRefineSystemPrompt(this.existingInstructions)
      );
      const child = spawnGeminiCli({
        cliPath: resolvedGeminiPath,
        args,
        cwd: vaultPath,
        env: {
          ...process.env,
          ...customEnv,
          PATH: enhancedPath,
          GEMINI_SYSTEM_MD: promptPath,
        },
        signal: this.abortController.signal,
        enhancedPath,
      });

      let responseText = '';

      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          if (this.abortController?.signal.aborted) break;
          const event = parseGeminiJsonLine(line);
          if (!event) continue;

          if (event.type === 'init' && event.session_id) {
            this.sessionId = event.session_id;
          }

          if (event.type === 'message' && event.role === 'assistant') {
            const text = event.content || '';
            if (text) {
              responseText += text;
              if (onProgress) {
                onProgress(this.parseResponse(responseText));
              }
            }
          }
        }
      }

      return this.parseResponse(responseText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  private parseResponse(responseText: string): InstructionRefineResult {
    const instructionMatch = responseText.match(/<instruction>([\s\S]*?)<\/instruction>/);
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
