import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import { getClaudeModelCatalog, hasClaudeModelIdentity, resolveClaudeVisibleModels } from '../modelOptions';
import { type ClaudeDiscoveredModel, decodeClaudeModels } from '../models';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { type ClaudeRuntimeCatalog, probeClaudeCatalog } from './probeClaudeModels';

export type ClaudeCatalogProbe = (host: ProviderHost, signal: AbortSignal) => Promise<ClaudeRuntimeCatalog>;
export type ClaudeModelDiscovery = (signal: AbortSignal) => Promise<ProviderModelCatalogRefreshResult>;

/** Replaces the discovered catalog and moves enabled identities (and their aliases) onto reported rows. */
function applyDiscoveredClaudeModels(settings: Record<string, unknown>, models: ClaudeDiscoveredModel[]): void {
  const config = getClaudeProviderSettings(settings);
  updateClaudeProviderSettings(settings, { discoveredModels: models });
  const catalog = getClaudeModelCatalog(settings);
  const modelAliases = { ...config.modelAliases };
  const visibleModels = [...new Set(resolveClaudeVisibleModels(settings, catalog).map(({ id, option }) => {
    // Legacy seeds canonicalize to SDK values. Saved choices keep any identity the SDK
    // still reports; only retired ones follow their family successor.
    if (config.visibleModels !== null && hasClaudeModelIdentity(catalog, id)) return id;
    const nextId = option ? toClaudeRuntimeModelId(option.value) : id;
    if (nextId !== id && modelAliases[id]) {
      modelAliases[nextId] ??= modelAliases[id];
      delete modelAliases[id];
    }
    return nextId;
  }))];
  updateClaudeProviderSettings(settings, { visibleModels, modelAliases });
}

/** Output styles only replace the stored list when Claude Code reported some. */
function applyDiscoveredClaudeCatalog(settings: Record<string, unknown>, catalog: ClaudeRuntimeCatalog): void {
  applyDiscoveredClaudeModels(settings, catalog.models);
  if (catalog.outputStyles.length > 0) {
    updateClaudeProviderSettings(settings, { discoveredOutputStyles: catalog.outputStyles });
  }
}

/**
 * Probes Claude Code and writes the reported catalog back. Concurrency and supersession belong to
 * the common catalog controller; an aborted or disabled discovery never writes or publishes.
 */
export async function discoverClaudeModels(
  host: ProviderHost,
  signal: AbortSignal,
  probe: ClaudeCatalogProbe = probeClaudeCatalog,
): Promise<ProviderModelCatalogRefreshResult> {
  const current = (settings: Record<string, unknown> = host.settings): boolean => (
    !signal.aborted && getClaudeProviderSettings(settings).enabled
  );
  let catalog: ClaudeRuntimeCatalog;
  try {
    catalog = await probe(host, signal);
  } catch (error) {
    if (!current()) return { changed: false };
    throw error;
  }
  await host.mutateSettingsConditionally(settings => {
    if (!current(settings)) return false;
    applyDiscoveredClaudeCatalog(settings, catalog);
    return true;
  });
  if (!current()) return { changed: false };
  host.notifyProviderChatOptionsChanged('claude');
  return { changed: true, persistedSettingsChanged: true };
}

/**
 * Writes the catalog a live session reported. Unlike discovery, a report equal to the stored
 * catalog is not written, so starting a session does not rewrite persisted settings.
 * An empty model or style list leaves the stored one in place.
 */
export async function applySessionClaudeCatalog(
  host: ProviderHost,
  catalog: ClaudeRuntimeCatalog,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const models = decodeClaudeModels(catalog.models);
  const serializedModels = JSON.stringify(models);
  const serializedStyles = JSON.stringify(catalog.outputStyles);
  const needsWrite = (settings: Record<string, unknown>): boolean => {
    const config = getClaudeProviderSettings(settings);
    if (!isCurrent() || !config.enabled) return false;
    return (models.length > 0 && JSON.stringify(config.discoveredModels) !== serializedModels)
      || (catalog.outputStyles.length > 0 && JSON.stringify(config.discoveredOutputStyles) !== serializedStyles);
  };
  if (!needsWrite(host.settings)) return false;
  let written = false;
  await host.mutateSettingsConditionally(settings => {
    if (!needsWrite(settings)) return false;
    if (models.length > 0) applyDiscoveredClaudeModels(settings, models);
    if (catalog.outputStyles.length > 0) {
      updateClaudeProviderSettings(settings, { discoveredOutputStyles: catalog.outputStyles });
    }
    written = true;
    return true;
  });
  if (written && isCurrent()) host.notifyProviderChatOptionsChanged('claude');
  return written;
}

export function createClaudeModels(
  host: ProviderHost,
  discover: ClaudeModelDiscovery = signal => discoverClaudeModels(host, signal),
): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'claude',
    host,
    update: updateClaudeProviderSettings,
    providerName: 'Claude Code',
    read: (settings = host.settings) => {
      const current = getClaudeProviderSettings(settings);
      const models = getClaudeModelCatalog(settings);
      return {
        enabled: current.enabled,
        models: models.map(model => ({
          id: toClaudeRuntimeModelId(model.value), name: model.label, description: model.description,
        })),
        selectedIds: resolveClaudeVisibleModels(settings, models).map(({ id, option }) =>
          toClaudeRuntimeModelId(option?.value ?? id)),
        aliases: current.modelAliases,
      };
    },
    discover,
  });
}
