import type { Conversation } from '../types';
import { ProviderRegistry } from './ProviderRegistry';
import type { ProviderId } from './types';

export interface SettingsReconciliationResult {
  changed: boolean;
  invalidatedConversations: Conversation[];
}

const PROJECTION_KEYS = new Set([
  'model',
  'effortLevel',
  'thinkingBudget',
]);

type ProviderProjectionMap = Partial<Record<string, string>>;

function getActiveProviderId(settings: Record<string, unknown>): ProviderId {
  return settings.activeProvider === 'codex' && settings.codexEnabled !== false
    ? 'codex'
    : 'claude';
}

function ensureProjectionMap(
  settings: Record<string, unknown>,
  key: 'savedProviderModel' | 'savedProviderEffort' | 'savedProviderThinkingBudget',
): ProviderProjectionMap {
  const current = settings[key];
  if (current && typeof current === 'object') {
    return current as ProviderProjectionMap;
  }

  const next: ProviderProjectionMap = {};
  settings[key] = next;
  return next;
}

function cloneProviderSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    ...settings,
    savedProviderModel: { ...(settings.savedProviderModel as ProviderProjectionMap | undefined) },
    savedProviderEffort: { ...(settings.savedProviderEffort as ProviderProjectionMap | undefined) },
    savedProviderThinkingBudget: { ...(settings.savedProviderThinkingBudget as ProviderProjectionMap | undefined) },
  };
}

function mergeProviderSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (PROJECTION_KEYS.has(key)) {
      continue;
    }
    target[key] = value;
  }
}

export class ProviderSettingsCoordinator {
  static normalizeProviderSelection(settings: Record<string, unknown>): boolean {
    const activeProvider = settings.activeProvider;
    const nextProvider = activeProvider === 'codex' && settings.codexEnabled !== false
      ? 'codex'
      : 'claude';

    if (settings.activeProvider === nextProvider) {
      return false;
    }

    settings.activeProvider = nextProvider;
    return true;
  }

  static getProviderSettingsSnapshot<T extends Record<string, unknown>>(
    settings: T,
    providerId: ProviderId,
  ): T {
    const snapshot = cloneProviderSettings(settings) as T;
    this.projectProviderState(snapshot, providerId);
    return snapshot;
  }

  static commitProviderSettingsSnapshot(
    settings: Record<string, unknown>,
    providerId: ProviderId,
    snapshot: Record<string, unknown>,
  ): void {
    this.persistProjectedProviderState(snapshot, providerId);

    if (providerId === getActiveProviderId(settings)) {
      Object.assign(settings, snapshot);
      return;
    }

    mergeProviderSettings(settings, snapshot);
  }

  static persistProjectedProviderState(
    settings: Record<string, unknown>,
    providerId: ProviderId = getActiveProviderId(settings),
  ): void {
    const savedModel = ensureProjectionMap(settings, 'savedProviderModel');
    const savedEffort = ensureProjectionMap(settings, 'savedProviderEffort');
    const savedBudget = ensureProjectionMap(settings, 'savedProviderThinkingBudget');

    if (typeof settings.model === 'string') {
      savedModel[providerId] = settings.model;
    }
    if (typeof settings.effortLevel === 'string') {
      savedEffort[providerId] = settings.effortLevel;
    }
    if (typeof settings.thinkingBudget === 'string') {
      savedBudget[providerId] = settings.thinkingBudget;
    }
  }

