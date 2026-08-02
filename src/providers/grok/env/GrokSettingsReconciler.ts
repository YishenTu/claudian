import { createCliPathFingerprintInputs } from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import {
  decodeGrokModelId,
  encodeGrokModelId,
} from '../models';
import {
  clearCurrentGrokCatalog,
  getGrokProviderSettings,
  updateGrokProviderSettings,
} from '../settings';

export function computeGrokEnvironmentHash(settings: Record<string, unknown>): string {
  const providerSettings = getGrokProviderSettings(settings);
  const cliPathInputs = createCliPathFingerprintInputs(
    providerSettings.cliPathsByHost[getHostnameKey()],
    providerSettings.cliPath,
  );
  const environment = Object.entries(parseEnvironmentVariables(
    getRuntimeEnvironmentText(settings, 'grok'),
  )).sort(([left], [right]) => left.localeCompare(right));
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: environment.map(([key]) => key),
    environmentText: getRuntimeEnvironmentText(settings, 'grok'),
  });
}

export const grokSettingsReconciler: ProviderSettingsReconciler = {
  environmentSessionPolicy: 'reload',

  invalidateConversationSessions: () => [],

  reconcileModelWithEnvironment(settings) {
    if (!getGrokProviderSettings(settings).enabled) {
      return { changed: false, invalidatedConversations: [] };
    }

    const environmentHash = computeGrokEnvironmentHash(settings);
    if (getGrokProviderSettings(settings).environmentHash === environmentHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    clearCurrentGrokCatalog(settings);
    updateGrokProviderSettings(settings, { environmentHash });
    return { changed: true, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(settings): boolean {
    let changed = false;
    changed = normalizeSelectionAt(settings, 'model') || changed;
    changed = normalizeSelectionAt(settings, 'titleGenerationModel') || changed;

    const savedProviderModel = settings.savedProviderModel;
    if (savedProviderModel && typeof savedProviderModel === 'object' && !Array.isArray(savedProviderModel)) {
      changed = normalizeSelectionAt(
        savedProviderModel as Record<string, unknown>,
        'grok',
      ) || changed;
    }
    return changed;
  },
};

function normalizeSelectionAt(settings: Record<string, unknown>, key: string): boolean {
  const current = settings[key];
  if (typeof current !== 'string') {
    return false;
  }

  const trimmed = current.trim();
  let normalized: string | null = null;
  const rawModelId = decodeGrokModelId(trimmed);
  if (rawModelId) {
    normalized = encodeGrokModelId(rawModelId);
  }

  if (normalized === null || normalized === current) {
    return false;
  }
  settings[key] = normalized;
  return true;
}
