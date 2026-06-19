import type {
  ApprovalCommandDisplay,
  ApprovalCommandDisplayAction,
} from '../../../core/runtime/types';
import type { CommandAction, CommandApprovalRequest } from './codexAppServerTypes';

export function buildCodexCommandApprovalDisplay(
  params: CommandApprovalRequest,
): ApprovalCommandDisplay | undefined {
  const exactCommand = params.command ?? '';
  const actions = (params.commandActions ?? [])
    .map(formatCommandAction)
    .filter((action): action is ApprovalCommandDisplayAction => action !== null);

  if (!exactCommand && actions.length === 0) {
    return undefined;
  }

  return { actions, exactCommand };
}

function formatCommandAction(action: CommandAction): ApprovalCommandDisplayAction | null {
  if (!action.command) {
    return null;
  }

  switch (action.type) {
    case 'read':
      return {
        label: action.name ? `Read ${action.name}` : 'Read file',
        command: action.command,
      };
    case 'listFiles':
      return {
        label: action.path ? `List files in ${action.path}` : 'List files',
        command: action.command,
      };
    case 'search':
      return {
        label: formatSearchLabel(action.query, action.path),
        command: action.command,
      };
    case 'unknown':
      return {
        label: 'Command',
        command: action.command,
      };
  }
}

function formatSearchLabel(query: string | null, path: string | null): string {
  if (query && path) {
    return `Search for ${query} in ${path}`;
  }
  if (query) {
    return `Search for ${query}`;
  }
  if (path) {
    return `Search in ${path}`;
  }
  return 'Search';
}
