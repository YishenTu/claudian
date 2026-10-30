import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import {
  decodeGrokModelId,
  encodeGrokModelId,
} from '../models';
import { computeGrokRuntimeInputHash, computeGrokSessionEnvironmentHash } from '../runtime/GrokRuntimeEnvironment';
import {
  getGrokProviderSettings,
  updateGrokProviderSettings
} from '../settings';
import { clearGrokResumeState } from '../types';

export const grokSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: conversations => conversations.filter(conversation => (
    conversation.providerId === 'grok' && clearGrokResumeState(conversation)
  )),

  reconcileModelWithEnvironment(settings, context) {
    if (!getGrokProviderSettings(settings).enabled) {
      return { changed: false };
    }

    const current = getGrokProviderSettings(settings);
    const target = resolveExecutionTarget({ settings: current, hostVaultPath: context?.vaultPath });
    const environmentText = getRuntimeEnvironmentText(settings, 'grok');
    const environmentHash = computeGrokRuntimeInputHash(current, environmentText, target);
    const sessionEnvironmentHash = computeGrokSessionEnvironmentHash(environmentText, target);
    if (current.environmentHash === environmentHash && current.sessionEnvironmentHash === sessionEnvironmentHash) {
      return { changed: false };
    }
    // Existing native installations predate the scoped store fingerprint. Backfill
    // without discarding their sessions. WSL is new and cannot resume that store.
    const invalidate = current.sessionEnvironmentHash
      ? current.sessionEnvironmentHash !== sessionEnvironmentHash
      : target.method === 'wsl';
    updateGrokProviderSettings(settings, { environmentHash, sessionEnvironmentHash });
    return { changed: true, sessionPolicy: invalidate ? 'invalidate' : 'reload' };
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
