import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderSubagentLifecycleAdapter } from '../../../core/providers/types';
import type { ProviderId } from '../../../core/providers/types';

/**
 * Resolves the lifecycle adapter for a given tool name, falling back to other
 * registered providers when the active provider's adapter doesn't own the tool.
 *
 * Shared by StreamController (live streaming) and MessageRenderer (stored replay).
 */
export function resolveSubagentLifecycleAdapter(
  activeProviderId: ProviderId,
  toolName?: string,
): ProviderSubagentLifecycleAdapter | null {
  const activeAdapter = ProviderRegistry.getSubagentLifecycleAdapter(activeProviderId);

  if (!toolName) {
    return activeAdapter;
  }

  if (activeAdapter && adapterOwnsTool(activeAdapter, toolName)) {
    return activeAdapter;
  }

  for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
    if (providerId === activeProviderId) continue;

    const adapter = ProviderRegistry.getSubagentLifecycleAdapter(providerId);
    if (adapter && adapterOwnsTool(adapter, toolName)) {
      return adapter;
    }
  }

  return null;
}

function adapterOwnsTool(adapter: ProviderSubagentLifecycleAdapter, toolName: string): boolean {
  return adapter.isSpawnTool(toolName)
    || adapter.isHiddenTool(toolName)
    || adapter.isWaitTool(toolName)
    || adapter.isCloseTool(toolName);
}
