import type { PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk';

import { getActionPattern } from '../../../core/security/ApprovalManager';

export function buildPermissionUpdates(
  toolName: string,
  input: Record<string, unknown>,
  decision: 'allow' | 'allow-always',
  suggestions?: PermissionUpdate[]
): PermissionUpdate[] {
  const destination: PermissionUpdateDestination =
    decision === 'allow-always' ? 'projectSettings' : 'session';

  const processed: PermissionUpdate[] = [];
  let hasRuleUpdate = false;

  if (suggestions) {
    for (const suggestion of suggestions) {
      if (suggestion.type === 'addRules' || suggestion.type === 'replaceRules') {
        if (decision === 'allow-always') {
          const scopedRules = suggestion.rules.filter(hasNonEmptyRuleScope);
          if (scopedRules.length === 0) {
            continue;
          }
          hasRuleUpdate = true;
          processed.push({
            ...suggestion,
            rules: scopedRules,
            behavior: 'allow',
            destination,
          });
        } else {
          hasRuleUpdate = true;
          processed.push({ ...suggestion, behavior: 'allow', destination });
        }
      } else {
        processed.push(suggestion);
      }
    }
  }

  if (!hasRuleUpdate) {
    const pattern = getActionPattern(toolName, input);
    if (decision === 'allow-always' && !isNonEmptyDerivedScope(pattern)) {
      return [];
    }
    const ruleValue: { toolName: string; ruleContent?: string } = { toolName };
    if (pattern && !pattern.startsWith('{')) {
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

function hasNonEmptyRuleScope(rule: { toolName?: string; ruleContent?: string }): boolean {
  return typeof rule.toolName === 'string'
    && rule.toolName.trim().length > 0
    && typeof rule.ruleContent === 'string'
    && rule.ruleContent.trim().length > 0;
}

function isNonEmptyDerivedScope(pattern: string | null): pattern is string {
  if (typeof pattern !== 'string') {
    return false;
  }

  const scope = pattern.trim();
  return scope.length > 0 && !scope.startsWith('{');
}
