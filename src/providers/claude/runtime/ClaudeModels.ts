import { createConfigCatalogStore, ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import { decodeClaudeConfig, updateClaudeConfig } from '../config';
import {
  type ClaudeModelSource,
  getClaudeModelCatalog,
  hasClaudeModelIdentity,
  resolveClaudeVisibleModels,
} from '../modelOptions';
import { type ClaudeDiscoveredModel, decodeClaudeModels } from '../models';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { type ClaudeRuntimeCatalog, probeClaudeCatalog } from './probeClaudeModels';

export type ClaudeCatalogProbe = (host: ProviderRuntimeHost, signal: AbortSignal) => Promise<ClaudeRuntimeCatalog>;
export type ClaudeModelDiscovery = (signal: AbortSignal) => Promise<ProviderModelCatalogRefreshResult>;

/** Model options over a configuration under edit; the environment stays the host's committed one. */
function modelSource(
  config: Readonly<Record<string, unknown>>,
  host: Pick<ProviderRuntimeHost, 'environmentText'>,
): ClaudeModelSource {
  return { config, get environmentText() { return host.environmentText; } };
}

/** Replaces the discovered catalog and moves enabled identities (and their aliases) onto reported rows. */
function applyDiscoveredClaudeModels(
  config: Record<string, unknown>,
  host: Pick<ProviderRuntimeHost, 'environmentText'>,
  models: ClaudeDiscoveredModel[],
): void {
  const current = decodeClaudeConfig(config);
  updateClaudeConfig(config, { discoveredModels: models });
  const source = modelSource(config, host);
  const catalog = getClaudeModelCatalog(source);
  const modelAliases = { ...current.modelAliases };
  const visibleModels = [...new Set(resolveClaudeVisibleModels(source, catalog).map(({ id, option }) => {
    // Legacy seeds canonicalize to SDK values. Saved choices keep any identity the SDK
    // still reports; only retired ones follow their family successor.
    if (current.visibleModels !== null && hasClaudeModelIdentity(catalog, id)) return id;
    const nextId = option ? toClaudeRuntimeModelId(option.value) : id;
    if (nextId !== id && modelAliases[id]) {
      modelAliases[nextId] ??= modelAliases[id];
      delete modelAliases[id];
    }
    return nextId;
  }))];
  updateClaudeConfig(config, { visibleModels, modelAliases });
}

/** Output styles only replace the stored list when Claude Code reported some. */
function applyDiscoveredClaudeCatalog(
  config: Record<string, unknown>,
  host: Pick<ProviderRuntimeHost, 'environmentText'>,
  catalog: ClaudeRuntimeCatalog,
): void {
  applyDiscoveredClaudeModels(config, host, catalog.models);
  if (catalog.outputStyles.length > 0) {
    updateClaudeConfig(config, { discoveredOutputStyles: catalog.outputStyles });
  }
}

/**
 * Probes Claude Code and writes the reported catalog back. Concurrency and supersession belong to
 * the common catalog controller; an aborted or disabled discovery never writes or publishes.
 */
export async function discoverClaudeModels(
  host: ProviderRuntimeHost,
  signal: AbortSignal,
  probe: ClaudeCatalogProbe = probeClaudeCatalog,
): Promise<ProviderModelCatalogRefreshResult> {
  const current = (config: Readonly<Record<string, unknown>> = host.config): boolean => (
    !signal.aborted && decodeClaudeConfig(config).enabled
  );
  let catalog: ClaudeRuntimeCatalog;
  try {
    catalog = await probe(host, signal);
  } catch (error) {
    if (!current()) return { changed: false };
    throw error;
  }
  await host.updateConfig(config => {
    if (!current(config)) return false;
    applyDiscoveredClaudeCatalog(config, host, catalog);
    return true;
  });
  if (!current()) return { changed: false };
  host.notifyChatOptionsChanged();
  return { changed: true, persistedSettingsChanged: true };
}

/**
 * Writes the catalog a live session reported. Unlike discovery, a report equal to the stored
 * catalog is not written, so starting a session does not rewrite persisted settings.
 * An empty model or style list leaves the stored one in place.
 */
export async function applySessionClaudeCatalog(
  host: ProviderRuntimeHost,
  catalog: ClaudeRuntimeCatalog,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const models = decodeClaudeModels(catalog.models);
  const serializedModels = JSON.stringify(models);
  const serializedStyles = JSON.stringify(catalog.outputStyles);
  const needsWrite = (stored: Readonly<Record<string, unknown>>): boolean => {
    const config = decodeClaudeConfig(stored);
    if (!isCurrent() || !config.enabled) return false;
    return (models.length > 0 && JSON.stringify(config.discoveredModels) !== serializedModels)
      || (catalog.outputStyles.length > 0 && JSON.stringify(config.discoveredOutputStyles) !== serializedStyles);
  };
  if (!needsWrite(host.config)) return false;
  const written = await host.updateConfig(config => {
    if (!needsWrite(config)) return false;
    if (models.length > 0) applyDiscoveredClaudeModels(config, host, models);
    if (catalog.outputStyles.length > 0) {
      updateClaudeConfig(config, { discoveredOutputStyles: catalog.outputStyles });
    }
    return true;
  });
  if (written && isCurrent()) host.notifyChatOptionsChanged();
  return written;
}

export function createClaudeModels(
  host: ProviderRuntimeHost,
  discover: ClaudeModelDiscovery = signal => discoverClaudeModels(host, signal),
): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerName: 'Claude Code',
    store: createConfigCatalogStore(host, {
      update: (config, _selection, patch) => { updateClaudeConfig(config, patch); },
      read: config => {
        const current = decodeClaudeConfig(config);
        const source = modelSource(config, host);
        const models = getClaudeModelCatalog(source);
        return {
          enabled: current.enabled,
          models: models.map(model => ({
            id: toClaudeRuntimeModelId(model.value), name: model.label, description: model.description,
          })),
          selectedIds: resolveClaudeVisibleModels(source, models).map(({ id, option }) =>
            toClaudeRuntimeModelId(option?.value ?? id)),
          aliases: current.modelAliases,
        };
      },
    }),
    discover,
  });
}
