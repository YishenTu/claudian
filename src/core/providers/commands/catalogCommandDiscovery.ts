import type { SlashCommand } from '../../types';
import type { ProviderHost } from '../ProviderHost';
import { ProviderRegistry } from '../ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../ProviderWorkspaceRegistry';
import type { ProviderCommandLoaderContext, ProviderId } from '../types';
import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from './ProviderCommandCatalog';
import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from './ProviderCommandDiscoveryResult';
import { ProviderCommandDiscoveryStore } from './ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from './ProviderCommandEntry';

/** Maps a catalog deadline onto the discovery store: undefined is shared, null is provider-owned. */
export function resolveCommandDiscoveryTimeoutMs(
  config: ProviderCommandDropdownConfig,
): number | null | undefined {
  return config.discoveryTimeoutMs === 'provider-owned'
    ? null
    : config.discoveryTimeoutMs;
}

/** Discovery for surfaces without a chat session: the catalog lists what `discover` reported, as in chat. */
export function createCatalogCommandDiscoveryStore(
  catalog: ProviderCommandCatalog,
  discover: (signal: AbortSignal) => Promise<ProviderCommandLoaderDiscovery>,
): ProviderCommandDiscoveryStore<ProviderCommandEntry> {
  return new ProviderCommandDiscoveryStore(
    async signal => listDiscoveredCommandEntries(catalog, await discover(signal), signal),
    { resolveTimeoutMs: () => resolveCommandDiscoveryTimeoutMs(catalog.getDropdownConfig()) },
  );
}

/** What a session snapshot or command loader reported before catalog projection. */
export interface ProviderCommandLoaderDiscovery {
  readonly result: ProviderCommandDiscoveryResult<SlashCommand>;
  /** Defined when a live session or loader answered; the catalog then lists exactly these commands. */
  readonly commandSnapshot?: readonly SlashCommand[];
}

/** Projects loader discovery through the provider catalog, without Claudian built-ins, for every picker surface. */
export async function listDiscoveredCommandEntries(
  catalog: ProviderCommandCatalog,
  discovery: ProviderCommandLoaderDiscovery,
  signal?: AbortSignal,
): Promise<ProviderCommandDiscoveryResult<ProviderCommandEntry>> {
  const { result, commandSnapshot } = discovery;
  if (result.status === 'error' || result.status === 'requires-session') return result;
  return normalizeProviderCommandDiscoveryItems(await catalog.listDropdownEntries({
    includeBuiltIns: false,
    ...(signal ? { signal } : {}),
    ...(commandSnapshot !== undefined ? { commandSnapshot } : {}),
  }));
}

/** A loader's settled answer is the whole list; failures and session requirements carry no snapshot. */
export function toLoaderDiscovery(result: ProviderCommandDiscoveryResult<SlashCommand>): ProviderCommandLoaderDiscovery {
  return result.status === 'ready' || result.status === 'empty'
    ? { result, commandSnapshot: result.status === 'ready' ? result.items : [] }
    : { result };
}

export function isProviderCommandLoaderAvailable(providerId: ProviderId, settings: Record<string, unknown>): boolean {
  return ProviderWorkspaceRegistry.getCommandLoader(providerId)?.isAvailable(settings) ?? false;
}

/** Runs the provider's command loader when it is available; an unavailable loader reports no commands. */
export async function loadProviderCommands(
  providerId: ProviderId,
  context: ProviderCommandLoaderContext,
): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
  if (!isProviderCommandLoaderAvailable(providerId, context.plugin.settings)) return { status: 'empty' };
  return ProviderWorkspaceRegistry.getCommandLoader(providerId)!.loadCommands(context);
}

/** Inline Edit's picker discovery: what the active blank chat tab would discover, isolated probes included. */
export function discoverSessionlessCommands(
  host: ProviderHost,
  providerId: ProviderId,
): (signal: AbortSignal) => Promise<ProviderCommandLoaderDiscovery> {
  return async signal => {
    if (!ProviderRegistry.getCapabilities(providerId).supportsProviderCommands) return { result: { status: 'empty' } };
    if (!ProviderWorkspaceRegistry.getCommandLoader(providerId)) return { result: { status: 'empty' } };
    return toLoaderDiscovery(await loadProviderCommands(providerId, {
      allowIsolatedMetadataCreation: true, conversation: null, plugin: host, signal,
    }));
  };
}
