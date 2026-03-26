import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import type { RefineProgressCallback } from '../../../core/providers/types';
import type { InstructionRefineResult } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { buildRefineSystemPrompt } from '../prompt';
import { createCustomSpawnFunction } from '../runtime/customSpawn';
import { isAdaptiveThinkingModel, THINKING_BUDGETS } from '../types';
import { extractAssistantText } from './extractAssistantText';

export type { RefineProgressCallback };

export class InstructionRefineService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;
  private existingInstructions: string = '';

  constructor(plugin: ClaudianPlugin) {
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

    const resolvedClaudePath = this.plugin.getResolvedClaudeCliPath();
    if (!resolvedClaudePath) {
      return { success: false, error: 'Claude CLI not found. Please install Claude Code CLI.' };
    }

    this.abortController = new AbortController();

    // Parse custom environment variables
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedClaudePath);
    const missingNodeError = getMissingNodeError(resolvedClaudePath, enhancedPath);
    if (missingNodeError) {
      return { success: false, error: missingNodeError };
    }

    const options: Options = {
      cwd: vaultPath,
      systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
      model: this.plugin.settings.model,
      abortController: this.abortController,
      pathToClaudeCodeExecutable: resolvedClaudePath,
      env: {
        ...process.env,
        ...customEnv,
        PATH: enhancedPath,
      },
      tools: [], // No tools needed for instruction refinement
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: this.plugin.settings.loadUserClaudeSettings
        ? ['user', 'project']
        : ['project'],
      spawnClaudeCodeProcess: createCustomSpawnFunction(enhancedPath),
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    if (isAdaptiveThinkingModel(this.plugin.settings.model)) {
      options.thinking = { type: 'adaptive' };
      options.effort = this.plugin.settings.effortLevel;
    } else {
      const budgetConfig = THINKING_BUDGETS.find(b => b.value === this.plugin.settings.thinkingBudget);
      if (budgetConfig && budgetConfig.tokens > 0) {
        options.maxThinkingTokens = budgetConfig.tokens;
      }
    }

    try {
      const response = agentQuery({ prompt, options });
      let responseText = '';

      for await (const message of response) {
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          return { success: false, error: 'Cancelled' };
        }

        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          this.sessionId = message.session_id;
        }

        const text = extractAssistantText(message);
        if (text) {
          responseText += text;
          // Stream progress updates
          if (onProgress) {
            const partialResult = this.parseResponse(responseText);
            onProgress(partialResult);
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

    // No instruction tag - treat as clarification question
    const trimmed = responseText.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }

}
