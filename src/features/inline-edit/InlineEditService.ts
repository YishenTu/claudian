import * as readline from 'readline';

import { spawnGeminiCli } from '../../core/agent/customSpawn';
import { QueryOptionsBuilder } from '../../core/agent/QueryOptionsBuilder';
import type { HookCallbackMatcher } from '../../core/hooks';
import { getInlineEditSystemPrompt } from '../../core/prompts/inlineEdit';
import { parseGeminiJsonLine } from '../../core/sdk/transformSDKMessage';
import { getPathFromToolInput } from '../../core/tools/toolInput';
import {
  isReadOnlyTool,
  READ_ONLY_TOOLS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
} from '../../core/tools/toolNames';
import type GeminianPlugin from '../../main';
import { appendContextFiles } from '../../utils/context';
import { type CursorContext } from '../../utils/editor';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../utils/env';
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

/** Parses response text for <replacement> or <insertion> tag. */
export function parseInlineEditResponse(responseText: string): InlineEditResult {
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

function buildCursorPrompt(request: InlineEditCursorRequest): string {
  const ctx = request.cursorContext;
  const lineAttr = ` line="${ctx.line + 1}"`; // 1-indexed

  let cursorContent: string;
  if (ctx.isInbetween) {
    const parts = [];
    if (ctx.beforeCursor) parts.push(ctx.beforeCursor);
    parts.push('| #inbetween');
    if (ctx.afterCursor) parts.push(ctx.afterCursor);
    cursorContent = parts.join('\n');
  } else {
    cursorContent = `${ctx.beforeCursor}|${ctx.afterCursor} #inline`;
  }

  return [
    request.instruction,
    '',
    `<editor_cursor path="${request.notePath}"${lineAttr}>`,
    cursorContent,
    '</editor_cursor>',
  ].join('\n');
}

export function buildInlineEditPrompt(request: InlineEditRequest): string {
  let prompt: string;

  if (request.mode === 'cursor') {
    prompt = buildCursorPrompt(request);
  } else {
    const lineAttr = request.startLine && request.lineCount
      ? ` lines="${request.startLine}-${request.startLine + request.lineCount - 1}"`
      : '';
    prompt = [
      request.instruction,
      '',
      `<editor_selection path="${request.notePath}"${lineAttr}>`,
      request.selectedText,
      '</editor_selection>',
    ].join('\n');
  }

  if (request.contextFiles && request.contextFiles.length > 0) {
    prompt = appendContextFiles(prompt, request.contextFiles);
  }

  return prompt;
}

export function createReadOnlyHook(): HookCallbackMatcher {
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

export function createVaultRestrictionHook(vaultPath: string): HookCallbackMatcher {
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
          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Access denied: Could not determine path for "${toolName}" tool.`,
            },
          };
        }

        let accessType: PathAccessType;
        try {
          accessType = getPathAccessType(filePath, undefined, undefined, vaultPath);
        } catch {
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

export function extractTextFromSdkMessage(message: any): string | null {
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

export class InlineEditService {
  private plugin: GeminianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;

  constructor(plugin: GeminianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.sessionId = null;
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.sessionId = null;
    const prompt = buildInlineEditPrompt(request);
    return this.sendMessage(prompt);
  }

  async continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = appendContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt);
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
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

    const allowedTools = [...READ_ONLY_TOOLS].join(',');
    const args: string[] = [
      '--output-format', 'stream-json',
      '--model', this.plugin.settings.model,
      '--approval-mode', 'yolo',
      '--allowed-tools', allowedTools,
      '--prompt', prompt,
    ];

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    try {
      const child = spawnGeminiCli({
        cliPath: resolvedGeminiPath,
        args,
        cwd: vaultPath,
        env: {
          ...process.env,
          ...customEnv,
          PATH: enhancedPath,
          GEMINI_SYSTEM_MD: QueryOptionsBuilder.writeSystemPromptFile(vaultPath, getInlineEditSystemPrompt()),
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
            const text = event.content || event.delta || '';
            if (text) {
              responseText += text;
            }
          }
        }
      }

      return parseInlineEditResponse(responseText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
