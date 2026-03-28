import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import { getInlineEditSystemPrompt } from '../../../core/prompt';
import { ProviderSettingsCoordinator } from '../../../core/providers';
import type {
  InlineEditCursorRequest,
  InlineEditMode,
  InlineEditRequest,
  InlineEditResult,
  InlineEditSelectionRequest,
} from '../../../core/providers/types';
import { getPathFromToolInput } from '../../../core/tools/toolInput';
import {
  isReadOnlyTool,
  READ_ONLY_TOOLS,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_READ,
} from '../../../core/tools/toolNames';
import type ClaudianPlugin from '../../../main';
import { appendContextFiles } from '../../../utils/context';
import { getPathAccessType, getVaultPath, type PathAccessType } from '../../../utils/path';
import { runColdStartQuery } from '../runtime/claudeColdStartQuery';

export type {
  InlineEditCursorRequest,
  InlineEditMode,
  InlineEditRequest,
  InlineEditResult,
  InlineEditSelectionRequest,
};

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

export class InlineEditService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  private getScopedSettings(): Record<string, unknown> {
    return ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'claude',
    );
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
    const settings = this.getScopedSettings();
    const vaultPath = getVaultPath(this.plugin.app);

    this.abortController = new AbortController();

    const hooks = {
      PreToolUse: settings.allowExternalAccess
        ? [createReadOnlyHook()]
        : [createReadOnlyHook(), ...(vaultPath ? [createVaultRestrictionHook(vaultPath)] : [])],
    };

    try {
      const result = await runColdStartQuery({
        plugin: this.plugin,
        systemPrompt: getInlineEditSystemPrompt(settings.allowExternalAccess as boolean),
        tools: [...READ_ONLY_TOOLS],
        hooks,
        resumeSessionId: this.sessionId ?? undefined,
        abortController: this.abortController,
        providerSettings: settings,
      }, prompt);

      this.sessionId = result.sessionId;
      return parseInlineEditResponse(result.text);
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
