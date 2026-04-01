import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderId, ProviderSubagentLifecycleAdapter } from '../../../core/providers/types';

/**
 * Resolves the lifecycle adapter owned by the active provider.
 */
export function resolveSubagentLifecycleAdapter(
  activeProviderId: ProviderId,
  toolName?: string,
): ProviderSubagentLifecycleAdapter | null {
  const activeAdapter = ProviderRegistry.getSubagentLifecycleAdapter(activeProviderId);

  if (!toolName) {
    return activeAdapter;
  }

  return activeAdapter && adapterOwnsTool(activeAdapter, toolName) ? activeAdapter : null;
}

function adapterOwnsTool(adapter: ProviderSubagentLifecycleAdapter, toolName: string): boolean {
  return adapter.isSpawnTool(toolName)
    || adapter.isHiddenTool(toolName)
    || adapter.isWaitTool(toolName)
    || adapter.isCloseTool(toolName);
}
