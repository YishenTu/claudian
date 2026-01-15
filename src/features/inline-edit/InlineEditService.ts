/**
 * Claudian - Inline edit service
 *
 * Lightweight Claude query service for inline text editing.
 * Uses read-only tools only and supports multi-turn clarification.
 */

import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import { getInlineEditSystemPrompt } from '../../core/prompts/inlineEdit';
import { getPathFromToolInput } from '../../core/tools/toolInput';
import {
  isReadOnlyTool,
  READ_ONLY_TOOLS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
} from '../../core/tools/toolNames';
import { THINKING_BUDGETS } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { prependContextFiles } from '../../utils/context';
import { type CursorContext } from '../../utils/editor';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getPathAccessType, getVaultPath, type PathAccessType } from '../../utils/path';

export type InlineEditMode = 'selection' | 'cursor';

export interface InlineEditSelectionRequest {
  mode: 'selection';
  instruction: string;
  notePath: string;
  selectedText: string;
  startLine?: number;  // 1-indexed
  lineCount?: number;
  contextFiles?: string[];
}

export interface InlineEditCursorRequest {
  mode: 'cursor';
  instruction: string;
  notePath: string;
  cursorContext: CursorContext;
  contextFiles?: string[];
}

export type InlineEditRequest = InlineEditSelectionRequest | InlineEditCursorRequest;

export interface InlineEditResult {
  success: boolean;
  editedText?: string;      // replacement (selection mode)
  insertedText?: string;    // insertion (cursor mode)
  clarification?: string;
  error?: string;
}

/** Service for inline text editing with Claude using read-only tools. */
export class InlineEditService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  /** Resets conversation state for a new edit session. */
  resetConversation(): void {
    this.sessionId = null;
  }

  /** Edits text according to instructions (initial request). */
  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.sessionId = null;
    const prompt = this.buildPrompt(request);
    return this.sendMessage(prompt);
  }

  /** Continues conversation with a follow-up message. */
  async continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    // Prepend new context files if any
    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = prependContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt);
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
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

    const options: Options = {
      cwd: vaultPath,
      systemPrompt: getInlineEditSystemPrompt(),
      model: this.plugin.settings.model,
      abortController: this.abortController,
      pathToClaudeCodeExecutable: resolvedClaudePath,
      env: {
        ...process.env,
        ...customEnv,
        PATH: getEnhancedPath(customEnv.PATH, resolvedClaudePath),
      },
      tools: [...READ_ONLY_TOOLS], // Only read-only tools needed
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: this.plugin.settings.loadUserClaudeSettings
        ? ['user', 'project']
        : ['project'],
      hooks: {
        PreToolUse: [
          this.createReadOnlyHook(),
          this.createVaultRestrictionHook(vaultPath),
        ],
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

  /** Parses response text for <replacement> or <insertion> tag. */
  private parseResponse(responseText: string): InlineEditResult {
    const replacementMatch = responseText.match(/<replacement>([\s\S]*?)<\/replacement>/);
    if (replacementMatch) {
      return { success: true, editedText: replacementMatch[1] };
    }

    const insertionMatch = responseText.match(/<insertion>([\s\S]*?)<\/insertion>/);
    if (insertionMatch) {
      return { success: true, insertedText: insertionMatch[1] };
    }

    const trimmed = responseText.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }

  private buildPrompt(request: InlineEditRequest): string {
    let prompt: string;

    if (request.mode === 'cursor') {
      prompt = this.buildCursorPrompt(request);
    } else {
      // Selection mode - XML format with line numbers
      const lineAttr = request.startLine && request.lineCount
        ? ` lines="${request.startLine}-${request.startLine + request.lineCount - 1}"`
        : '';
      prompt = [
        `<editor_selection path="${request.notePath}"${lineAttr}>`,
        request.selectedText,
        '</editor_selection>',
        '',
        '<query>',
        request.instruction,
        '</query>',
      ].join('\n');
    }

    // Prepend context files if any
    if (request.contextFiles && request.contextFiles.length > 0) {
      prompt = prependContextFiles(prompt, request.contextFiles);
    }

    return prompt;
  }

  private buildCursorPrompt(request: InlineEditCursorRequest): string {
    const ctx = request.cursorContext;
    const lineAttr = ` line="${ctx.line + 1}"`; // 1-indexed

    let cursorContent: string;
    if (ctx.isInbetween) {
      // For #inbetween, include surrounding context lines
      const parts = [];
      if (ctx.beforeCursor) parts.push(ctx.beforeCursor);
      parts.push('| #inbetween');
      if (ctx.afterCursor) parts.push(ctx.afterCursor);
      cursorContent = parts.join('\n');
    } else {
      // For #inline, show the cursor position within the line
      cursorContent = `${ctx.beforeCursor}|${ctx.afterCursor} #inline`;
    }

    return [
      `<editor_cursor path="${request.notePath}"${lineAttr}>`,
      cursorContent,
      '</editor_cursor>',
      '',
      '<query>',
      request.instruction,
      '</query>',
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

          if (isReadOnlyTool(toolName)) {
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

  /** Creates PreToolUse hook to restrict file tools to allowed paths. */
  private createVaultRestrictionHook(vaultPath: string): HookCallbackMatcher {
    const fileTools = [TOOL_READ, TOOL_GLOB, TOOL_GREP, TOOL_LS] as const;

    return {
      hooks: [
        async (hookInput) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
          };

          const toolName = input.tool_name;
          if (!fileTools.includes(toolName as (typeof fileTools)[number])) {
            return { continue: true };
          }

          const filePath = getPathFromToolInput(toolName, input.tool_input);
          if (!filePath) {
            // Fail-closed: deny if we can't determine the path for a file tool
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: `Access denied: Could not determine path for "${toolName}" tool.`,
              },
            };
          }

          // Use getPathAccessType for consistent path access control
          // This allows vault and ~/.claude/ paths (context/readwrite params are undefined)
          let accessType: PathAccessType;
          try {
            accessType = getPathAccessType(filePath, undefined, undefined, vaultPath);
          } catch {
            // Fail-closed: deny if path validation throws (ENOENT, ELOOP, EPERM, etc.)
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: `Access denied: Failed to validate path "${filePath}".`,
              },
            };
          }

          if (accessType === 'vault' || accessType === 'context' || accessType === 'readwrite') {
            return { continue: true };
          }

          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Access denied: Path "${filePath}" is outside allowed paths. Inline edit is restricted to vault and ~/.claude/ directories.`,
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