  static projectProviderState(
    settings: Record<string, unknown>,
    providerId: ProviderId,
  ): void {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const savedModel = settings.savedProviderModel as ProviderProjectionMap | undefined;
    const savedEffort = settings.savedProviderEffort as ProviderProjectionMap | undefined;
    const savedBudget = settings.savedProviderThinkingBudget as ProviderProjectionMap | undefined;

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const currentEffort = typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined;
    const currentBudget = typeof settings.thinkingBudget === 'string' ? settings.thinkingBudget : undefined;
    const modelOptions = uiConfig.getModelOptions(settings);
    const shouldPreferCurrentProjection = providerId === getActiveProviderId(settings);
    const canReuseCurrentModel = currentModel.length > 0
      && (
        shouldPreferCurrentProjection
        || modelOptions.some(option => option.value === currentModel)
      );
    const fallbackModel = canReuseCurrentModel
      ? currentModel
      : (modelOptions[0]?.value ?? currentModel);
    const model = savedModel?.[providerId] ?? fallbackModel;
    const canReuseCurrentProjection = canReuseCurrentModel && model === currentModel;

    if (model) {
      settings.model = model;
      uiConfig.applyModelDefaults(model, settings);
    }

    if (savedEffort?.[providerId] !== undefined) {
      settings.effortLevel = savedEffort[providerId];
    } else if (canReuseCurrentProjection && currentEffort !== undefined) {
      settings.effortLevel = currentEffort;
    } else if (model && uiConfig.isAdaptiveReasoningModel(model)) {
      settings.effortLevel = uiConfig.getDefaultReasoningValue(model);
    }

    if (savedBudget?.[providerId] !== undefined) {
      settings.thinkingBudget = savedBudget[providerId];
    } else if (canReuseCurrentProjection && currentBudget !== undefined) {
      settings.thinkingBudget = currentBudget;
    } else if (model && !uiConfig.isAdaptiveReasoningModel(model)) {
      settings.thinkingBudget = uiConfig.getDefaultReasoningValue(model);
    }
  }

  /**
   * Reconcile settings for all registered providers.
   * Each provider's reconciler only processes its own conversations.
   */
  static reconcileAllProviders(
    settings: Record<string, unknown>,
    conversations: Conversation[],
    envText: string,
  ): SettingsReconciliationResult {
    let anyChanged = false;
    const allInvalidated: Conversation[] = [];
    const activeProvider = getActiveProviderId(settings);

    for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
      const reconciler = ProviderRegistry.getSettingsReconciler(providerId);
      const providerConversations = conversations.filter(c => c.providerId === providerId);
      const targetSettings = providerId === activeProvider
        ? settings
        : cloneProviderSettings(settings);

      if (providerId !== activeProvider) {
        this.projectProviderState(targetSettings, providerId);
      }

      const { changed, invalidatedConversations } = reconciler.reconcileModelWithEnvironment(
        targetSettings,
        providerConversations,
        envText,
      );

      if (changed) anyChanged = true;
      if (changed) {
        this.persistProjectedProviderState(targetSettings, providerId);
        if (providerId !== activeProvider) {
          mergeProviderSettings(settings, targetSettings);
        }
      }
      allInvalidated.push(...invalidatedConversations);
    }

    return { changed: anyChanged, invalidatedConversations: allInvalidated };
  }

  /**
   * Normalize model variants for all registered providers.
   */
  static normalizeAllModelVariants(settings: Record<string, unknown>): boolean {
    let anyChanged = false;
    const activeProvider = getActiveProviderId(settings);

    for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
      const reconciler = ProviderRegistry.getSettingsReconciler(providerId);
      const targetSettings = providerId === activeProvider
        ? settings
        : cloneProviderSettings(settings);

      if (providerId !== activeProvider) {
        this.projectProviderState(targetSettings, providerId);
      }

      const changed = reconciler.normalizeModelVariantSettings(targetSettings);
      if (changed) {
        anyChanged = true;
        this.persistProjectedProviderState(targetSettings, providerId);
        if (providerId !== activeProvider) {
          mergeProviderSettings(settings, targetSettings);
        }
      }
    }
    return anyChanged;
  }

  /**
   * Project the active provider's saved values into the top-level
   * model/effortLevel/thinkingBudget fields.
   */
  static projectActiveProviderState(settings: Record<string, unknown>): void {
    this.projectProviderState(settings, getActiveProviderId(settings));
  }
}
