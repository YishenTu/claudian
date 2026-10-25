import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import {
  decodeGrokModelId,
  encodeGrokModelId,
} from '../models';
import { computeGrokRuntimeInputHash } from '../runtime/GrokRuntimeEnvironment';
import {
  getGrokProviderSettings,
  updateGrokProviderSettings
} from '../settings';

function computeGrokEnvironmentHash(settings: Record<string, unknown>): string {
  return computeGrokRuntimeInputHash(
    getGrokProviderSettings(settings),
    getRuntimeEnvironmentText(settings, 'grok'),
  );
}

export const grokSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: () => [],

  reconcileModelWithEnvironment(settings) {
    if (!getGrokProviderSettings(settings).enabled) {
      return { changed: false };
    }

    const environmentHash = computeGrokEnvironmentHash(settings);
    if (getGrokProviderSettings(settings).environmentHash === environmentHash) {
      return { changed: false };
    }

    updateGrokProviderSettings(settings, { environmentHash });
    // Grok sessions resume across environment changes.
    return { changed: true, sessionPolicy: 'reload' };
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
