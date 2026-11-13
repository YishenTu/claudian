import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import { decodeAntigravityModelId, encodeAntigravityModelId } from '../models';
import { computeAntigravityRuntimeInputHash } from '../runtime/AntigravityRuntimeEnvironment';
import {
  ANTIGRAVITY_PROVIDER_ID,
  getAntigravityProviderSettings,
  updateAntigravityProviderSettings,
} from '../settings';

export const antigravitySettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(settings) {
    const current = getAntigravityProviderSettings(settings);
    if (!current.enabled) return { changed: false };
    const environmentText = getRuntimeEnvironmentText(settings, ANTIGRAVITY_PROVIDER_ID);
    const environmentHash = computeAntigravityRuntimeInputHash(current, environmentText);
    if (current.environmentHash === environmentHash) return { changed: false };
    updateAntigravityProviderSettings(settings, { environmentHash });
    return { changed: true };
  },

  normalizeModelVariantSettings(settings): boolean {
    let changed = normalizeSelectionAt(settings, 'model');
    changed = normalizeSelectionAt(settings, 'titleGenerationModel') || changed;
    const saved = settings.savedProviderModel;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      changed = normalizeSelectionAt(saved as Record<string, unknown>, ANTIGRAVITY_PROVIDER_ID) || changed;
    }
    return changed;
  },
};

function normalizeSelectionAt(settings: Record<string, unknown>, key: string): boolean {
  const current = settings[key];
  if (typeof current !== 'string') return false;
  const rawId = decodeAntigravityModelId(current);
  const normalized = rawId ? encodeAntigravityModelId(rawId) : null;
  if (normalized === null || normalized === current) return false;
  settings[key] = normalized;
  return true;
}
