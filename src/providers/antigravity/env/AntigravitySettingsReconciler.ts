import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import { decodeAntigravityModelId, encodeAntigravityModelId } from '../models';
import {
  computeAntigravityRuntimeInputHash,
  computeAntigravitySessionStoreHash,
} from '../runtime/AntigravityRuntimeEnvironment';
import {
  ANTIGRAVITY_PROVIDER_ID,
  getAntigravityProviderSettings,
  updateAntigravityProviderSettings,
} from '../settings';
import { clearAntigravityResumeState } from '../types';

export const antigravitySettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: conversations => conversations.filter(conversation => (
    conversation.providerId === ANTIGRAVITY_PROVIDER_ID && clearAntigravityResumeState(conversation)
  )),

  reconcileModelWithEnvironment(settings) {
    const current = getAntigravityProviderSettings(settings);
    if (!current.enabled) return { changed: false };
    const environmentText = getRuntimeEnvironmentText(settings, ANTIGRAVITY_PROVIDER_ID);
    const environmentHash = computeAntigravityRuntimeInputHash(current, environmentText);
    const sessionStoreHash = computeAntigravitySessionStoreHash(environmentText);
    if (current.environmentHash === environmentHash && current.sessionStoreHash === sessionStoreHash) {
      return { changed: false };
    }
    // A first fingerprint is a backfill; only a moved store (HOME/USERPROFILE) strands bindings.
    const storeMoved = current.sessionStoreHash !== '' && current.sessionStoreHash !== sessionStoreHash;
    updateAntigravityProviderSettings(settings, { environmentHash, sessionStoreHash });
    return { changed: true, sessionPolicy: storeMoved ? 'invalidate' : 'reload' };
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
