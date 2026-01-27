/** Permission utilities for tool action approval. */

import type { PermissionBehavior, PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk';

import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_WRITE,
} from '../tools/toolNames';
import { createPermissionRule } from '../types';

export function getActionPattern(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case TOOL_BASH:
      return typeof input.command === 'string' ? input.command.trim() : '';
    case TOOL_READ:
    case TOOL_WRITE:
    case TOOL_EDIT:
      return (input.file_path as string) || '*';
    case TOOL_NOTEBOOK_EDIT:
      return (input.notebook_path as string) || (input.file_path as string) || '*';
    case TOOL_GLOB:
      return (input.pattern as string) || '*';
    case TOOL_GREP:
      return (input.pattern as string) || '*';
    default:
      return JSON.stringify(input);
  }
}

/**
 * Generate a CC permission rule from tool name and input.
 * Examples: "Bash(git status)", "Read(/path/to/file)"
 *
 * Note: If pattern is empty, wildcard, or a JSON object string (legacy format
 * from tools that serialized their input), the rule falls back to just the
 * tool name, matching all actions for that tool.
 */
export function generatePermissionRule(toolName: string, input: Record<string, unknown>): string {
  const pattern = getActionPattern(toolName, input);

  // If pattern is empty, wildcard, or JSON object (legacy), just use tool name
  if (!pattern || pattern === '*' || pattern.startsWith('{')) {
    return createPermissionRule(toolName);
  }

  return createPermissionRule(`${toolName}(${pattern})`);
}

export function getActionDescription(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case TOOL_BASH:
      return `Run command: ${input.command}`;
    case TOOL_READ:
      return `Read file: ${input.file_path}`;
    case TOOL_WRITE:
      return `Write to file: ${input.file_path}`;
    case TOOL_EDIT:
      return `Edit file: ${input.file_path}`;
    case TOOL_GLOB:
      return `Search files matching: ${input.pattern}`;
    case TOOL_GREP:
      return `Search content matching: ${input.pattern}`;
    default:
      return `${toolName}: ${JSON.stringify(input)}`;
  }
}

/**
 * Bash: exact or explicit wildcard ("git *"). File tools: path-prefix matching.
 */
export function matchesRulePattern(
  toolName: string,
  actionPattern: string,
  rulePattern: string | undefined
): boolean {
  // No pattern means match all
  if (!rulePattern) return true;

  const normalizedAction = actionPattern.replace(/\\/g, '/');
  const normalizedRule = rulePattern.replace(/\\/g, '/');

  // Wildcard matches everything
  if (normalizedRule === '*') return true;

  // Exact match
  if (normalizedAction === normalizedRule) return true;

  // Bash: Only exact match (handled above) or explicit wildcard patterns are allowed.
  // This is intentional - Bash commands require explicit wildcards for security.
  // Supported formats:
  //   - "git *" matches "git status", "git commit", etc.
  //   - "npm:*" matches "npm install", "npm run", etc. (CC format)
  if (toolName === TOOL_BASH) {
    // CC format "npm:*" — colon is a separator, not part of the prefix
    if (normalizedRule.endsWith(':*')) {
      const prefix = normalizedRule.slice(0, -2);
      return normalizedAction.startsWith(prefix);
    }
    // Space wildcard "git *"
    if (normalizedRule.endsWith('*')) {
      const prefix = normalizedRule.slice(0, -1);
      return normalizedAction.startsWith(prefix);
    }
    // No wildcard present and exact match failed above - reject
    return false;
  }

  // File tools: prefix match with path-segment boundary awareness
  if (
    toolName === TOOL_READ ||
    toolName === TOOL_WRITE ||
    toolName === TOOL_EDIT ||
    toolName === TOOL_NOTEBOOK_EDIT
  ) {
    return isPathPrefixMatch(normalizedAction, normalizedRule);
  }

  // Other tools: allow simple prefix matching
  if (normalizedAction.startsWith(normalizedRule)) return true;

  return false;
}

function isPathPrefixMatch(actionPath: string, approvedPath: string): boolean {
  if (!actionPath.startsWith(approvedPath)) {
    return false;
  }

  if (approvedPath.endsWith('/')) {
    return true;
  }

  if (actionPath.length === approvedPath.length) {
    return true;
  }

  return actionPath.charAt(approvedPath.length) === '/';
}

/**
 * Convert a user decision + SDK suggestions into PermissionUpdate[].
 *
 * Overrides behavior/destination on addRules/replaceRules suggestions to match the user's choice.
 * removeRules keeps its original behavior (it specifies which list to remove from, not user intent).
 * "always" destinations go to projectSettings; session stays session.
 * addDirectories suggestions are excluded for deny decisions.
 * Falls back to constructing an addRules entry from the action pattern
 * when no addRules/replaceRules suggestion is present.
 */
export function buildPermissionUpdates(
  toolName: string,
  input: Record<string, unknown>,
  decision: 'allow' | 'allow-always' | 'deny' | 'deny-always',
  suggestions?: PermissionUpdate[]
): PermissionUpdate[] {
  const isAlways = decision === 'allow-always' || decision === 'deny-always';
  const isDeny = decision === 'deny' || decision === 'deny-always';
  const destination: PermissionUpdateDestination = isAlways ? 'projectSettings' : 'session';
  const behavior: PermissionBehavior = isDeny ? 'deny' : 'allow';

  const processed: PermissionUpdate[] = [];
  let hasRuleUpdate = false;

  if (suggestions) {
    for (const s of suggestions) {
      if (s.type === 'addRules' || s.type === 'replaceRules') {
        hasRuleUpdate = true;
        processed.push({ ...s, behavior, destination });
      } else if (s.type === 'removeRules') {
        // Preserve original behavior — it specifies which list to remove from, not user intent
        processed.push({ ...s, destination });
      } else if (s.type === 'addDirectories') {
        // Skip directory grants when user denied the action
        if (!isDeny) {
          processed.push({ ...s, destination });
        }
      } else {
        processed.push({ ...s, destination });
      }
    }
  }

  // Construct a fallback addRules when suggestions lacked addRules/replaceRules
  if (!hasRuleUpdate) {
    const pattern = getActionPattern(toolName, input);
    const ruleValue: { toolName: string; ruleContent?: string } = { toolName };
    if (pattern && pattern !== '*' && !pattern.startsWith('{')) {
      ruleValue.ruleContent = pattern;
    }

    processed.unshift({
      type: 'addRules' as const,
      behavior,
      rules: [ruleValue],
      destination,
    });
  }

  return processed;
}
