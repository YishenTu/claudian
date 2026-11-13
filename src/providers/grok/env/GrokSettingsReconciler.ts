import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';

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

export const grokSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(settings, context) {
    if (!getGrokProviderSettings(settings).enabled) {
      return { changed: false };
    }

    const current = getGrokProviderSettings(settings);
    const target = resolveExecutionTarget({ settings: current, hostVaultPath: context?.vaultPath });
    const environmentText = getRuntimeEnvironmentText(settings, 'grok');
    const environmentHash = computeGrokRuntimeInputHash(current, environmentText, target);
    if (current.environmentHash === environmentHash) return { changed: false };
    updateGrokProviderSettings(settings, { environmentHash });
    return { changed: true };
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
