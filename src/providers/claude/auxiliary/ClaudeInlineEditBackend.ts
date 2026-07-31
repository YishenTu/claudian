import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import {
  isReadOnlyTool,
  READ_ONLY_TOOLS,
} from '../../../core/tools/toolNames';
import { ClaudeAuxQueryRunner } from '../runtime/ClaudeAuxQueryRunner';

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

export class ClaudeInlineEditBackend extends ClaudeAuxQueryRunner {
  constructor(plugin: ProviderHost) {
    super(plugin, {
      hooks: {
        PreToolUse: [createReadOnlyHook()],
      },
      tools: [...READ_ONLY_TOOLS],
    });
  }
}
