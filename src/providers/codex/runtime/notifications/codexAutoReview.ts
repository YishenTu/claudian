import { pathToFileURL } from 'url';

import { t } from '@/i18n/i18n';

import type { GuardianReviewAction, GuardianReviewCompleted, GuardianReviewStarted } from '../codexAppServerTypes';

export function describeReviewAction(action: GuardianReviewAction): string {
  switch (action.type) {
    case 'command': return `${action.command} (${action.cwd})`;
    case 'execve': return `${action.program} ${JSON.stringify(action.argv)} (${action.cwd})`;
    case 'writeStdin': return t('chat.approval.review.terminalInput', { process: action.processId, input: JSON.stringify(action.stdin) });
    case 'applyPatch': return `${t('chat.approval.fileChange')} (${action.cwd}): ${action.files.join(', ')}`;
    case 'networkAccess': return `${action.protocol} ${action.target} (${action.host}:${action.port})`;
    case 'mcpToolCall': return `${action.server}/${action.toolName}`;
    case 'requestPermissions': return [action.reason, JSON.stringify(action.permissions)].filter(Boolean).join(' · ');
  }
}

export function describeAutoReview(event: GuardianReviewStarted, canOverride: boolean): string {
  const subject = describeReviewAction(event.action);
  const longestRun = (subject.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const status = t(`chat.approval.review.${event.review.status}`, { action: `${fence} ${subject} ${fence}` });
  return [status, event.review.rationale, canOverride && t('chat.approval.review.retryHint')].filter(Boolean).join('\n\n');
}

// thread/approveGuardianDeniedAction takes a serialized core GuardianAssessmentEvent.
// Its enum tags, permission profile and stdin cwd differ from the v2 notification.
function coreReviewAction(action: GuardianReviewAction) {
  switch (action.type) {
    case 'command':
    case 'execve':
      return { ...action, source: action.source === 'unifiedExec' ? 'unified_exec' : action.source };
    case 'writeStdin': {
      const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(action.cwd);
      return {
        type: 'write_stdin', approval_id: action.approvalId, process_id: action.processId, stdin: action.stdin,
        cwd: pathToFileURL(action.cwd, { windows }).href,
      };
    }
    case 'applyPatch': return { ...action, type: 'apply_patch' };
    case 'networkAccess': return {
      ...action, type: 'network_access',
      protocol: action.protocol === 'socks5Tcp' ? 'socks5_tcp' : action.protocol === 'socks5Udp' ? 'socks5_udp' : action.protocol,
    };
    case 'mcpToolCall': return {
      type: 'mcp_tool_call', server: action.server, tool_name: action.toolName,
      connector_id: action.connectorId, connector_name: action.connectorName, tool_title: action.toolTitle,
    };
    case 'requestPermissions': {
      const fs = action.permissions.fileSystem;
      const fileSystem = fs && {
        entries: fs.entries ?? [
          ...(fs.read ?? []).map(path => ({ path: { type: 'path', path }, access: 'read' })),
          ...(fs.write ?? []).map(path => ({ path: { type: 'path', path }, access: 'write' })),
        ],
        glob_scan_max_depth: fs.globScanMaxDepth,
      };
      return { type: 'request_permissions', reason: action.reason, permissions: { file_system: fileSystem, network: action.permissions.network } };
    }
  }
}

export function guardianOverrideParams(event: GuardianReviewCompleted) {
  return {
    threadId: event.threadId,
    event: {
      id: event.reviewId, turn_id: event.turnId, started_at_ms: event.startedAtMs, completed_at_ms: event.completedAtMs,
      status: event.review.status, risk_level: event.review.riskLevel, user_authorization: event.review.userAuthorization,
      rationale: event.review.rationale, decision_source: event.decisionSource, action: coreReviewAction(event.action),
    },
  };
}
