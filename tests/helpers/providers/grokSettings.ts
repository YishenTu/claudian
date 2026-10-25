import { getProviderConfig, getProviderSelectionInputs, setProviderConfig } from '@/core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import { type GrokCatalogSnapshot, updateCurrentGrokCatalogConfig } from '@/providers/grok/config';
import { computeGrokRuntimeInputHash } from '@/providers/grok/runtime/GrokRuntimeEnvironment';
import { getGrokProviderSettings } from '@/providers/grok/settings';

/** Reads the current host's Grok catalog from a settings document. */
export function readGrokCatalog(settings: Record<string, unknown>): GrokCatalogSnapshot | null {
  return getGrokProviderSettings(settings).currentCatalog;
}

/** Writes the current host's Grok catalog into a settings document. */
export function writeGrokCatalog(
  settings: Record<string, unknown>,
  snapshot: GrokCatalogSnapshot,
): GrokCatalogSnapshot | null {
  const config = getProviderConfig(settings, 'grok');
  const normalized = updateCurrentGrokCatalogConfig(config, getProviderSelectionInputs(settings, 'grok'), snapshot);
  if (normalized) setProviderConfig(settings, 'grok', config);
  return normalized;
}

/** Computes the Grok runtime-input hash a settings document currently implies. */
export function grokEnvironmentHash(settings: Record<string, unknown>): string {
  return computeGrokRuntimeInputHash(getGrokProviderSettings(settings), getRuntimeEnvironmentText(settings, 'grok'));
}
