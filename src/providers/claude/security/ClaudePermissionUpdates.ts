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
        hasRuleUpdate = true;
        processed.push({ ...suggestion, behavior: 'allow', destination });
      } else {
        processed.push(suggestion);
      }
    }
  }

  if (!hasRuleUpdate) {
    const pattern = getActionPattern(toolName, input);
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
