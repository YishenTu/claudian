import { createHash } from 'crypto';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { decodeKimiModelId, encodeKimiModelId } from '../models';
import {
  getKimiProviderSettings,
  type KimiProviderConfig,
  updateKimiProviderSettings,
} from '../settings';

export const KIMI_ENVIRONMENT_KEY_PATTERNS: RegExp[] = [/^KIMI_/i];

export function computeKimiEnvironmentHash(
  settings: Record<string, unknown>,
  providerSettings: KimiProviderConfig = getKimiProviderSettings(settings),
): string {
  const currentHostPath = providerSettings.cliPathsByHost[getHostnameKey()] ?? '';
  const cliPath = currentHostPath.trim() || providerSettings.cliPath.trim();
  const environment = Object.entries(parseEnvironmentVariables(
    getRuntimeEnvironmentText(settings, 'kimi'),
  )).sort(([left], [right]) => left.localeCompare(right));
  const constructionInputs = JSON.stringify({ cliPath, environment });

  return createHash('sha256').update(constructionInputs, 'utf8').digest('hex');
}

// Env projection only: kimi owns ~/.kimi-code/config.toml, so reconciliation never writes it.
export const kimiSettingsReconciler: ProviderSettingsReconciler = {
  environmentSessionPolicy: 'reload',

  invalidateConversationSessions: () => [],

  reconcileModelWithEnvironment(settings) {
    const providerSettings = getKimiProviderSettings(settings);
    if (!providerSettings.enabled) {
      return { changed: false, invalidatedConversations: [] };
    }

    const environmentHash = computeKimiEnvironmentHash(settings, providerSettings);
    if (providerSettings.environmentHash === environmentHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    updateKimiProviderSettings(settings, { environmentHash });
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
        'kimi',
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
  const rawModelId = decodeKimiModelId(trimmed);
  if (rawModelId) {
    normalized = encodeKimiModelId(rawModelId);
  }

  if (normalized === null || normalized === current) {
    return false;
  }
  settings[key] = normalized;
  return true;
}
