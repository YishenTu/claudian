/**
 * Security Hooks
 *
 * PreToolUse hooks for enforcing blocklist and vault restriction.
 */

import { Notice } from 'obsidian';

import type { PathAccessType } from '../../utils/path';
import type { PathCheckContext } from '../security/BashPathValidator';
import { findBashCommandPathViolation } from '../security/BashPathValidator';
import { isCommandBlocked } from '../security/BlocklistChecker';
import { getPathFromToolInput } from '../tools/toolInput';
import { isEditTool, isFileTool, TOOL_BASH } from '../tools/toolNames';
import { getBashToolBlockedCommands, type PlatformBlockedCommands } from '../types';

/** Hook result returned from PreToolUse hooks. */
export interface HookResult {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny' | 'allow';
    permissionDecisionReason: string;
  };
}

/** Hook function signature for PreToolUse hooks. */
export type HookCallback = (
  hookInput: { tool_name: string; tool_input: Record<string, unknown> },
  toolUseId?: string,
  options?: unknown
) => Promise<HookResult>;

/** Matcher for PreToolUse hooks (Gemini CLI compatible). */
export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
}

export interface BlocklistContext {
  blockedCommands: PlatformBlockedCommands;
  enableBlocklist: boolean;
}

export interface VaultRestrictionContext {
  getPathAccessType: (filePath: string) => PathAccessType;
}

/**
 * Create a PreToolUse hook to enforce the command blocklist.
 */
export function createBlocklistHook(getContext: () => BlocklistContext): HookCallbackMatcher {
  return {
    matcher: TOOL_BASH,
    hooks: [
      async (hookInput) => {
        const command = hookInput.tool_input?.command as string || '';
        const context = getContext();

        const bashToolCommands = getBashToolBlockedCommands(context.blockedCommands);
        if (isCommandBlocked(command, bashToolCommands, context.enableBlocklist)) {
          new Notice('Command blocked by security policy');
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
        const toolName = hookInput.tool_name;

        if (toolName === TOOL_BASH) {
          const command = (hookInput.tool_input?.command as string) || '';
          const pathCheckContext: PathCheckContext = {
            getPathAccessType: (p) => context.getPathAccessType(p),
          };
          const violation = findBashCommandPathViolation(command, pathCheckContext);
          if (violation) {
            const reason =
              violation.type === 'export_path_read'
                ? `Access denied: Command path "${violation.path}" is in an allowed export directory, but export paths are write-only.`
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

        if (!isFileTool(toolName)) {
          return { continue: true };
        }

        const filePath = getPathFromToolInput(toolName, hookInput.tool_input);

        if (filePath) {
          const accessType = context.getPathAccessType(filePath);

          if (accessType === 'vault' || accessType === 'readwrite' || accessType === 'context') {
            return { continue: true };
          }

          if (isEditTool(toolName) && accessType === 'export') {
            return { continue: true };
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
