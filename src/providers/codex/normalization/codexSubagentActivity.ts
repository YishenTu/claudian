import type { SubagentInfo } from '../../../core/types';
import type { SubAgentActivityItem } from '../runtime/codexAppServerTypes';

export function normalizeCodexSubagentActivity(value: unknown): SubAgentActivityItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.type !== 'SubAgentActivity' && item.type !== 'subAgentActivity') return undefined;
  const agentThreadId = item.agentThreadId ?? item.agent_thread_id;
  const agentPath = item.agentPath ?? item.agent_path;
  if (typeof item.id !== 'string' || typeof agentThreadId !== 'string' || typeof agentPath !== 'string'
    || !['started', 'interacted', 'interrupted', 'completed'].includes(String(item.kind))) return undefined;
  return { type: 'subAgentActivity', id: item.id, agentThreadId, agentPath, kind: item.kind as SubAgentActivityItem['kind'] };
}

export function applyCodexSubagentActivity(
  item: SubAgentActivityItem, previous?: SubagentInfo, timestamp?: number,
  startsWork = item.kind === 'started',
): SubagentInfo {
  if (item.kind === 'interacted' && previous && !startsWork) return previous;
  const running = startsWork;
  return {
    id: item.id, description: item.agentPath, mode: 'sync', isExpanded: false, toolCalls: [],
    ...previous,
    agentId: item.agentThreadId, lifecycleSource: 'session',
    status: running ? 'running' : item.kind === 'interrupted' || previous?.status === 'error' ? 'error' : 'completed',
    ...(running ? { result: undefined, startedAt: timestamp, completedAt: undefined } : { completedAt: timestamp }),
  };
}
