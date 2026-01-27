/**
 * Permission utilities for tool action approval.
 * Standalone functions for pattern matching, rule generation, and SDK permission updates.
 */

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

/**
 * Generate a human-readable description of the action.
 */
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
 * Check if an action pattern matches a permission rule pattern.
 * Bash commands use prefix matching with wildcard support.
 * File tools use path prefix matching.
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
    if (normalizedRule.endsWith('*')) {
      const prefix = normalizedRule.slice(0, -1);
      return normalizedAction.startsWith(prefix);
    }
    // Support trailing ":*" format from CC (e.g., "git:*" or "npm run:*")
    if (normalizedRule.endsWith(':*')) {
      const prefix = normalizedRule.slice(0, -2);  // Remove trailing ":*"
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
 * For "always" decisions: uses suggestions with destination overridden to
 * projectSettings, or constructs an addRules update from the action pattern.
 * For session decisions: uses suggestions as-is or constructs with destination 'session'.
 *
 * All suggestion types are preserved (addRules, addDirectories, setMode, etc.),
 * with behavior/destination overridden to match the user's decision. Directory-grant
 * suggestions (addDirectories) are excluded for deny decisions to avoid granting
 * access the user explicitly rejected.
 */
export function buildPermissionUpdates(
  toolName: string,
  input: Record<string, unknown>,
  decision: 'allow' | 'allow-always' | 'deny' | 'deny-always',
  suggestions?: PermissionUpdate[]
): PermissionUpdate[] {
  const isAlways = decision === 'allow-always' || decision === 'deny-always';
  const destination: PermissionUpdateDestination = isAlways ? 'projectSettings' : 'session';
  const behavior: PermissionBehavior = decision.startsWith('deny') ? 'deny' : 'allow';
  const isDeny = decision.startsWith('deny');

  // Process all SDK suggestions, overriding behavior/destination as appropriate
  const processed: PermissionUpdate[] = [];
  let hasRuleUpdate = false;

  if (suggestions) {
    for (const s of suggestions) {
      if (s.type === 'addRules' || s.type === 'replaceRules' || s.type === 'removeRules') {
        // Rule-based updates: override both behavior and destination
        hasRuleUpdate = hasRuleUpdate || s.type === 'addRules' || s.type === 'replaceRules';
        processed.push({ ...s, behavior, destination });
      } else if (s.type === 'addDirectories') {
        // Don't grant directory access when user denied the action
        if (!isDeny) {
          processed.push({ ...s, destination });
        }
      } else {
        // removeDirectories, setMode: override destination
        processed.push({ ...s, destination });
      }
    }
  }

  // Ensure we have a rule update (construct addRules from action pattern if needed).
  // addRules and replaceRules from SDK suggestions satisfy this — only removeRules alone
  // does not, since removing rules without adding any would leave no rule for this action.
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
