/** Permission utilities for tool action approval. */

import type { PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk';

import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_WRITE,
} from '../tools/toolNames';

export function getActionPattern(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case TOOL_BASH:
      return typeof input.command === 'string' ? input.command.trim() : '';
    case TOOL_READ:
    case TOOL_WRITE:
    case TOOL_EDIT:
      return typeof input.file_path === 'string' && input.file_path ? input.file_path : '*';
    case TOOL_NOTEBOOK_EDIT:
      if (typeof input.notebook_path === 'string' && input.notebook_path) {
        return input.notebook_path;
      }
      return typeof input.file_path === 'string' && input.file_path ? input.file_path : '*';
    case TOOL_GLOB:
      return typeof input.pattern === 'string' && input.pattern ? input.pattern : '*';
    case TOOL_GREP:
      return typeof input.pattern === 'string' && input.pattern ? input.pattern : '*';
    default:
      return JSON.stringify(input);
  }
}

export function getActionDescription(toolName: string, input: Record<string, unknown>): string {
  const pattern = getActionPattern(toolName, input);
  switch (toolName) {
    case TOOL_BASH:
      return `Run command: ${pattern}`;
    case TOOL_READ:
      return `Read file: ${pattern}`;
    case TOOL_WRITE:
      return `Write to file: ${pattern}`;
    case TOOL_EDIT:
      return `Edit file: ${pattern}`;
    case TOOL_GLOB:
      return `Search files matching: ${pattern}`;
    case TOOL_GREP:
      return `Search content matching: ${pattern}`;
    default:
      return `${toolName}: ${pattern}`;
  }
}

/**
 * Bash: exact or explicit wildcard ("git *", "npm:*").
 * File tools: path-prefix matching with segment boundaries.
 * Other tools: simple prefix matching.
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
      return matchesBashPrefix(normalizedAction, prefix);
    }
    // Space wildcard "git *"
    if (normalizedRule.endsWith('*')) {
      const prefix = normalizedRule.slice(0, -1);
      return matchesBashPrefix(normalizedAction, prefix);
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

function matchesBashPrefix(action: string, prefix: string): boolean {
  if (action === prefix) {
    return true;
  }

  if (prefix.endsWith(' ')) {
    return action.startsWith(prefix);
  }

  return action.startsWith(`${prefix} `);
}

/**
 * Convert a user allow decision + SDK suggestions into PermissionUpdate[].
 *
 * Only handles allow decisions — deny results use the SDK's bare deny path
 * (PermissionResult deny variant has no updatedPermissions field).
 *
 * Overrides destination on addRules/replaceRules suggestions to match the user's choice.
 * Other suggestion entries keep their original destinations (they may carry
 * specific semantics about where the update should be applied).
 * "always" destinations go to projectSettings; "allow" stays session.
 * Falls back to constructing an addRules entry from the action pattern
 * when no addRules/replaceRules suggestion is present.
 */
export function buildPermissionUpdates(
  toolName: string,
  input: Record<string, unknown>,
  decision: 'allow' | 'allow-always',
  suggestions?: PermissionUpdate[]
): PermissionUpdate[] {
  const destination: PermissionUpdateDestination = decision === 'allow-always' ? 'projectSettings' : 'session';

  const processed: PermissionUpdate[] = [];
  let hasRuleUpdate = false;

  if (suggestions) {
    for (const s of suggestions) {
      if (s.type === 'addRules' || s.type === 'replaceRules') {
        hasRuleUpdate = true;
        processed.push({ ...s, behavior: 'allow', destination });
      } else {
        processed.push(s);
      }
    }
  }

  if (!hasRuleUpdate) {
    const pattern = getActionPattern(toolName, input);
    const ruleValue: { toolName: string; ruleContent?: string } = { toolName };
    if (pattern && pattern !== '*' && !pattern.startsWith('{')) {
      ruleValue.ruleContent = pattern;
    }

    processed.unshift({
      type: 'addRules',
      behavior: 'allow',
      rules: [ruleValue],
      destination,
    });
  }

  return processed;
}
