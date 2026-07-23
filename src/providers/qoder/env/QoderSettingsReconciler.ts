import { createHash } from 'node:crypto';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { decodeQoderModelId, encodeQoderModelId } from '../models';
import { getQoderProviderSettings, updateQoderProviderSettings } from '../settings';

export function computeQoderEnvironmentHash(settings: Record<string, unknown>): string {
  const providerSettings = getQoderProviderSettings(settings);
  const currentHostPath = providerSettings.cliPathsByHost[getHostnameKey()] ?? '';
  const cliPath = currentHostPath.trim() || providerSettings.cliPath.trim();
  const environment = Object.entries(parseEnvironmentVariables(
    getRuntimeEnvironmentText(settings, 'qoder'),
  )).sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify({ cliPath, environment }), 'utf8')
    .digest('hex');
}

export const qoderSettingsReconciler: ProviderSettingsReconciler = {
  environmentSessionPolicy: 'reload',

  invalidateConversationSessions: () => [],

  reconcileModelWithEnvironment(settings) {
    if (!getQoderProviderSettings(settings).enabled) {
      return { changed: false, invalidatedConversations: [] };
    }

    const environmentHash = computeQoderEnvironmentHash(settings);
    if (getQoderProviderSettings(settings).environmentHash === environmentHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    updateQoderProviderSettings(settings, {
      discoveredModels: [],
      environmentHash,
      visibleModels: [],
    });
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
        'qoder',
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

  const rawModelId = decodeQoderModelId(current.trim());
  if (!rawModelId) {
    return false;
  }

  const normalized = encodeQoderModelId(rawModelId);
  if (normalized === current) {
    return false;
  }
  settings[key] = normalized;
  return true;
}
