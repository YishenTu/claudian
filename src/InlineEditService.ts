/**
 * Claudian - Inline edit service
 *
 * Lightweight Claude query service for inline text editing.
 * Uses read-only tools only and supports multi-turn clarification.
 */

import { query, type Options, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type ClaudianPlugin from './main';
import { THINKING_BUDGETS } from './types';
import { getVaultPath, parseEnvironmentVariables } from './utils';
import { getInlineEditSystemPrompt } from './systemPrompt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InlineEditRequest {
  selectedText: string;
  instruction: string;
  notePath: string;
}

export interface InlineEditResult {
  success: boolean;
  editedText?: string;
  clarification?: string;
  error?: string;
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'] as const;

/** Service for inline text editing with Claude using read-only tools. */
export class InlineEditService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private resolvedClaudePath: string | null = null;
  private sessionId: string | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  /** Resets conversation state for a new edit session. */
  resetConversation(): void {
    this.sessionId = null;
  }

  private findClaudeCLI(): string | null {
    const homeDir = os.homedir();
    const commonPaths = [
      path.join(homeDir, '.claude', 'local', 'claude'),
      path.join(homeDir, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(homeDir, 'bin', 'claude'),
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /** Edits text according to instructions (initial request). */
  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.sessionId = null;
    const prompt = this.buildPrompt(request);
    return this.sendMessage(prompt);
  }

  /** Continues conversation with a follow-up message. */
  async continueConversation(message: string): Promise<InlineEditResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message);
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return { success: false, error: 'Could not determine vault path' };
    }

    if (!this.resolvedClaudePath) {
      this.resolvedClaudePath = this.findClaudeCLI();
    }

    if (!this.resolvedClaudePath) {
      return { success: false, error: 'Claude CLI not found. Please install Claude Code CLI.' };
    }

    this.abortController = new AbortController();

    // Parse custom environment variables
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());

    const options: Options = {
      cwd: vaultPath,
      systemPrompt: getInlineEditSystemPrompt(),
      model: this.plugin.settings.model,
      abortController: this.abortController,
      pathToClaudeCodeExecutable: this.resolvedClaudePath,
      env: {
        ...process.env,
        ...customEnv,
      },
      allowedTools: [...READ_ONLY_TOOLS],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: {
        PreToolUse: [this.createReadOnlyHook()],
      },
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }

    try {
      const response = query({ prompt, options });
      let responseText = '';

      for await (const message of response) {
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          return { success: false, error: 'Cancelled' };
        }

        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          this.sessionId = message.session_id;
        }

        const text = this.extractTextFromMessage(message);
        if (text) {
          responseText += text;
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

  /** Parses response text for <replacement> tag. */
  private parseResponse(responseText: string): InlineEditResult {
    const match = responseText.match(/<replacement>([\s\S]*?)<\/replacement>/);

    if (match) {
      return {
        success: true,
        editedText: match[1],
      };
    }

    const trimmed = responseText.trim();
    if (trimmed) {
      return {
        success: true,
        clarification: trimmed,
      };
    }

    return { success: false, error: 'Empty response' };
  }

  private buildPrompt(request: InlineEditRequest): string {
    return [
      `File: ${request.notePath}`,
      '',
      '---',
      request.selectedText,
      '---',
      '',
      `Request: ${request.instruction}`,
    ].join('\n');
  }

  /** Creates PreToolUse hook to enforce read-only mode. */
  private createReadOnlyHook(): HookCallbackMatcher {
    return {
      hooks: [
        async (hookInput) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
          };
          const toolName = input.tool_name;

          if (READ_ONLY_TOOLS.includes(toolName as typeof READ_ONLY_TOOLS[number])) {
            return { continue: true };
          }

          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Inline edit mode: tool "${toolName}" is not allowed (read-only)`,
            },
          };
        },
      ],
    };
  }

  private extractTextFromMessage(message: any): string | null {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          return block.text;
        }
      }
    }

    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        return event.content_block.text || null;
      }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return event.delta.text || null;
      }
    }

    return null;
  }

  /** Cancels the current edit operation. */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
