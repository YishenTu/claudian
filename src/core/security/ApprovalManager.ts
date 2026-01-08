/**
 * Approval Manager
 *
 * Manages tool action permissions for Safe mode handling.
 * Uses CC-compatible permission format (allow/deny/ask arrays).
 */

import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_WRITE,
} from '../tools/toolNames';
import type { CCPermissions, PermissionRule } from '../types';
import { createPermissionRule, parseCCPermissionRule } from '../types';

/** Session-scoped permission (not persisted). */
interface SessionPermission {
  rule: PermissionRule;
  type: 'allow' | 'deny';
}

/** Callback to add a rule to allow list. */
export type AddAllowRuleCallback = (rule: PermissionRule) => Promise<void>;

/** Callback to add a rule to deny list. */
export type AddDenyRuleCallback = (rule: PermissionRule) => Promise<void>;

/** Permission check result. */
export type PermissionCheckResult = 'allow' | 'deny' | 'ask';

/**
 * Generate a pattern from tool input for matching.
 */
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
export function generatePermissionRule(toolName: string, input: Record<string, unknown>): PermissionRule {
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

  const normalizedAction = normalizeMatchPattern(actionPattern);
  const normalizedRule = normalizeMatchPattern(rulePattern);

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

function normalizeMatchPattern(value: string): string {
  return value.replace(/\\/g, '/');
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
 * Check if an action matches any rule in a list.
 * Uses short-circuit evaluation for performance (returns on first match).
 */
function matchesAnyRule(
  rules: PermissionRule[] | undefined,
  toolName: string,
  actionPattern: string
): boolean {
  if (!rules || rules.length === 0) return false;

  // Early return on first match for performance
  return rules.some(rule => {
    const { tool, pattern } = parseCCPermissionRule(rule);
    if (tool !== toolName) return false;
    return matchesRulePattern(toolName, actionPattern, pattern);
  });
}

/**
 * Manages tool action permissions for Safe mode.
 */
export class ApprovalManager {
  private sessionPermissions: SessionPermission[] = [];
  private addAllowRuleCallback: AddAllowRuleCallback | null = null;
  private addDenyRuleCallback: AddDenyRuleCallback | null = null;
  private getPermissions: () => CCPermissions;

  constructor(getPermissions: () => CCPermissions) {
    this.getPermissions = getPermissions;
  }

  /**
   * Set callback for adding rules to allow list.
   */
  setAddAllowRuleCallback(callback: AddAllowRuleCallback | null): void {
    this.addAllowRuleCallback = callback;
  }

  /**
   * Set callback for adding rules to deny list.
   */
  setAddDenyRuleCallback(callback: AddDenyRuleCallback | null): void {
    this.addDenyRuleCallback = callback;
  }

  /**
   * Check permission for an action.
   *
   * Priority (highest to lowest):
   * 1. Session deny (ephemeral, this session only)
   * 2. Permanent deny (persisted in settings.json)
   * 3. Permanent ask (forces prompt even if allow rule exists)
   * 4. Session allow (ephemeral, this session only)
   * 5. Permanent allow (persisted in settings.json)
   * 6. Fallback to ask (no matching rule found)
   *
   * @returns 'allow' | 'deny' | 'ask'
   */
  checkPermission(toolName: string, input: Record<string, unknown>): PermissionCheckResult {
    const actionPattern = getActionPattern(toolName, input);
    const permissions = this.getPermissions();

    // 1. Check session denies first (highest priority)
    const sessionDenied = this.sessionPermissions.some(
      sp => sp.type === 'deny' && this.matchesSessionPermission(sp.rule, toolName, actionPattern)
    );
    if (sessionDenied) return 'deny';

    // 2. Check permanent denies
    if (matchesAnyRule(permissions.deny, toolName, actionPattern)) {
      return 'deny';
    }

    // 3. Check ask list (overrides allow)
    if (matchesAnyRule(permissions.ask, toolName, actionPattern)) {
      return 'ask';
    }

    // 4. Check session allows
    const sessionAllowed = this.sessionPermissions.some(
      sp => sp.type === 'allow' && this.matchesSessionPermission(sp.rule, toolName, actionPattern)
    );
    if (sessionAllowed) return 'allow';

    // 5. Check permanent allows
    if (matchesAnyRule(permissions.allow, toolName, actionPattern)) {
      return 'allow';
    }

    // 6. Fallback to ask
    return 'ask';
  }

  /**
   * Legacy method for compatibility.
   * @deprecated Use checkPermission instead
   */
  isActionApproved(toolName: string, input: Record<string, unknown>): boolean {
    return this.checkPermission(toolName, input) === 'allow';
  }

  /**
   * Check if a session permission matches an action.
   */
  private matchesSessionPermission(
    rule: PermissionRule,
    toolName: string,
    actionPattern: string
  ): boolean {
    const { tool, pattern } = parseCCPermissionRule(rule);
    if (tool !== toolName) return false;
    return matchesRulePattern(toolName, actionPattern, pattern);
  }

  /**
   * Approve an action (add to allow list).
   * @throws Error if scope is 'always' but no callback is registered
   */
  async approveAction(
    toolName: string,
    input: Record<string, unknown>,
    scope: 'session' | 'always'
  ): Promise<void> {
    const rule = generatePermissionRule(toolName, input);

    if (scope === 'session') {
      this.sessionPermissions.push({ rule, type: 'allow' });
    } else {
      if (!this.addAllowRuleCallback) {
        throw new Error('[ApprovalManager] Cannot persist allow rule: addAllowRuleCallback not registered');
      }
      await this.addAllowRuleCallback(rule);
    }
  }

  /**
   * Deny an action (add to deny list).
   * @throws Error if scope is 'always' but no callback is registered
   */
  async denyAction(
    toolName: string,
    input: Record<string, unknown>,
    scope: 'session' | 'always'
  ): Promise<void> {
    const rule = generatePermissionRule(toolName, input);

    if (scope === 'session') {
      this.sessionPermissions.push({ rule, type: 'deny' });
    } else {
      if (!this.addDenyRuleCallback) {
        throw new Error('[ApprovalManager] Cannot persist deny rule: addDenyRuleCallback not registered');
      }
      await this.addDenyRuleCallback(rule);
    }
  }

  /**
   * Clear session-scoped permissions.
   */
  clearSessionPermissions(): void {
    this.sessionPermissions = [];
  }

  /**
   * Get session-scoped permissions (for testing/debugging).
   */
  getSessionPermissions(): SessionPermission[] {
    return [...this.sessionPermissions];
  }
}
