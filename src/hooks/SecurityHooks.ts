/**
 * Security Hooks
 *
 * PreToolUse hooks for enforcing blocklist and vault restriction.
 */

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import type { PathCheckContext } from '../security/BashPathValidator';
import { findBashCommandPathViolation } from '../security/BashPathValidator';
import { isCommandBlocked } from '../security/BlocklistChecker';
import { getPathFromToolInput } from '../tools/toolInput';
import { isEditTool, isFileTool, TOOL_BASH } from '../tools/toolNames';
import { getBashToolBlockedCommands, type PlatformBlockedCommands } from '../types';
import type { PathAccessType } from '../utils';

/** Context for blocklist checking. */
export interface BlocklistContext {
  blockedCommands: PlatformBlockedCommands;
  enableBlocklist: boolean;
}

/** Context for vault restriction checking. */
export interface VaultRestrictionContext {
  getPathAccessType: (filePath: string) => PathAccessType;
  onEditBlocked?: (toolName: string, toolInput: Record<string, unknown>) => void;
}

/**
 * Create a PreToolUse hook to enforce the command blocklist.
 */
export function createBlocklistHook(getContext: () => BlocklistContext): HookCallbackMatcher {
  return {
    matcher: TOOL_BASH,
    hooks: [
      async (hookInput) => {
        const input = hookInput as {
          tool_name: string;
          tool_input: { command?: string };
        };
        const command = input.tool_input?.command || '';
        const context = getContext();

        const bashToolCommands = getBashToolBlockedCommands(context.blockedCommands);
        if (isCommandBlocked(command, bashToolCommands, context.enableBlocklist)) {
          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Command blocked by blocklist: ${command}`,
            },
          };
        }

        return { continue: true };
      },
    ],
  };
}

/**
 * Create a PreToolUse hook to restrict file access to the vault.
 */
export function createVaultRestrictionHook(context: VaultRestrictionContext): HookCallbackMatcher {
  return {
    hooks: [
      async (hookInput) => {
        const input = hookInput as {
          tool_name: string;
          tool_input: Record<string, unknown>;
        };

        const toolName = input.tool_name;

        // Bash: inspect command for paths that escape the vault
        if (toolName === TOOL_BASH) {
          const command = (input.tool_input?.command as string) || '';
          const pathCheckContext: PathCheckContext = {
            getPathAccessType: (p) => context.getPathAccessType(p),
          };
          const violation = findBashCommandPathViolation(command, pathCheckContext);
          if (violation) {
            const reason =
              violation.type === 'export_path_read'
                ? `Access denied: Command path "${violation.path}" is in an allowed export directory, but export paths are write-only.`
                : violation.type === 'context_path_write'
                  ? `Access denied: Command path "${violation.path}" is in an allowed context directory, but context paths are read-only.`
                  : `Access denied: Command path "${violation.path}" is outside the vault. Agent is restricted to vault directory only.`;
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: reason,
              },
            };
          }
          return { continue: true };
        }

        // Skip if not a file-related tool
        if (!isFileTool(toolName)) {
          return { continue: true };
        }

        // Get the path from tool input
        const filePath = getPathFromToolInput(toolName, input.tool_input);

        if (filePath) {
          const accessType = context.getPathAccessType(filePath);

          if (accessType === 'vault' || accessType === 'readwrite') {
            return { continue: true };
          }

          if (!isEditTool(toolName) && accessType === 'context') {
            return { continue: true };
          }

          if (isEditTool(toolName)) {
            if (accessType === 'export') {
              return { continue: true };
            }

            if (accessType === 'context') {
              context.onEditBlocked?.(toolName, input.tool_input);
              return {
                continue: false,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: `Access denied: Path "${filePath}" is in an allowed context directory, but context paths are read-only.`,
                },
              };
            }
          }

          if (!isEditTool(toolName) && accessType === 'export') {
            return {
              continue: false,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: `Access denied: Path "${filePath}" is in an allowed export directory, but export paths are write-only.`,
              },
            };
          }

          if (isEditTool(toolName)) {
            context.onEditBlocked?.(toolName, input.tool_input);
          }

          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Access denied: Path "${filePath}" is outside the vault. Agent is restricted to vault directory only.`,
            },
          };
        }

        return { continue: true };
      },
    ],
  };
}
