/**
 * Approval Manager
 *
 * Manages approved tool actions for Safe mode permission handling.
 * Handles both session-scoped and persistent approvals.
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
import type { ApprovedAction } from '../types';

/** Callback to persist approved actions to settings. */
export type PersistApprovalCallback = (action: ApprovedAction) => Promise<void>;

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
 * Check if a pattern matches an approved pattern.
 * Bash commands require exact match; file tools allow prefix matching.
 */
export function matchesPattern(
  toolName: string,
  actionPattern: string,
  approvedPattern: string
): boolean {
  if (toolName === TOOL_BASH) {
    return actionPattern === approvedPattern;
  }

  const normalizedAction = normalizeMatchPattern(actionPattern);
  const normalizedApproved = normalizeMatchPattern(approvedPattern);

  // Wildcard matches everything
  if (normalizedApproved === '*') return true;

  // Exact match
  if (normalizedAction === normalizedApproved) return true;

  // File tools: prefix match with path-segment boundary awareness.
  if (
    toolName === TOOL_READ ||
    toolName === TOOL_WRITE ||
    toolName === TOOL_EDIT ||
    toolName === TOOL_NOTEBOOK_EDIT
  ) {
    return isPathPrefixMatch(normalizedAction, normalizedApproved);
  }

  // Other tools: allow simple prefix matching.
  if (normalizedAction.startsWith(normalizedApproved)) return true;

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
 * Manages approved actions for Safe mode permission handling.
 */
export class ApprovalManager {
  private sessionApprovedActions: ApprovedAction[] = [];
  private persistCallback: PersistApprovalCallback | null = null;
  private getPermanentApprovals: () => ApprovedAction[];

  constructor(getPermanentApprovals: () => ApprovedAction[]) {
    this.getPermanentApprovals = getPermanentApprovals;
  }

  /**
   * Set callback for persisting permanent approvals.
   */
  setPersistCallback(callback: PersistApprovalCallback | null): void {
    this.persistCallback = callback;
  }

  /**
   * Check if an action is pre-approved (either session or permanent).
   */
  isActionApproved(toolName: string, input: Record<string, unknown>): boolean {
    const pattern = getActionPattern(toolName, input);

    // Check session-scoped approvals
    const sessionApproved = this.sessionApprovedActions.some(
      action => action.toolName === toolName && matchesPattern(toolName, pattern, action.pattern)
    );
    if (sessionApproved) return true;

    // Check permanent approvals
    const permanentApprovals = this.getPermanentApprovals();
    const permanentApproved = permanentApprovals.some(
      action => action.toolName === toolName && matchesPattern(toolName, pattern, action.pattern)
    );
    return permanentApproved;
  }

  /**
   * Add an action to the approved list.
   */
  async approveAction(
    toolName: string,
    input: Record<string, unknown>,
    scope: 'session' | 'always'
  ): Promise<void> {
    const pattern = getActionPattern(toolName, input);
    const action: ApprovedAction = {
      toolName,
      pattern,
      approvedAt: Date.now(),
      scope,
    };

    if (scope === 'session') {
      this.sessionApprovedActions.push(action);
    } else {
      if (this.persistCallback) {
        await this.persistCallback(action);
      }
    }
  }

  /**
   * Clear session-scoped approvals.
   */
  clearSessionApprovals(): void {
    this.sessionApprovedActions = [];
  }

  /**
   * Get session-scoped approvals (for testing/debugging).
   */
  getSessionApprovals(): ApprovedAction[] {
    return [...this.sessionApprovedActions];
  }
}
