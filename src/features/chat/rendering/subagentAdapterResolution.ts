import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderId, ProviderSubagentAdapter } from '../../../core/providers/types';

/** Resolves the subagent protocol adapter owned by the active provider. */
export function resolveSubagentAdapter(
  activeProviderId: ProviderId,
  toolName?: string,
): ProviderSubagentAdapter | null {
  const activeAdapter = ProviderRegistry.getSubagentAdapter(activeProviderId);
  if (!activeAdapter || !toolName) return activeAdapter;
  return adapterOwnsTool(activeAdapter, toolName) ? activeAdapter : null;
}

function adapterOwnsTool(adapter: ProviderSubagentAdapter, toolName: string): boolean {
  if (adapter.protocol === 'managed-agent') {
    return adapter.isSpawnTool(toolName) || adapter.isOutputTool(toolName);
  }

  return adapter.isSpawnTool(toolName)
    || adapter.isHiddenTool(toolName)
    || adapter.isWaitTool(toolName)
    || adapter.isCloseTool(toolName);
}
